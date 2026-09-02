import { EventStore } from '../store/event-store.js';
import { config } from '../config.js';

/**
 * Replay ur det egna arkivet.
 *
 * Samma kodväg som live: händelserna matas genom exakt samma handlers.
 * PLAN.md fas 4, punkt 4 — om backtest och live använder olika kod kommer de
 * att divergera, och då vet man aldrig vilken av dem som validerades.
 *
 * Ingen syntetisk data. Finns inget arkiv visar terminalen ett tomt läge och
 * säger varför. Ett verktyg som hittar på mynt när strömmen är tyst är värre
 * än ett tomt verktyg: allt man ser blir omöjligt att lita på, och det enda
 * sättet att upptäcka det är att slå upp en adress som inte finns.
 */
export function createReplaySource(handlers = {}, opts = {}) {
  const speed = Number(process.env.REPLAY_SPEED ?? opts.speed ?? 30);
  let timer = null;
  let stopped = false;

  const store = new EventStore(config.store);
  const archived = [...store.replay()];
  store.close();

  return {
    name: 'replay',
    empty: archived.length === 0,
    archivedCount: archived.length,

    start() {
      if (archived.length === 0) {
        handlers.onStatus?.({
          state: 'tomt arkiv',
          detail: 'Kör `npm start` en stund först — replay spelar upp det du själv spelat in.',
        });
        return;
      }

      handlers.onStatus?.({ state: 'replay', detail: `${archived.length} arkiverade event` });

      let i = 0;
      const t0 = archived[0].ts;
      const started = Date.now();
      timer = setInterval(() => {
        if (stopped) return;
        const elapsed = (Date.now() - started) * speed;
        while (i < archived.length && archived[i].ts - t0 <= elapsed) {
          const e = archived[i++];
          if (e.kind === 'launch') handlers.onLaunch?.(e.raw);
          else if (e.kind === 'trade') handlers.onTrade?.(e.raw);
          else if (e.kind === 'migration') handlers.onMigration?.(e.raw);
        }
        if (i >= archived.length) {
          clearInterval(timer);
          handlers.onStatus?.({ state: 'replay slut', detail: `${archived.length} event uppspelade` });
        }
      }, 100);
    },

    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
