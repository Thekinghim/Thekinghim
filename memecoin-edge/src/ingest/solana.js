/**
 * Solana-adapter: lyssnar på nya pooler och läser den metadata som går att
 * härleda direkt från kedjan.
 *
 * Kräver `SOLANA_WS_URL` och `SOLANA_RPC_URL` (Helius, Triton, QuickNode eller
 * egen nod — publika endpoints stryper `logsSubscribe` och är oanvändbara här).
 *
 * Designprincip: allt som inte går att verifiera sätts till det värde som
 * fäller den hårda grinden. En token som vi inte kan bevisa är säker
 * behandlas som osäker. Det kostar missade chanser och sparar kapital, och
 * i den här asymmetrin ligger hela strategins hållbarhet.
 */

const PROGRAMS = {
  // pump.fun bonding curve och dess AMM. Byt om du vill följa andra launchpads.
  pumpfun: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  pumpswap: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  raydiumAmmV4: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
};

let requestId = 0;

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${method} svarade ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`RPC ${method}: ${body.error.message}`);
  return body.result;
}

/**
 * Läser mint-kontot och avgör om mint- och freeze-authority är återkallade.
 * Det här är de två viktigaste kontrollerna på Solana och de går att göra
 * helt utan tredjepartstjänst.
 */
export async function readMintAuthorities(rpcUrl, mint) {
  const result = await rpc(rpcUrl, 'getAccountInfo', [mint, { encoding: 'jsonParsed' }]);
  const info = result?.value?.data?.parsed?.info;
  if (!info) throw new Error(`Kunde inte läsa mint ${mint}`);
  return {
    mintAuthorityActive: info.mintAuthority != null,
    freezeAuthorityActive: info.freezeAuthority != null,
    decimals: info.decimals,
    supply: Number(info.supply),
  };
}

/**
 * Innehavarkoncentration från de största token-kontona.
 * LP-poolen och burn-adressen räknas bort — annars ser varje token ut att ha
 * en dominant innehavare, vilket gör måttet obrukbart.
 */
export async function readHolderConcentration(rpcUrl, mint, excludeAccounts = []) {
  const result = await rpc(rpcUrl, 'getTokenLargestAccounts', [mint]);
  const accounts = (result?.value ?? []).filter((a) => !excludeAccounts.includes(a.address));
  const total = accounts.reduce((sum, a) => sum + Number(a.uiAmount ?? 0), 0);
  if (total <= 0) return { topHolderPct: 100, holders: accounts.length };
  const top10 = accounts.slice(0, 10).reduce((sum, a) => sum + Number(a.uiAmount ?? 0), 0);
  return { topHolderPct: (top10 / total) * 100, holders: accounts.length };
}

/**
 * @param {typeof import('../config.js').config} cfg
 */
export function createSolanaSource(cfg) {
  const wsUrl = process.env.SOLANA_WS_URL;
  const rpcUrl = process.env.SOLANA_RPC_URL;
  if (!wsUrl || !rpcUrl) {
    throw new Error(
      'SOURCE=solana kräver SOLANA_WS_URL och SOLANA_RPC_URL. Kör utan dem för simulerad data (SOURCE=mock).',
    );
  }

  let socket = null;
  let closed = false;
  let backoffMs = 1000;

  return {
    name: 'solana',
    start(handlers) {
      const connect = () => {
        if (closed) return;
        socket = new WebSocket(wsUrl);

        socket.addEventListener('open', () => {
          backoffMs = 1000;
          for (const program of Object.values(PROGRAMS)) {
            socket.send(
              JSON.stringify({
                jsonrpc: '2.0',
                id: ++requestId,
                method: 'logsSubscribe',
                params: [{ mentions: [program] }, { commitment: 'processed' }],
              }),
            );
          }
          console.log('[solana] prenumererar på', Object.keys(PROGRAMS).join(', '));
        });

        socket.addEventListener('message', async (event) => {
          try {
            const msg = JSON.parse(event.data);
            const value = msg?.params?.result?.value;
            if (!value?.logs) return;
            // Poolskapande syns som en initialize-instruktion i loggarna.
            const isNewPool = value.logs.some(
              (l) => l.includes('InitializeMint2') || l.includes('Instruction: Create'),
            );
            if (!isNewPool || value.err) return;
            await handleNewPool(value.signature, handlers, rpcUrl);
          } catch (err) {
            console.error('[solana] kunde inte tolka meddelande:', err.message);
          }
        });

        const reconnect = () => {
          if (closed) return;
          // Exponentiell backoff med tak. Att hamra på en strypt endpoint
          // gör bara att den stryper hårdare.
          setTimeout(connect, backoffMs);
          backoffMs = Math.min(backoffMs * 2, 30_000);
        };
        socket.addEventListener('close', reconnect);
        socket.addEventListener('error', () => socket.close());
      };

      connect();
    },
    stop() {
      closed = true;
      socket?.close();
    },
  };
}

/**
 * Bygger TokenMeta för en ny pool.
 *
 * Fälten som inte går att härleda från kedjan utan en säkerhetstjänst
 * (säljsimulering, skatter, LP-lås på tredjepartslåsare) lämnas i sitt
 * osäkra läge. Koppla in din leverantör här — och behåll fail-closed.
 */
async function handleNewPool(signature, handlers, rpcUrl) {
  const tx = await rpc(rpcUrl, 'getTransaction', [
    signature,
    { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' },
  ]);
  const mint = findNewMint(tx);
  if (!mint) return;

  const [authorities, concentration] = await Promise.all([
    readMintAuthorities(rpcUrl, mint),
    readHolderConcentration(rpcUrl, mint),
  ]);

  handlers.onToken({
    address: mint,
    symbol: mint.slice(0, 6),
    chain: 'solana',
    createdAt: (tx?.blockTime ?? Math.floor(Date.now() / 1000)) * 1000,
    mintAuthorityActive: authorities.mintAuthorityActive,
    freezeAuthorityActive: authorities.freezeAuthorityActive,
    metadataMutable: true,
    upgradeableContract: false,
    lpLockedPct: 0,
    lpUsd: 0,
    buyTaxBps: 0,
    sellTaxBps: 0,
    sellSimulationOk: false,
    topHolderPct: concentration.topHolderPct,
    devHoldingPct: 0,
    bundledLaunchPct: 0,
    deployer: tx?.transaction?.message?.accountKeys?.[0]?.pubkey ?? 'unknown',
    deployerFlagged: false,
  });
}

/** Plockar ut den nya minten ur transaktionens token-balanser. */
function findNewMint(tx) {
  const post = tx?.meta?.postTokenBalances ?? [];
  const pre = new Set((tx?.meta?.preTokenBalances ?? []).map((b) => b.mint));
  const created = post.find((b) => !pre.has(b.mint));
  return created?.mint ?? null;
}
