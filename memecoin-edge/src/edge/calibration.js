import { median, rate } from '../util/stats.js';

/**
 * Självkalibrering mot din egen journal.
 *
 * Det här är den enda delen av verktyget som faktiskt blir bättre över tid,
 * och därför den mest värdefulla. Den lär sig ingenting om marknaden i
 * allmänhet — den lär sig vilka av *dina* signalintervall som historiskt
 * betalade, på riktig data, med dina kostnader inräknade.
 *
 * Ingen datalicens kan ge dig det här, eftersom det är en funktion av dina
 * egna trösklar. Det är också anledningen till att den vägrar säga något
 * innan den har underlag: med tio observationer är varje "insikt" brus.
 */

/** Minsta antal stängda positioner i en hink innan den får påverka något. */
const MIN_SAMPLE = 12;

/** Hinkar på gapet. Grova med flit — fina hinkar kräver data du inte har. */
const BUCKETS = [
  { id: 'gap_25_40', min: 25, max: 40 },
  { id: 'gap_40_55', min: 40, max: 55 },
  { id: 'gap_55_plus', min: 55, max: Infinity },
];

export function bucketFor(gap) {
  return BUCKETS.find((b) => gap >= b.min && gap < b.max)?.id ?? null;
}

/**
 * Bygger tabellen över hur varje hink har gått.
 * @param {{bucket: string|null, quadrant: string, marks: (number|null)[]}[]} closed
 * @param {number} horizonIndex Vilken horisont som räknas som facit.
 */
export function buildCalibration(closed, horizonIndex = 1) {
  const table = {};

  for (const bucket of BUCKETS) {
    const rows = closed.filter(
      (p) => p.bucket === bucket.id && p.marks[horizonIndex] !== null && p.marks[horizonIndex] !== undefined,
    );
    const returns = rows.map((p) => p.marks[horizonIndex]);
    table[bucket.id] = {
      n: rows.length,
      ready: rows.length >= MIN_SAMPLE,
      hitRate: rate(returns, (r) => r > 0),
      median: median(returns),
      // Medelvärdet är det som avgör om hinken är lönsam, eftersom svansen
      // bär resultatet. Medianen säger hur det *känns* att handla den.
      expectancy: returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0,
    };
  }

  return table;
}

/**
 * Prior för en ny kandidat, baserad på hur dess hink gått historiskt.
 * Returnerar null tills det finns underlag — och då påverkar den ingenting.
 *
 * @returns {{score: number, note: string} | null}
 */
export function priorFor(gap, calibration) {
  const bucket = bucketFor(gap);
  if (!bucket) return null;
  const stats = calibration?.[bucket];
  if (!stats?.ready) {
    return {
      score: 0,
      note: `Hinken ${bucket} har ${stats?.n ?? 0} av ${MIN_SAMPLE} observationer — påverkar inte konviktionen ännu.`,
    };
  }

  // Positiv förväntan höjer konviktionen, negativ sänker den. Taket på ±15
  // hindrar en lyckosam period från att ta över beslutet helt.
  const score = Math.max(-15, Math.min(15, stats.expectancy * 30));
  return {
    score,
    note:
      `Hinken ${bucket}: ${stats.n} observationer, träff ${Math.round(stats.hitRate * 100)} %, ` +
      `förväntan ${(stats.expectancy * 100).toFixed(1)} %.`,
  };
}

export { MIN_SAMPLE, BUCKETS };
