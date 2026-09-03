import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSafety } from '../src/safety/engine.js';
import { config } from '../src/config.js';

/** En token som klarar allt. Varje test muterar ett fält från den här basen. */
const clean = () => ({
  address: 'tok', symbol: 'CLEAN', chain: 'solana', createdAt: Date.now(),
  mintAuthorityActive: false, freezeAuthorityActive: false,
  metadataMutable: false, upgradeableContract: false,
  lpLockedPct: 95, lpUsd: 25_000, buyTaxBps: 0, sellTaxBps: 0,
  sellSimulationOk: true, topHolderPct: 20, devHoldingPct: 1,
  bundledLaunchPct: 2, deployer: 'dev', deployerFlagged: false,
});

const ctx = { freshWalletBuyerRate: 0.2, holderCount: 300 };

test('en ren token klarar samtliga grindar', () => {
  const v = evaluateSafety(clean(), ctx, config);
  assert.equal(v.passed, true);
  assert.ok(v.riskScore < 20, `riskpoängen ska vara låg, var ${v.riskScore}`);
});

test('varje hård grind fäller sitt eget fel', () => {
  const cases = [
    ['mint_authority', { mintAuthorityActive: true }],
    ['freeze_authority', { freezeAuthorityActive: true }],
    ['lp_locked', { lpLockedPct: 10 }],
    ['sell_simulation', { sellSimulationOk: false }],
    ['tax', { sellTaxBps: 3000 }],
    ['immutable', { upgradeableContract: true }],
    ['immutable', { metadataMutable: true }],
    ['liquidity_floor', { lpUsd: 500 }],
    ['deployer_history', { deployerFlagged: true }],
  ];

  for (const [gateId, patch] of cases) {
    const v = evaluateSafety({ ...clean(), ...patch }, ctx, config);
    assert.equal(v.passed, false, `${gateId} borde ha fällt ${JSON.stringify(patch)}`);
    const failed = v.gates.filter((g) => !g.passed).map((g) => g.id);
    assert.ok(failed.includes(gateId), `väntade utslag på ${gateId}, fick ${failed.join(',')}`);
  }
});

test('riskpoängen stiger med koncentration och dev-innehav', () => {
  const low = evaluateSafety(clean(), ctx, config).riskScore;
  const high = evaluateSafety(
    { ...clean(), topHolderPct: 75, devHoldingPct: 15, bundledLaunchPct: 35 },
    { freshWalletBuyerRate: 0.8, holderCount: 20 },
    config,
  ).riskScore;
  assert.ok(high > low + 30, `väntade tydligt högre risk, fick ${low} → ${high}`);
  assert.ok(high > config.risk.maxScore, 'en bundlad launch ska hamna över tröskeln');
});

test('riskpoängen håller sig inom 0–100', () => {
  const worst = evaluateSafety(
    { ...clean(), topHolderPct: 100, devHoldingPct: 100, bundledLaunchPct: 100, lpUsd: 1 },
    { freshWalletBuyerRate: 1, holderCount: 0 },
    config,
  );
  assert.ok(worst.riskScore <= 100 && worst.riskScore >= 0, `utanför intervallet: ${worst.riskScore}`);
});
