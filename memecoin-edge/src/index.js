/**
 * Startpunkt. Två lägen:
 *
 *   npm start        live mot riktiga, nyckelfria API:er
 *   npm run sim      simulatorn, för att testa logiken utan nät
 */
import { config, liveConfig } from './config.js';
import { createServer } from './server.js';
import { LiveEngine } from './live.js';
import { Pipeline } from './pipeline.js';
import { createSource } from './ingest/index.js';

const mode = process.env.MODE ?? 'live';

if (mode === 'sim') {
  startSimulation();
} else {
  startLive();
}

function startLive() {
  const engine = new LiveEngine({
    onBuy: (d) => {
      broadcast('buy', d);
      console.log(
        `\x1b[32m[KÖP]\x1b[0m ${d.token.symbol.padEnd(12)} gap ${d.edge.gap.toFixed(0).padStart(3)}` +
          `  traktion ${d.edge.traction.score.toFixed(0)}  uppmärksamhet ${d.edge.attention.score.toFixed(0)}` +
          `  storlek $${d.plan.sizeUsd}  (${d.plan.conviction})`,
      );
      console.log(`       ${d.headline}`);
    },
    onDecision: () => scheduleBoard(),
    onError: (err, source) => console.error(`\x1b[31m[fel]\x1b[0m ${source}: ${err.message}`),
  });

  const { server, broadcast } = createServer(
    { board: () => engine.board(), stats: () => engine.stats(), mode: 'live' },
    { ...config, live: liveConfig },
  );

  // Beslutstavlan skickas på egen takt. Ett svar från Jupiter kan innehålla
  // hundra tokens, och en sändning per token gör klienten oanvändbar.
  let boardTimer = null;
  const scheduleBoard = () => {
    if (boardTimer) return;
    boardTimer = setTimeout(() => {
      boardTimer = null;
      broadcast('board', { board: engine.board(), stats: engine.stats() });
    }, 1000);
  };

  engine.start();
  server.listen(config.server.port, config.server.host, () => {
    console.log('\nmemecoin-edge — live mot Jupiter + DexScreener (ingen API-nyckel)');
    console.log(`Öppna http://${config.server.host}:${config.server.port}`);
    console.log(`Journal: ${liveConfig.journal.dir}journal.ndjson\n`);
  });

  onShutdown(() => {
    engine.stop();
    server.close(() => process.exit(0));
  });
}

function startSimulation() {
  const source = createSource({ ...config, source: 'mock' });
  const pipeline = new Pipeline(config, {
    onAlert: (c) => {
      broadcast('buy', simToDecision(c));
      console.log(`[SIM-LARM] ${c.meta.symbol} momentum ${c.momentum.score.toFixed(0)}`);
    },
  });

  const { server, broadcast } = createServer(
    {
      board: () => pipeline.candidates().map(simToDecision),
      stats: () => ({ counters: pipeline.counters, journal: pipeline.ledger.stats(), calibration: {} }),
      mode: 'sim',
    },
    config,
  );

  let lastPush = 0;
  source.start({
    onToken: (m, t) => pipeline.onToken(m, t),
    onTrade: (t) => pipeline.onTrade(t),
    onTick: (now) => {
      pipeline.evict(now);
      if (now - lastPush > 2000) {
        lastPush = now;
        broadcast('board', {
          board: pipeline.candidates().map(simToDecision),
          stats: { counters: pipeline.counters, journal: pipeline.ledger.stats(), calibration: {} },
        });
      }
    },
  });

  server.listen(config.server.port, config.server.host, () => {
    console.log(`memecoin-edge — SIMULERING. Öppna http://${config.server.host}:${config.server.port}`);
  });

  onShutdown(() => {
    source.stop();
    server.close(() => process.exit(0));
  });
}

/** Klär simulatorns kandidater i beslutsformen så att gränssnittet blir ett. */
function simToDecision(c) {
  return {
    verdict: c.alerted ? 'BUY' : 'WATCH',
    headline: c.alerted ? 'Simulerat larm' : 'Under tröskel',
    reasons: c.momentum.factors.slice(0, 3).map((f) => f.detail),
    plan: c.alerted
      ? {
          conviction: 'medel',
          sizeUsd: 0,
          entry: { type: 'simulering', note: 'Ingen riktig data.', priceUsd: c.priceUsd },
          invalidation: ['Simulerat läge — inga verkliga ogiltighetsvillkor'],
          exit: { ladder: [], hardStopPct: 35, timeStop: '—' },
        }
      : null,
    edge: {
      gap: Math.round(c.momentum.score - c.safety.riskScore),
      quadrant: c.alerted ? 'early' : 'quiet',
      quadrantLabel: c.alerted ? 'Simulerad tidig traktion' : 'Simulerad, under tröskel',
      traction: { score: c.momentum.score, factors: c.momentum.factors },
      attention: { score: c.safety.riskScore, factors: c.safety.riskFactors },
    },
    safety: { passed: c.safety.passed, failed: [] },
    reputation: null,
    token: {
      address: c.meta.address,
      symbol: c.meta.symbol,
      name: c.meta.symbol,
      priceUsd: c.priceUsd,
      liquidityUsd: c.meta.lpUsd,
      holderCount: null,
      organicScore: null,
      createdAt: c.meta.createdAt,
    },
  };
}

function onShutdown(fn) {
  process.on('SIGINT', fn);
  process.on('SIGTERM', fn);
}
