import { createMockSource } from './mock.js';
import { createSolanaSource } from './solana.js';
import { createEvmSource } from './evm.js';

/**
 * Väljer ingest-källa. Alla källor har samma kontrakt:
 * `start({onToken, onTrade, onTick})` och `stop()`.
 *
 * Att mock-källan följer exakt samma kontrakt som on-chain-källorna är
 * avsiktligt — det är därför backtestet testar samma kodväg som körs live.
 *
 * @param {typeof import('../config.js').config} cfg
 */
export function createSource(cfg) {
  switch (cfg.source) {
    case 'solana':
      return createSolanaSource(cfg);
    case 'evm':
      return createEvmSource(cfg);
    case 'mock':
      return createMockSource({ speed: Number(process.env.SPEED ?? 12) });
    default:
      throw new Error(`Okänd källa "${cfg.source}". Använd mock, solana eller evm.`);
  }
}
