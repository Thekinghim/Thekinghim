import { EventStore } from '../store/event-store.js';
import { config } from '../config.js';

/**
 * Replay ur det egna arkivet.
 *
 * Samma kodväg som live: händelserna matas genom exakt samma handlers.
 * PLAN.md fas 4, punkt 4 — om backtest och live använder olika kod kommer de
 * att divergera och man vet aldrig vilken av dem som validerades.
 *
 * Finns arkivet inte ännu genereras en syntetisk ström i PumpPortals format,
 * så att gränssnittet och motorn går att köra utan nät. Den är märkt som
 * syntetisk hela vägen upp i gränssnittet.
 */
export function createReplaySource(handlers = {}, opts = {}) {
  const speed = Number(process.env.REPLAY_SPEED ?? opts.speed ?? 30);
  let timer = null;
  let stopped = false;

  const store = new EventStore(config.store);
  const archived = [...store.replay()];
  store.close();

  return {
    name: archived.length > 0 ? 'replay' : 'synthetic',
    synthetic: archived.length === 0,

    start() {
      if (archived.length > 0) {
        // Spela upp arkivet i ursprunglig takt, skalad med `speed`.
        let i = 0;
        const t0 = archived[0].ts;
        const started = Date.now();
        timer = setInterval(() => {
          if (stopped) return;
          const elapsed = (Date.now() - started) * speed;
          while (i < archived.length && archived[i].ts - t0 <= elapsed) {
            const e = archived[i++];
            dispatch(handlers, e.kind, e.raw);
          }
          if (i >= archived.length) clearInterval(timer);
        }, 100);
        return;
      }

      // Ingen inspelning ännu — generera en ström i samma format.
      const gen = syntheticGenerator();
      timer = setInterval(() => {
        if (stopped) return;
        for (const { kind, raw } of gen.tick()) dispatch(handlers, kind, raw);
      }, 500);
    },

    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

function dispatch(handlers, kind, raw) {
  if (kind === 'launch') handlers.onLaunch?.(raw);
  else if (kind === 'trade') handlers.onTrade?.(raw);
  else if (kind === 'migration') handlers.onMigration?.(raw);
}

/**
 * Syntetisk ström i PumpPortals format. Enda syftet är att kunna köra
 * motorn och gränssnittet utan nätverk — den bär ingen information om
 * marknaden och får aldrig presenteras som om den gjorde det.
 */
function syntheticGenerator() {
  const WORDS = ['PEPE', 'WOJAK', 'CHAD', 'BONK', 'MOON', 'GIGA', 'SNEK', 'TURBO', 'MYRO', 'ANDY'];
  let seed = 1337;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const live = [];
  let n = 0;

  return {
    tick() {
      const out = [];

      // Nya launches i ojämn takt, som på riktigt.
      if (rnd() < 0.45) {
        const symbol = WORDS[Math.floor(rnd() * WORDS.length)] + (rnd() < 0.4 ? Math.floor(rnd() * 99) : '');
        const mint = `SYN${(n++).toString().padStart(4, '0')}${Math.floor(rnd() * 1e9).toString(36)}pump`;
        const vTokens = 1_073_000_191;
        const initialBuy = rnd() < 0.3 ? vTokens * (0.01 + rnd() * 0.18) : vTokens * rnd() * 0.02;
        out.push({
          kind: 'launch',
          raw: {
            txType: 'create', mint, name: `${symbol} coin`, symbol,
            traderPublicKey: `SYNdev${Math.floor(rnd() * 40).toString(36)}`,
            solAmount: Number((initialBuy / vTokens * 30).toFixed(3)),
            initialBuy, vTokensInBondingCurve: vTokens,
            marketCapSol: Number((27 + rnd() * 14).toFixed(2)),
            signature: `syn${Math.floor(rnd() * 1e12).toString(36)}`,
          },
        });
        // Ungefär var femte får verklig aktivitet.
        live.push({ mint, hot: rnd() < 0.2, wallets: 0, mc: 30 });
        if (live.length > 40) live.shift();
      }

      for (const t of live) {
        const rate = t.hot ? 0.9 : 0.12;
        if (rnd() > rate) continue;
        const buy = rnd() < (t.hot ? 0.68 : 0.45);
        const sol = Number((0.05 + rnd() * (t.hot ? 2.2 : 0.5)).toFixed(4));
        t.mc = Math.max(25, t.mc * (1 + (buy ? sol : -sol) / 45));
        if (buy) t.wallets++;
        out.push({
          kind: 'trade',
          raw: {
            txType: buy ? 'buy' : 'sell', mint: t.mint, solAmount: sol,
            traderPublicKey: buy
              ? `SYNw${t.wallets}${t.mint.slice(3, 7)}`
              : `SYNw${Math.max(1, Math.floor(rnd() * t.wallets))}${t.mint.slice(3, 7)}`,
            marketCapSol: Number(t.mc.toFixed(2)),
            signature: `syn${Math.floor(rnd() * 1e12).toString(36)}`,
          },
        });
      }
      return out;
    },
  };
}
