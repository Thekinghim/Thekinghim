/**
 * Kontrollerar att varje datakälla svarar och att fälten vi förlitar oss på
 * faktiskt finns i svaret.
 *
 * Kör den först. Ett API som bytt fältnamn ger annars ett verktyg som ser
 * ut att fungera men tyst betygsätter allt till noll — det värsta
 * felläget för ett beslutsstöd.
 */
import { fetchRecent } from './sources/jupiter.js';
import { fetchBoostedTokens, fetchTokenProfiles, fetchPairs } from './sources/dexscreener.js';

const ok = (s) => `\x1b[32m✓\x1b[0m ${s}`;
const bad = (s) => `\x1b[31m✗\x1b[0m ${s}`;
const warn = (s) => `\x1b[33m!\x1b[0m ${s}`;

let failures = 0;

async function check(label, fn) {
  const started = Date.now();
  try {
    const result = await fn();
    console.log(ok(`${label.padEnd(28)} ${Date.now() - started} ms — ${result}`));
  } catch (err) {
    failures++;
    console.log(bad(`${label.padEnd(28)} ${err.message}`));
  }
}

console.log('\nKontrollerar datakällor (alla gratis, ingen nyckel)\n');

await check('Jupiter /tokens/v2/recent', async () => {
  const tokens = await fetchRecent();
  if (tokens.length === 0) throw new Error('tomt svar');

  // Fälten som hela verktyget vilar på. Saknas de är resten meningslös.
  const required = ['organicScore', 'holderCount', 'topHolderPct'];
  const sample = tokens.find((t) => required.every((f) => t[f] !== null)) ?? tokens[0];
  const missing = required.filter((f) => sample[f] === null);
  if (missing.length === required.length) throw new Error(`inga av fälten ${required.join(', ')} finns`);
  if (missing.length > 0) console.log(warn(`  saknade fält på stickprovet: ${missing.join(', ')}`));

  const withStats = tokens.filter((t) => t.stats5m.numOrganicBuyers !== null).length;
  if (withStats === 0) throw new Error('inga tokens har stats5m.numOrganicBuyers — fältnamnet kan ha ändrats');
  return `${tokens.length} tokens, ${withStats} med organisk statistik`;
});

await check('DexScreener boosts', async () => {
  const boosts = await fetchBoostedTokens();
  return `${boosts.size} boostade Solana-tokens`;
});

await check('DexScreener profiles', async () => {
  const profiles = await fetchTokenProfiles();
  return `${profiles.size} profiler`;
});

await check('DexScreener pairs', async () => {
  const tokens = await fetchRecent();
  const pairs = await fetchPairs(tokens.slice(0, 10).map((t) => t.address));
  if (pairs.size === 0) return 'svarade, men inga par matchade (kan vara normalt för mycket nya tokens)';
  const sample = [...pairs.values()][0];
  if (sample.liquidityUsd === undefined) throw new Error('liquidity saknas i svaret');
  return `${pairs.size} par, exempel: $${Math.round(sample.liquidityUsd).toLocaleString('sv-SE')} likviditet`;
});

console.log(
  failures === 0
    ? `\n${ok('Alla källor svarar. Kör `npm start`.')}\n`
    : `\n${bad(`${failures} källa/källor svarar inte. Verktyget kan köras men med sämre underlag.`)}\n`,
);
process.exit(failures > 0 ? 1 : 0);
