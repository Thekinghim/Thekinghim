/**
 * EVM-adapter: lyssnar på nya par från en Uniswap V2-kompatibel factory.
 *
 * Kräver `EVM_WS_URL` och `EVM_RPC_URL`. `EVM_FACTORY` kan pekas om till valfri
 * V2-fork (PancakeSwap, Base-forkar, m.fl.).
 *
 * Samma fail-closed-princip som Solana-adaptern: en kontroll som inte kan
 * utföras räknas som underkänd.
 */

import { keccak256Hex, keccak256Utf8 } from '../util/keccak.js';

const PAIR_CREATED_TOPIC = keccak256Utf8('PairCreated(address,address,address,uint256)');
const DEFAULT_FACTORY = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f'; // Uniswap V2, mainnet

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

const addressFromTopic = (topic) => `0x${topic.slice(26)}`;

/**
 * Läser ett publikt, argumentlöst getter-anrop och returnerar rådata.
 * Saknas funktionen på kontraktet svarar noden med "0x" — vilket är svaret
 * vi vill ha, inte ett fel.
 */
async function call(rpcUrl, to, selector) {
  try {
    return await rpc(rpcUrl, 'eth_call', [{ to, data: selector }, 'latest']);
  } catch {
    return '0x';
  }
}

const SELECTORS = {
  owner: '0x8da5cb5b', // owner()
  totalSupply: '0x18160ddd', // totalSupply()
  symbol: '0x95d89b41', // symbol()
};

// EIP-1967 implementation slot: keccak256("eip1967.proxy.implementation") - 1
const EIP1967_IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

/** En kontraktsägare som inte är nolladressen kan i regel ändra spelreglerna. */
export function ownerIsRenounced(ownerResult) {
  if (!ownerResult || ownerResult === '0x') return false; // okänt => underkänt
  const address = ownerResult.slice(-40);
  return /^0+$/.test(address) || address === 'dead'.padStart(40, '0');
}

/** Ligger det en implementation i EIP-1967-sloten är kontraktet en uppgraderbar proxy. */
export function isUpgradeableProxy(slotValue) {
  if (!slotValue || slotValue === '0x') return false;
  return !/^0x0*$/.test(slotValue);
}

/**
 * Säljsimulering via `eth_call` med state override: vi ger en påhittad adress
 * ett tokensaldo och försöker sälja. Går anropet igenom är token inte en
 * honeypot i den nuvarande kedjestatusen.
 *
 * Två saker att veta: overrides kräver en nod som stödjer dem (geth, Erigon,
 * de flesta betalleverantörer), och resultatet gäller bara *nu* — en
 * uppgraderbar kontrakt kan bli en honeypot i nästa block. Därför fäller
 * `immutable`-grinden proxykontrakt oavsett vad simuleringen säger.
 */
export async function simulateSell(rpcUrl, { token, router, weth, holderSlot = 0 }) {
  const probe = '0x000000000000000000000000000000000000dEaD';
  const amount = 1_000_000n * 10n ** 18n;

  // swapExactTokensForETHSupportingFeeOnTransferTokens(uint,uint,address[],address,uint)
  const selector = '0x791ac947';
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const data =
    selector +
    encodeUint(amount) +
    encodeUint(0n) +
    encodeUint(160n) + // offset till path
    encodeAddress(probe) +
    encodeUint(deadline) +
    encodeUint(2n) + // path.length
    encodeAddress(token) +
    encodeAddress(weth);

  try {
    await rpc(rpcUrl, 'eth_call', [
      { from: probe, to: router, data },
      'latest',
      {
        [token]: {
          stateDiff: {
            [slotFor(probe, holderSlot)]: `0x${amount.toString(16).padStart(64, '0')}`,
          },
        },
      },
    ]);
    return true;
  } catch {
    return false;
  }
}

const encodeUint = (value) => value.toString(16).padStart(64, '0');
const encodeAddress = (addr) => addr.toLowerCase().replace('0x', '').padStart(64, '0');

