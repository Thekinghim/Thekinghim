/**
 * Offline-preview: kör den riktiga beslutskedjan över inspelade svar.
 *
 * Samma kod som live-läget — normalisering, grindar, attention gap, beslut.
 * Enda skillnaden är att datan kommer från fixtures istället för nätet.
 * Finns för att kunna granska gränssnittet och besluten utan att vara
 * beroende av att ett externt API svarar just nu.
 *
 *   npm run preview
 */
import fs from 'node:fs';
import { normalizeToken } from './sources/jupiter.js';
import { decide } from './edge/decision.js';
import { attentionGap } from './edge/attention.js';
import { buildCalibration, priorFor, bucketFor } from './edge/calibration.js';
import { createServer } from './server.js';
import { config, liveConfig } from './config.js';
import { mulberry32 } from './util/stats.js';

const fixtures = JSON.parse(
  fs.readFileSync(new URL('../test/fixtures/jupiter-recent.json', import.meta.url)),
);

const rnd = mulberry32(4711);

/** Skalar en talmängd med en faktor, och lämnar saknade värden ifred. */
function scaleStats(stats, factor) {
  const out = {};
  for (const [key, value] of Object.entries(stats ?? {})) {
    out[key] = typeof value === 'number' ? Math.round(value * factor * 100) / 100 : value;
  }
  return out;
}

/** Bygger en varierad tavla ur de fem grundfallen. */
function buildBoard() {
  const decisions = [];

  for (let i = 0; i < 16; i++) {
    const base = fixtures[i % fixtures.length];
    const factor = 0.35 + rnd() * 1.5;
    const ageMinutes = 8 + rnd() * 400;

    const raw = {
      ...base,
      id: `${base.id.slice(0, 30)}${i.toString().padStart(2, '0')}`,
      symbol: i < fixtures.length ? base.symbol : `${base.symbol}${i}`,
      holderCount: base.holderCount ? Math.round(base.holderCount * factor) : base.holderCount,
      liquidity: base.liquidity ? Math.round(base.liquidity * (0.5 + rnd())) : base.liquidity,
      stats5m: scaleStats(base.stats5m, factor),
      stats1h: scaleStats(base.stats1h, factor),
      firstPool: { ...base.firstPool, createdAt: new Date(Date.now() - ageMinutes * 60_000).toISOString() },
    };

    const token = normalizeToken(raw);
    // Uppmärksamhet varieras oberoende av traktion — det är just den
    // frikopplingen som gör att kvadranten blir meningsfull.
    const loud = base.symbol === 'EXIT' || base.symbol === 'CROWD';
    const context = {
      boostUsd: loud ? 200 + rnd() * 900 : rnd() < 0.25 ? rnd() * 120 : 0,
      socialCount: loud ? 4 + Math.floor(rnd() * 3) : Math.floor(rnd() * 2),
      volume1h: (token.liquidityUsd ?? 30_000) * (loud ? 4 + rnd() * 8 : rnd() * 2),
      liquidityUsd: token.liquidityUsd,
    };

    const { gap } = attentionGap(token, context);
    decisions.push(decide(token, context, priorFor(gap, calibration)));
  }
  return decisions;
}

// En påhittad men realistisk kalibreringshistorik, så att panelen visar både
// en hink med underlag och en som ännu tiger.
const calibration = buildCalibration([
  ...Array.from({ length: 18 }, (_, i) => ({
    bucket: 'gap_40_55', quadrant: 'early', marks: [i % 3 === 0 ? 0.42 : -0.18, i % 4 === 0 ? 1.6 : -0.31],
  })),
  ...Array.from({ length: 7 }, () => ({ bucket: 'gap_55_plus', quadrant: 'early', marks: [0.3, 0.9] })),
]);

const board = buildBoard();
const rank = { BUY: 0, WATCH: 1, SKIP: 2, AVOID: 3 };
board.sort((a, b) => rank[a.verdict] - rank[b.verdict] || b.edge.gap - a.edge.gap);

const counters = {
  tokensSeen: board.length,
  gateFailed: board.filter((d) => d.verdict === 'AVOID' && !d.safety.passed).length,
  exitLiquidity: board.filter((d) => d.edge.quadrant === 'exit_liquidity').length,
  watch: board.filter((d) => d.verdict === 'WATCH').length,
  buy: board.filter((d) => d.verdict === 'BUY').length,
};

// Journalsiffror från en påhittad men ärligt formad historik: låg träffprocent,
// negativ median, positiv förväntan buren av svansen.
const journal = {
  strategy: {
    group: 'strategy', n: 34,
    horizons: [
      { label: '15m', n: 34, winRate: 0.44, median: -0.04, mean: 0.21, best: 3.1, worst: -0.42 },
      { label: '1h', n: 31, winRate: 0.29, median: -0.22, mean: 0.34, best: 8.4, worst: -0.78 },
      { label: '4h', n: 26, winRate: 0.27, median: -0.38, mean: 0.19, best: 11.2, worst: -0.93 },
      { label: '24h', n: 18, winRate: 0.22, median: -0.55, mean: 0.08, best: 9.7, worst: -0.97 },
    ],
  },
  control: {
    group: 'control', n: 21,
    horizons: [
      { label: '15m', n: 21, winRate: 0.19, median: -0.13, mean: -0.14, best: 0.6, worst: -0.61 },
      { label: '1h', n: 19, winRate: 0.11, median: -0.34, mean: -0.29, best: 0.4, worst: -0.88 },
      { label: '4h', n: 16, winRate: 0.06, median: -0.61, mean: -0.48, best: 0.2, worst: -0.98 },
      { label: '24h', n: 12, winRate: 0.08, median: -0.74, mean: -0.55, best: 0.3, worst: -0.99 },
    ],
  },
};

const engine = {
  mode: 'preview',
  board: () => board.map(serialize),
  stats: () => ({ counters, journal, calibration, openPositions: 12, lastError: null }),
};

function serialize(d) {
  const { raw, ...token } = d.token;
  return { ...d, token };
}

const { server } = createServer(engine, { ...config, live: liveConfig });
server.listen(config.server.port, config.server.host, () => {
  console.log(`Preview (inspelad data, riktig beslutslogik) — http://${config.server.host}:${config.server.port}`);
  console.log(`${counters.buy} köp, ${counters.watch} bevakas, ${counters.exitLiquidity} exit-likviditet, ${counters.gateFailed} fällda av grindar`);
});
