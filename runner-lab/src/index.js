import { config } from './config.js';
import { createServer } from './server.js';
import { createPumpPortalStream } from './ingest/pumpportal.js';
import { createReplaySource } from './ingest/replay.js';
import { EventStore } from './store/event-store.js';
import { Radar } from './engine/radar.js';
import { CreatorRegistry } from './engine/creators.js';
import { OutcomeLedger } from './engine/outcomes.js';
import { PreflightQueue } from './chain/preflight.js';
import { readMintAuthorities, readTopHolders } from './chain/rpc.js';
import { fetchTokenMetadata, metadataStats } from './chain/metadata.js';

const store = new EventStore(config.store);
const creators = new CreatorRegistry({ dir: config.store.dir });
const outcomes = new OutcomeLedger({ dir: config.store.dir });

let stream = null;
let status = { state: 'startar', source: config.source, tracked: 0 };
let dirty = true;

const preflight = new PreflightQueue({ onUpdate: () => { dirty = true; } });

const radar = new Radar({
  onNew: (entry) => {
    // Lyssna direkt. Kvalificering kräver trades, så en prenumeration som
    // startar först vid kvalificering skulle aldrig kunna starta alls.
    if (stream?.track && stream.track(entry.mint)) entry.tracking = true;
    // Authority-kontrollen på allt. Det är ett anrop, och utan den fastnar
    // varje omdöme på VÄNTA.
    preflight.enqueue(entry, { full: false });
    // Bild och socials på allt också — det är gratis och det är det som gör
    // att man slipper öppna pump.fun.
    fetchTokenMetadata(entry.mint, entry.uri).then((meta) => {
      if (meta) { entry.meta = meta; dirty = true; }
    });
    creators.recordLaunch({
      mint: entry.mint, creator: entry.creator, symbol: entry.symbol,
      name: entry.name, ts: entry.launchedAt,
      initialBuySol: entry.creatorInitialSol, marketCapSol: entry.launchMarketCapSol,
    });
    dirty = true;
  },
  onQualified: (entry) => {
    // Först nu är token värd de dyra anropen: on-chain-kontroller och
    // metadata. Att hämta bild och socials för varje listning vore hundratals
    // IPFS-anrop i minuten för tokens ingen kommer titta på.
    preflight.enqueue(entry, { full: true });
    console.log(
      `\x1b[32m[KVALIFICERAD]\x1b[0m ${(entry.symbol || entry.mint.slice(0, 8)).padEnd(12)} ` +
      `${entry.window.metrics().uniqueBuyers} unika köpare · ${entry.mint}`,
    );
    dirty = true;
  },
  onDevSell: (entry, sol) => {
    console.log(
      `\x1b[31m[DEV SÄLJER]\x1b[0m ${(entry.symbol || entry.mint.slice(0, 8)).padEnd(12)} ` +
      `${sol.toFixed(3)} SOL · totalt ${entry.devSoldSol.toFixed(2)} · ${entry.mint}`,
    );
    dirty = true;
  },
  onMigration: (entry) => {
    creators.recordGraduation(entry.mint);
    outcomes.recordGraduation(entry.mint);
    console.log(`\x1b[36m[MIGRATION]\x1b[0m ${entry.symbol || entry.mint.slice(0, 8)}`);
    dirty = true;
  },
});

const handlers = {
  onLaunch: (raw) => { store.append('launch', raw); radar.onLaunch(raw); },
  onTrade: (raw) => { store.append('trade', raw); radar.onTrade(raw); },
  onMigration: (raw) => {
    store.append('migration', raw);
    // En migration kan gälla en mint vi aldrig såg födas (startade mitt i).
    if (!radar.onMigration(raw)) {
      // Migrationen kan gälla en mint vi aldrig såg födas, eller en som
      // fallit ur radarn. Utfallet är lika giltigt då.
      creators.recordGraduation(raw.mint);
      outcomes.recordGraduation(raw.mint);
    }
    dirty = true;
  },
  onStatus: (s) => { status = { ...status, ...s }; dirty = true; },
};

const app = {
  snapshot() {
    return {
      status: { ...status, source: stream?.name ?? config.source, empty: stream?.empty === true },
      board: radar.board(),
      counters: radar.counters,
      store: store.stats(),
      preflight: preflight.stats(),
      creators: creators.stats(),
      metadata: metadataStats(),
      outcomes: outcomes.stats(),
      config: {
        windowMinutes: config.radar.windowMinutes,
        minUniqueBuyers: config.radar.minUniqueBuyers,
        maxTracked: config.pumpportal.maxTrackedMints,
      },
    };
  },

  /** Allt om en mint: tape, serie, metadata, kontroller. */
  async detail(mint) {
    const entry = radar.tokens.get(mint);
    if (!entry) return null;
    if (!entry.meta && entry.uri) {
      entry.meta = await fetchTokenMetadata(mint, entry.uri);
    }
    const row = radar.board(500).find((r) => r.mint === mint) ?? null;
    return {
      ...row,
      meta: entry.meta ?? null,
      tape: entry.window.tape,
      series: entry.window.series,
      reputation: entry.creator ? creators.reputationAt(entry.creator) : null,
      baseRate: creators.baseRate(),
    };
  },

  /** Full analys av en inklistrad CA — samma kontroller som preflight. */
  async lookup(mint) {
    const [authorities, holders] = await Promise.all([
      readMintAuthorities(mint),
      readTopHolders(mint),
    ]);
    const tracked = radar.tokens.get(mint);
    const reputation = tracked?.creator ? creators.reputationAt(tracked.creator) : null;
    return {
      mint,
      authorities,
      holders,
      known: Boolean(tracked),
      radar: tracked ? radar.board().find((r) => r.mint === mint) ?? null : null,
      creator: tracked?.creator ?? null,
      reputation,
      baseRate: creators.baseRate(),
    };
  },
};

const { server, broadcast } = createServer(app, config);

stream = config.source === 'replay'
  ? createReplaySource(handlers)
  : createPumpPortalStream(handlers);

stream.start();

// Push på egen takt. Ett svar kan innehålla hundratals händelser per sekund
// och en sändning per händelse gör klienten obrukbar.
setInterval(() => {
  // Bokför domar som hunnit bli meningsfulla, och uppdatera toppnoteringar.
  for (const row of radar.board(500)) {
    if (row.preflight?.checks?.authority) outcomes.grade(row);
    const mcap = row.metrics?.marketCapSol;
    if (mcap > 0) outcomes.mark(row.mint, mcap);
  }

  const { release } = radar.evict();
  for (const mint of release) stream.untrack?.(mint);
  if (!dirty) return;
  dirty = false;
  status.tracked = stream.tracked?.size ?? 0;
  broadcast('snapshot', app.snapshot());
}, 1000);

server.listen(config.server.port, config.server.host, () => {
  console.log(`\n  RUNNER LAB — ${stream.name}${stream.synthetic ? ' (syntetisk)' : ''}`);
  const shown = config.server.host === '0.0.0.0' ? 'localhost' : config.server.host;
  console.log(`  http://${shown}:${config.server.port}`);
  console.log(`  Arkiv: ${config.store.dir}events/\n`);
});

// Toppnoteringar skrivs på egen takt i stället för vid varje handel.
setInterval(() => outcomes.flush(), 30_000).unref();

const shutdown = () => {
  stream.stop();
  outcomes.flush();
  store.close();
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
