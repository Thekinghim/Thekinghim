import test from 'node:test';
import assert from 'node:assert/strict';
import { PaperLedger } from '../src/paper/ledger.js';

const cfg = {
  paper: { horizons: [60_000, 300_000], horizonLabels: ['1m', '5m'], roundTripCostPct: 2 },
};

const meta = (address, symbol = 'X') => ({ address, symbol });
const t0 = 1_700_000_000_000;

test('avkastningen redovisas netto efter handelskostnad', () => {
  const l = new PaperLedger(cfg);
  l.open('strategy', meta('a'), 1, t0);
  l.mark('a', 1, t0 + 61_000); // oförändrat pris
  // Priset är samma men rundturskostnaden är betald: resultatet ska vara negativt.
  assert.ok(Math.abs(l.positions.get('a').marks[0] - -0.02) < 1e-9);
});

test('en horisont stämplas bara en gång, av första observationen efter tiden', () => {
  const l = new PaperLedger(cfg);
  l.open('strategy', meta('a'), 1, t0);
  l.mark('a', 2, t0 + 61_000);
  l.mark('a', 5, t0 + 120_000);
  assert.ok(Math.abs(l.positions.get('a').marks[0] - 0.96) < 1e-9, 'första marken ska stå kvar');
});

test('positioner öppnas inte två gånger och inte till noll i pris', () => {
  const l = new PaperLedger(cfg);
  l.open('strategy', meta('a'), 1, t0);
  l.open('control', meta('a'), 99, t0 + 1000);
  assert.equal(l.positions.size, 1);
  assert.equal(l.positions.get('a').group, 'strategy');

  l.open('strategy', meta('b'), 0, t0);
  assert.equal(l.positions.size, 1, 'ett entrypris på noll ska avvisas, inte ge Infinity');
});

test('settle fyller horisonter som aldrig hann stämplas', () => {
  const l = new PaperLedger(cfg);
  l.open('strategy', meta('a'), 1, t0);
  l.mark('a', 3, t0 + 10_000);
  assert.equal(l.positions.get('a').marks[1], null);
  l.settle();
  assert.ok(l.positions.get('a').marks[1] !== null);
});

test('statistiken skiljer strategi från kontrollgrupp', () => {
  const l = new PaperLedger(cfg);
  l.open('strategy', meta('win'), 1, t0, { isTrap: false });
  l.open('control', meta('lose'), 1, t0, { isTrap: true });
  l.mark('win', 3, t0 + 61_000);
  l.mark('lose', 0.1, t0 + 61_000);
  l.settle();

  const s = l.stats();
  assert.equal(s.strategy.n, 1);
  assert.equal(s.control.n, 1);
  assert.equal(s.strategy.horizons[0].winRate, 1);
  assert.equal(s.control.horizons[0].winRate, 0);
  assert.equal(s.control.trapRate, 1);
  assert.ok(s.control.worstDrawdown < -0.8);
});

test('tom bok ger nollor, inte NaN', () => {
  const s = new PaperLedger(cfg).stats();
  for (const group of [s.strategy, s.control]) {
    assert.equal(group.n, 0);
    assert.equal(group.trapRate, 0);
    for (const h of group.horizons) {
      assert.ok(Number.isFinite(h.median) && Number.isFinite(h.mean) && Number.isFinite(h.winRate));
    }
  }
});
