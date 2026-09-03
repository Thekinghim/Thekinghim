/**
 * Backtest mot simulerade launches med känt facit.
 *
 * Kör: node src/backtest.js [antal] [frö]
 *
 * Syftet är inte att visa att strategin tjänar pengar — den går mot syntetisk
 * data, så det skulle inte betyda något. Syftet är att svara på två frågor som
 * går att svara på även med syntetisk data:
 *
 *   1. Fångar de hårda grindarna de fällor de är byggda för att fånga?
 *   2. Går larmen bättre än kontrollgruppen, eller rankar poängen brus?
 */
import { generateLaunch, createStreams, archetypes } from './ingest/mock.js';
import { Pipeline } from './pipeline.js';
import { config } from './config.js';

const launchCount = Number(process.argv[2] ?? 400);
const seed = Number(process.argv[3] ?? 20250902);

const streams = createStreams(seed);
const pipeline = new Pipeline(config);

/** @type {Map<string, string>} address -> arketyp */
const truthByToken = new Map();
const alertsByArchetype = {};
const seenByArchetype = {};

let ts = Date.now();
for (let i = 0; i < launchCount; i++) {
  const launch = generateLaunch(streams, ts, i);
  truthByToken.set(launch.meta.address, launch.truth.archetype);
  seenByArchetype[launch.truth.archetype] = (seenByArchetype[launch.truth.archetype] ?? 0) + 1;

  pipeline.onToken(launch.meta, launch.truth);
  for (const trade of launch.trades) pipeline.onTrade(trade);
  ts += 40_000;
}

pipeline.ledger.settle();

for (const pos of pipeline.ledger.positions.values()) {
  if (pos.group !== 'strategy') continue;
  const a = truthByToken.get(pos.address);
  alertsByArchetype[a] = (alertsByArchetype[a] ?? 0) + 1;
}

const pct = (x) => `${(x * 100).toFixed(1)} %`;
const signed = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)} %`;
const stats = pipeline.stats();

console.log(`\n=== BACKTEST — ${launchCount} launches, frö ${seed} ===\n`);

console.log('Tratten');
console.log(`  Upptäckta pooler        ${stats.counters.seen}`);
console.log(`  Fällda av hårda grindar ${stats.counters.gateFailed}`);
console.log(`  Under risk-/momentumtröskel ${stats.counters.riskRejected}`);
console.log(`  Larm                    ${stats.counters.alerted}`);

console.log('\nVilken grind som fäller');
const gateRows = Object.entries(stats.gateFailures).sort((a, b) => b[1] - a[1]);
if (gateRows.length === 0) console.log('  (inga)');
for (const [gate, n] of gateRows) console.log(`  ${gate.padEnd(20)} ${n}`);

console.log('\nLarm per arketyp (larm / totalt)');
for (const a of archetypes) {
  const seen = seenByArchetype[a.id] ?? 0;
  const alerted = alertsByArchetype[a.id] ?? 0;
  const flag = a.isTrap ? 'FÄLLA' : 'ok   ';
  const share = seen > 0 ? pct(alerted / seen) : '–';
  console.log(`  ${flag}  ${a.id.padEnd(14)} ${String(alerted).padStart(3)} / ${String(seen).padStart(3)}  (${share})`);
}

const trapsSeen = Object.entries(seenByArchetype)
  .filter(([id]) => archetypes.find((a) => a.id === id)?.isTrap)
  .reduce((s, [, n]) => s + n, 0);
const trapsAlerted = Object.entries(alertsByArchetype)
  .filter(([id]) => archetypes.find((a) => a.id === id)?.isTrap)
  .reduce((s, [, n]) => s + n, 0);

console.log(`\n  Andel fällor i flödet   ${pct(trapsSeen / launchCount)}`);
console.log(`  Andel fällor i larmen   ${pct(stats.counters.alerted ? trapsAlerted / stats.counters.alerted : 0)}`);

console.log('\nPaper-resultat (strategi mot kontrollgrupp)');
for (const group of ['strategy', 'control']) {
  const g = stats.paper[group];
  const label = group === 'strategy' ? 'STRATEGI' : 'KONTROLL';
  console.log(`\n  ${label}  n=${g.n}  fällor=${pct(g.trapRate)}  värsta drawdown=${signed(g.worstDrawdown)}`);
  for (const h of g.horizons) {
    if (h.n === 0) continue;
    console.log(
      `    ${h.label.padEnd(4)} n=${String(h.n).padStart(3)}  träff=${pct(h.winRate).padStart(7)}` +
        `  median=${signed(h.median).padStart(8)}  medel=${signed(h.mean).padStart(9)}` +
        `  bäst=${signed(h.best).padStart(9)}  sämst=${signed(h.worst).padStart(8)}`,
    );
  }
}

console.log(
  '\nLäs så här: skillnaden mellan STRATEGI och KONTROLL är det poängsättningen\n' +
    'tillför utöver de hårda grindarna. Är den skillnaden liten är komplexiteten\n' +
    'i scoringen inte värd sitt underhåll — kör bara grindarna.\n',
);
