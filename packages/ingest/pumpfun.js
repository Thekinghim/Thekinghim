/**
 * pump.fun-ström via PumpPortal.
 *
 * `wss://pumpportal.fun/api/data` — gratis, ingen nyckel, ingen registrering.
 * Två strömmar vi bryr oss om:
 *
 *   subscribeNewToken   varje ny launch, i samma sekund den sker
 *   subscribeMigration  bonding curve → graduation till DEX
 *
 * Det avgörande fältet är `traderPublicKey` på en launch: **creator-walleten**.
 * MELT:s publika dataset har den inte (deras creator-fält är en konstant), och
 * det är därför ingen kan sälja dig en creator-historik. Den går bara att
 * bygga genom att spela in strömmen själv, från dag ett. Det är hela skälet
 * till att arkivering ligger som krav i PLAN.md.
 *
 * @typedef {Object} PumpLaunch
 * @property {string} mint
 * @property {string} name
 * @property {string} symbol
 * @property {string} creator            Deployerns wallet.
 * @property {number} ts
 * @property {number} initialBuySol      Hur mycket deployern köpte av sin egen token.
 * @property {number} marketCapSol
 * @property {string|null} uri           Metadata på IPFS.
 * @property {string} pool
 */

const WS_URL = process.env.PUMPPORTAL_WS ?? 'wss://pumpportal.fun/api/data';

/**
 * @param {{onLaunch?: (l: PumpLaunch) => void, onMigration?: (m: any) => void,
 *          onStatus?: (s: string) => void, onError?: (e: Error) => void}} handlers
 */
export function createPumpFunStream(handlers = {}) {
  let socket = null;
  let closed = false;
  let backoffMs = 1000;
  let heartbeat = null;
  let lastMessageAt = 0;

  const connect = () => {
    if (closed) return;
    socket = new WebSocket(WS_URL);

    socket.addEventListener('open', () => {
      backoffMs = 1000;
      lastMessageAt = Date.now();
      socket.send(JSON.stringify({ method: 'subscribeNewToken' }));
      socket.send(JSON.stringify({ method: 'subscribeMigration' }));
      handlers.onStatus?.('ansluten');

      // En WebSocket som tystnar utan att stängas är det vanligaste sättet
      // att tappa timmar av data utan att märka det. Vi mäter tystnaden
      // själva istället för att lita på att servern stänger anslutningen.
      clearInterval(heartbeat);
      heartbeat = setInterval(() => {
        if (Date.now() - lastMessageAt > 120_000) {
          handlers.onStatus?.('tyst i 2 min — kopplar om');
          socket.close();
        }
      }, 30_000);
    });

    socket.addEventListener('message', (event) => {
      lastMessageAt = Date.now();
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      // Kvittensmeddelanden på prenumerationerna saknar txType.
      if (!msg?.txType) return;

      if (msg.txType === 'create') handlers.onLaunch?.(normalizeLaunch(msg));
      else if (msg.txType === 'migrate' || msg.pool === 'raydium') handlers.onMigration?.(msg);
    });

    socket.addEventListener('error', () => socket.close());

    socket.addEventListener('close', () => {
      clearInterval(heartbeat);
      if (closed) return;
      handlers.onStatus?.(`frånkopplad — återansluter om ${backoffMs / 1000} s`);
      setTimeout(connect, backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30_000);
    });
  };

  return {
    name: 'pumpportal',
    start() {
      connect();
    },
    stop() {
      closed = true;
      clearInterval(heartbeat);
      socket?.close();
    },
  };
}

/**
 * Plattar ut PumpPortals launch-event.
 *
 * `initialBuySol` är deployerns eget köp i samma transaktion som skapandet.
 * Det är inte i sig ett larm — de flesta seedar sin pool — men storleken
 * relativt marknadsvärdet säger hur mycket av supplyn som ligger hos en
 * enda wallet från sekund noll.
 *
 * @param {*} msg
 * @returns {PumpLaunch}
 */
export function normalizeLaunch(msg) {
  return {
    mint: msg.mint,
    name: msg.name ?? '',
    symbol: msg.symbol ?? '',
    creator: msg.traderPublicKey ?? msg.creator ?? null,
    ts: Date.now(),
    signature: msg.signature ?? null,
    initialBuySol: Number(msg.solAmount ?? 0),
    initialBuyTokens: Number(msg.initialBuy ?? 0),
    marketCapSol: Number(msg.marketCapSol ?? 0),
    vTokensInBondingCurve: Number(msg.vTokensInBondingCurve ?? 0),
    vSolInBondingCurve: Number(msg.vSolInBondingCurve ?? 0),
    uri: msg.uri ?? null,
    pool: msg.pool ?? 'pump',
  };
}

/**
 * Andel av supplyn deployern höll direkt efter skapandet, 0–100.
 * Returnerar null när fälten saknas — okänt är inte noll.
 */
export function deployerOpeningShare(launch) {
  const total = launch.initialBuyTokens + launch.vTokensInBondingCurve;
  if (!(total > 0) || !(launch.initialBuyTokens >= 0)) return null;
  return (launch.initialBuyTokens / total) * 100;
}
