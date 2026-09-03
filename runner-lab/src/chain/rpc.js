import { config } from '../config.js';

/**
 * Minimal Solana-RPC-klient med kö.
 *
 * Publika endpoints stryper hårt och svarar 429 långt innan de svarar fel.
 * Kön håller nere både samtidighet och takt, för ett strypt RPC mitt i ett
 * fönster är samma sak som ingen data alls.
 */
let requestId = 0;
let queue = Promise.resolve();
let lastCallAt = 0;

async function rpc(method, params) {
  // Serialiserar anropen och håller ett minimiavstånd mellan dem.
  const run = async () => {
    const wait = Math.max(0, lastCallAt + config.rpc.minIntervalMs - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();

    const res = await fetch(config.rpc.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
      signal: AbortSignal.timeout(12_000),
    });
    if (res.status === 429) throw new Error('RPC strypt (429)');
    if (!res.ok) throw new Error(`RPC ${method}: HTTP ${res.status}`);
    const body = await res.json();
    if (body.error) throw new Error(`RPC ${method}: ${body.error.message}`);
    return body.result;
  };

  queue = queue.then(run, run);
  return queue;
}

/**
 * Läser mint-kontot: är mint- och freeze-authority återkallade?
 *
 * De två kontrollerna är de viktigaste på Solana och går att göra utan
 * tredjepartstjänst. Kan de inte utföras returneras `unknown: true` — vi
 * påstår aldrig att något är säkert bara för att anropet misslyckades.
 */
export async function readMintAuthorities(mint) {
  try {
    const result = await rpc('getAccountInfo', [mint, { encoding: 'jsonParsed' }]);
    const info = result?.value?.data?.parsed?.info;
    if (!info) return { unknown: true, reason: 'mint-kontot kunde inte läsas' };
    return {
      unknown: false,
      mintAuthorityActive: info.mintAuthority != null,
      freezeAuthorityActive: info.freezeAuthority != null,
      decimals: info.decimals,
      supply: Number(info.supply),
      tokenProgram: result.value.owner,
    };
  } catch (err) {
    return { unknown: true, reason: err.message };
  }
}

/**
 * Innehavarkoncentration ur de största token-kontona.
 *
 * Bonding-curve-kontot räknas bort. Utan det ser varje pump.fun-token ut att
 * ha en dominant innehavare, vilket gör måttet obrukbart under just den fas
 * vi bryr oss om.
 */
export async function readTopHolders(mint, exclude = []) {
  try {
    const result = await rpc('getTokenLargestAccounts', [mint]);
    const all = result?.value ?? [];
    const accounts = all.filter((a) => !exclude.includes(a.address));
    const total = accounts.reduce((s, a) => s + Number(a.uiAmount ?? 0), 0);
    if (total <= 0) return { unknown: true, reason: 'inga innehavarkonton' };

    const sorted = [...accounts].sort((a, b) => Number(b.uiAmount ?? 0) - Number(a.uiAmount ?? 0));
    const top10 = sorted.slice(0, 10).reduce((s, a) => s + Number(a.uiAmount ?? 0), 0);
    return {
      unknown: false,
      accountsSeen: all.length,
      topHolderPct: (top10 / total) * 100,
      largestPct: (Number(sorted[0]?.uiAmount ?? 0) / total) * 100,
      top: sorted.slice(0, 10).map((a) => ({
        address: a.address,
        pct: (Number(a.uiAmount ?? 0) / total) * 100,
      })),
    };
  } catch (err) {
    return { unknown: true, reason: err.message };
  }
}

export { rpc };
