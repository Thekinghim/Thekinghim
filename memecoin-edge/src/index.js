import { config } from './config.js';
import { Pipeline } from './pipeline.js';
import { createServer } from './server.js';
import { createSource } from './ingest/index.js';

const source = createSource(config);

const pipeline = new Pipeline(config, {
  onAlert: (candidate) => {
    broadcast('alert', candidate);
    const { symbol } = candidate.meta;
    console.log(
      `[LARM] ${symbol.padEnd(10)} momentum ${candidate.momentum.score.toFixed(0)}` +
        `  risk ${candidate.safety.riskScore.toFixed(0)}  ålder ${candidate.ageMinutes.toFixed(1)} min`,
    );
  },
  onUpdate: (candidate) => broadcast('candidate', candidate),
});

const { server, broadcast } = createServer(pipeline, config);

let lastStats = 0;
source.start({
  onToken: (meta, truth) => pipeline.onToken(meta, truth),
  onTrade: (trade) => pipeline.onTrade(trade),
  onTick: (now) => {
    pipeline.evict(now);
    // Statistik är dyrare att räkna ut än en kandidatuppdatering, så den
    // skickas på egen takt istället för vid varje handel.
    if (now - lastStats > 5_000) {
      lastStats = now;
      broadcast('stats', pipeline.stats());
    }
  },
});

server.listen(config.server.port, config.server.host, () => {
  console.log(`memecoin-edge — källa "${source.name}"`);
  console.log(`Öppna http://${config.server.host}:${config.server.port}`);
  if (config.source === 'mock') {
    console.log('Simulerad data. Sätt SOURCE=solana eller SOURCE=evm för riktig on-chain-data.');
  }
});

const shutdown = () => {
  source.stop();
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
