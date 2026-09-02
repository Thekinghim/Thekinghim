import { config } from '../config.js';

/**
 * pump.fun-ström via PumpPortal (wss://pumpportal.fun/api/data).
 *
 * subscribeNewToken och subscribeMigration är gratis och utan nyckel.
 * subscribeTokenTrade är mätad, så vi prenumererar bara på mints som redan
 * är kandidater och avprenumererar när de faller ur fönstret.
 */
export function createPumpPortalStream(handlers = {}) {
  let socket = null;
  let closed = false;
  let backoffMs = 1000;
  let heartbeat = null;
  let lastMessageAt = 0;
  /** @type {Set<string>} mints vi har trade-prenumeration på */
  const tracked = new Set();

  const send = (payload) => {
    if (socket?.readyState === 1) socket.send(JSON.stringify(payload));
  };

  const connect = () => {
    if (closed) return;
    socket = new WebSocket(config.pumpportal.ws);

    socket.addEventListener('open', () => {
      backoffMs = 1000;
      lastMessageAt = Date.now();
      send({ method: 'subscribeNewToken' });
      send({ method: 'subscribeMigration' });
      // Återställ trade-prenumerationerna efter en återanslutning, annars
      // tystnar kandidaterna utan att något ser trasigt ut.
      if (tracked.size > 0) send({ method: 'subscribeTokenTrade', keys: [...tracked] });
      handlers.onStatus?.({ state: 'live', tracked: tracked.size });

      clearInterval(heartbeat);
      heartbeat = setInterval(() => {
        // En WebSocket som tystnar utan att stängas är det vanligaste sättet
        // att tappa timmar av data utan att märka det.
        if (Date.now() - lastMessageAt > 120_000) {
          handlers.onStatus?.({ state: 'stale', tracked: tracked.size });
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
      if (msg?.message) return; // kvittens på prenumeration
      if (!msg?.txType) return;

      if (msg.txType === 'create') handlers.onLaunch?.(msg);
      else if (msg.txType === 'buy' || msg.txType === 'sell') handlers.onTrade?.(msg);
      else if (msg.txType === 'migrate') handlers.onMigration?.(msg);
    });

    socket.addEventListener('error', () => socket.close());

    socket.addEventListener('close', () => {
      clearInterval(heartbeat);
      if (closed) return;
      handlers.onStatus?.({ state: 'reconnecting', inMs: backoffMs, tracked: tracked.size });
      setTimeout(connect, backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30_000);
    });
  };

  return {
    name: 'pumpportal',
    start: connect,
    tracked,

    /** Börja ta emot trades för en mint. */
    track(mint) {
      if (tracked.has(mint) || tracked.size >= config.pumpportal.maxTrackedMints) return false;
      tracked.add(mint);
      send({ method: 'subscribeTokenTrade', keys: [mint] });
      return true;
    },

    untrack(mint) {
      if (!tracked.delete(mint)) return false;
      send({ method: 'unsubscribeTokenTrade', keys: [mint] });
      return true;
    },

    stop() {
      closed = true;
      clearInterval(heartbeat);
      socket?.close();
    },
  };
}
