/** Små statistikhjälpare. Inga beroenden, medvetet tråkiga. */

/** Mappar x till 0..1 med mättnad vid `full`. Linjär, förutsägbar, lätt att debugga. */
export function saturate(x, full) {
  if (!Number.isFinite(x) || x <= 0) return 0;
  return Math.min(1, x / full);
}

/** Mappar x till 0..1 där `mid` ger 0.5. Bra för kvoter (t.ex. köpare/säljare). */
export function logistic(x, mid, steepness = 1) {
  if (!Number.isFinite(x)) return 0;
  return 1 / (1 + Math.exp(-steepness * (x - mid)));
}

export function median(values) {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Andel av `values` som uppfyller predikatet. Returnerar 0 för tom lista
 * istället för NaN — NaN som smyger in i en score är svårt att spåra.
 */
export function rate(values, predicate) {
  if (values.length === 0) return 0;
  return values.filter(predicate).length / values.length;
}

export function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

/** Deterministisk PRNG så att backtests går att reproducera. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