/**
 * Lagringsplatsen för `mapping(address => uint256)`: keccak256(pad(nyckel) ++ pad(slot)).
 *
 * `holderSlot` är vilket slot-nummer balances-mappingen ligger på i just det
 * kontraktet — 0 för en standard-OpenZeppelin-ERC20, men forkar flyttar den.
 * Gissar du fel skriver overriden till fel plats, saldot blir noll och
 * simuleringen faller igenom som "honeypot". Fel åt det försiktiga hållet,
 * men verifiera slot-numret innan du litar på ett underkänt resultat.
 */
export function slotFor(holder, slot) {
  const key = holder.toLowerCase().replace('0x', '').padStart(64, '0');
  const index = BigInt(slot).toString(16).padStart(64, '0');
  return keccak256Hex(key + index);
}

/** @param {typeof import('../config.js').config} cfg */
export function createEvmSource(cfg) {
  const wsUrl = process.env.EVM_WS_URL;
  const rpcUrl = process.env.EVM_RPC_URL;
  const factory = (process.env.EVM_FACTORY ?? DEFAULT_FACTORY).toLowerCase();
  if (!wsUrl || !rpcUrl) {
    throw new Error(
      'SOURCE=evm kräver EVM_WS_URL och EVM_RPC_URL. Kör utan dem för simulerad data (SOURCE=mock).',
    );
  }

  let socket = null;
  let closed = false;
  let backoffMs = 1000;

  return {
    name: 'evm',
    start(handlers) {
      const connect = () => {
        if (closed) return;
        socket = new WebSocket(wsUrl);

        socket.addEventListener('open', () => {
          backoffMs = 1000;
          socket.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: ++requestId,
              method: 'eth_subscribe',
              params: ['logs', { address: factory, topics: [PAIR_CREATED_TOPIC] }],
            }),
          );
          console.log('[evm] prenumererar på PairCreated från', factory);
        });

        socket.addEventListener('message', async (event) => {
          try {
            const msg = JSON.parse(event.data);
            const log = msg?.params?.result;
            if (!log?.topics || log.topics[0] !== PAIR_CREATED_TOPIC) return;
            await handleNewPair(log, handlers, rpcUrl);
          } catch (err) {
            console.error('[evm] kunde inte tolka logg:', err.message);
          }
        });

        const reconnect = () => {
          if (closed) return;
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

async function handleNewPair(log, handlers, rpcUrl) {
  const token0 = addressFromTopic(log.topics[1]);
  const token1 = addressFromTopic(log.topics[2]);
  // Den nya token är den som inte är den etablerade sidan av paret.
  const known = new Set([
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
    '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
  ]);
  const token = known.has(token0.toLowerCase()) ? token1 : token0;

  const [ownerResult, proxySlot] = await Promise.all([
    call(rpcUrl, token, SELECTORS.owner),
    rpc(rpcUrl, 'eth_getStorageAt', [token, EIP1967_IMPL_SLOT, 'latest']).catch(() => '0x'),
  ]);

  handlers.onToken({
    address: token,
    symbol: token.slice(2, 8).toUpperCase(),
    chain: 'evm',
    createdAt: Date.now(),
    // Ägaren kvar = kan i praktiken prägla eller pausa på de flesta forkar.
    mintAuthorityActive: !ownerIsRenounced(ownerResult),
    freezeAuthorityActive: !ownerIsRenounced(ownerResult),
    metadataMutable: false,
    upgradeableContract: isUpgradeableProxy(proxySlot),
    lpLockedPct: 0,
    lpUsd: 0,
    buyTaxBps: 0,
    sellTaxBps: 0,
    sellSimulationOk: false,
    topHolderPct: 100,
    devHoldingPct: 0,
    bundledLaunchPct: 0,
    deployer: 'unknown',
    deployerFlagged: false,
  });
}
