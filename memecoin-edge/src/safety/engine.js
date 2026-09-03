import { gates, riskFactors } from './rules.js';
import { config as defaultConfig } from '../config.js';

/** @typedef {import('../types.js').TokenMeta} TokenMeta */
/** @typedef {import('../types.js').SafetyVerdict} SafetyVerdict */

/**
 * Kör alla hårda grindar och summerar mjuk risk.
 *
 * @param {TokenMeta} meta
 * @param {{freshWalletBuyerRate: number, holderCount: number}} ctx
 * @param {typeof defaultConfig} [cfg]
 * @returns {SafetyVerdict}
 */
export function evaluateSafety(meta, ctx, cfg = defaultConfig) {
  const results = gates.map((g) => g.check(meta, cfg));
  const passed = results.every((r) => r.passed);

  const factors = riskFactors.map((f) => {
    const weight = cfg.risk.weights[f.weightKey] ?? 0;
    return {
      id: f.id,
      points: Math.round(f.score(meta, ctx) * weight * 10) / 10,
      detail: f.detail(meta, ctx),
    };
  });

  const total = factors.reduce((sum, f) => sum + f.points, 0);
  const maxPossible = Object.values(cfg.risk.weights).reduce((a, b) => a + b, 0);

  return {
    passed,
    gates: results,
    // Normalisera till 0–100 så att tröskeln i config betyder samma sak
    // även om man ändrar vikterna.
    riskScore: Math.round((total / maxPossible) * 1000) / 10,
    riskFactors: factors,
  };
}

/** Bekvämlighet: bara de grindar som fällde. */
export function failedGates(verdict) {
  return verdict.gates.filter((g) => !g.passed);
}
