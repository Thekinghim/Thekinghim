import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeToken } from '../src/sources/jupiter.js';
import { tractionScore, attentionScore, attentionGap } from '../src/edge/attention.js';
import { evaluateSolanaGates } from '../src/edge/gates.js';
import { decide, decisionConfig } from '../src/edge/decision.js';

const raw = JSON.parse(fs.readFileSync(new URL('./fixtures/jupiter-recent.json', import.meta.url)));
const bySymbol = Object.fromEntries(raw.map((r) => [r.symbol, normalizeToken(r)]));

/** Håller åldersberoende komponenter stabila mellan körningar. */
const freshen = (t, minutesOld) => ({ ...t, createdAt: Date.now() - minutesOld * 60_000 });

test('normalisering skiljer saknat värde från noll', () => {
  const unknown = bySymbol.UNKNOWN;
  assert.equal(unknown.topHolderPct, null, 'saknad audit ska ge null, inte 0');
  assert.equal(unknown.stats5m.numOrganicBuyers, null);
  assert.equal(unknown.mintAuthorityActive, true, 'saknat audit-fält ska räknas som ej återkallad');

  const early = bySymbol.EARLY;
  assert.equal(early.mintAuthorityActive, false);
  assert.equal(early.topHolderPct, 21.4);
  assert.equal(early.stats5m.numOrganicBuyers, 38);
});

test('grindarna fäller mint authority, saknad data och tunn likviditet', () => {
  assert.equal(evaluateSolanaGates(bySymbol.EARLY).passed, true);

  const mintOpen = evaluateSolanaGates(bySymbol.RUGME);
  assert.equal(mintOpen.passed, false);
  assert.ok(mintOpen.failed.some((g) => g.id === 'mint_authority'));

  const missing = evaluateSolanaGates(bySymbol.UNKNOWN);
  assert.equal(missing.passed, false, 'saknad data ska aldrig passera');
  const ids = missing.failed.map((g) => g.id);
  assert.ok(ids.includes('holder_data'), `väntade holder_data, fick ${ids.join(',')}`);
  assert.ok(ids.includes('stats_data'));

  const thin = evaluateSolanaGates({ ...bySymbol.EARLY, liquidityUsd: 3000 });
  assert.ok(thin.failed.some((g) => g.id === 'liquidity_floor'));
});

test('traktion mäter organiska köpare, inte volym', () => {
  const early = tractionScore(bySymbol.EARLY).score;
  const exit = tractionScore(bySymbol.EXIT).score;

  // EXIT har fyra gånger EARLY:s köpvolym men nästan inga organiska köpare.
  assert.ok(bySymbol.EXIT.stats1h.buyVolume > bySymbol.EARLY.stats1h.buyVolume * 4);
  assert.ok(early > exit + 30, `volym ska inte slå organiska köpare: ${early} mot ${exit}`);
});

test('uppmärksamhet stiger med betalda boosts och profil', () => {
  const quiet = attentionScore(freshen(bySymbol.EARLY, 30), { boostUsd: 0, socialCount: 0 }).score;
  const loud = attentionScore(freshen(bySymbol.EARLY, 30), {
    boostUsd: 500, socialCount: 5, volume1h: 400_000, liquidityUsd: 40_000,
  }).score;
  assert.ok(loud > quiet + 40, `boosts ska väga tungt: ${quiet} → ${loud}`);
});

test('de fyra rutorna klassas rätt', () => {
  const early = attentionGap(freshen(bySymbol.EARLY, 25), { boostUsd: 0, socialCount: 0, liquidityUsd: 38_000 });
  assert.equal(early.quadrant, 'early');
  assert.ok(early.gap > 25);

  const exitLiq = attentionGap(freshen(bySymbol.EXIT, 180), {
    boostUsd: 800, socialCount: 6, volume1h: 900_000, liquidityUsd: 61_000,
  });
  assert.equal(exitLiq.quadrant, 'exit_liquidity');
  assert.ok(exitLiq.gap < 0, 'exit-likviditet ska ge negativt gap');

  const crowded = attentionGap(freshen(bySymbol.CROWD, 300), {
    boostUsd: 600, socialCount: 5, volume1h: 800_000, liquidityUsd: 320_000,
  });
  assert.equal(crowded.quadrant, 'crowded');
});

test('beslut: tidig token ger KÖP med komplett plan', () => {
  const d = decide(freshen(bySymbol.EARLY, 25), { boostUsd: 0, socialCount: 0, liquidityUsd: 38_000 });
  assert.equal(d.verdict, 'BUY');
  assert.ok(d.plan, 'ett köpbeslut utan plan är ingen rekommendation');
  assert.ok(d.plan.sizeUsd > 0);
  assert.ok(d.plan.invalidation.length >= 3, 'måste säga vad som gör tesen fel');
  assert.equal(d.plan.exit.ladder.length, 3);
  assert.equal(d.plan.exit.hardStopPct, decisionConfig.stopLossPct);

  // Positionen får aldrig vara större än en bråkdel av poolen.
  assert.ok(d.plan.sizeUsd <= 38_000 * 0.005 + 1);
});

test('beslut: betald synlighet utan organiska köpare avvisas aktivt', () => {
  const d = decide(freshen(bySymbol.EXIT, 180), {
    boostUsd: 800, socialCount: 6, volume1h: 900_000, liquidityUsd: 61_000,
  });
  assert.equal(d.verdict, 'AVOID');
  assert.match(d.headline, /utgången|synlighet/i);
  assert.equal(d.plan, null);
});

test('beslut: en token som fäller en grind får aldrig en plan', () => {
  const d = decide(freshen(bySymbol.RUGME, 5), { boostUsd: 0, socialCount: 0, liquidityUsd: 44_000 });
  assert.equal(d.verdict, 'AVOID');
  assert.equal(d.plan, null);
  assert.match(d.headline, /Mint authority/);
});

test('beslut: sen token blir bevakning, inte köp', () => {
  const d = decide(freshen(bySymbol.CROWD, 300), {
    boostUsd: 600, socialCount: 5, volume1h: 800_000, liquidityUsd: 320_000,
  });
  assert.notEqual(d.verdict, 'BUY');
  assert.equal(d.plan, null);
});

test('konviktion höjs av en positiv prior men kan inte öppna en stängd grind', () => {
  const context = { boostUsd: 0, socialCount: 0, liquidityUsd: 38_000 };
  const neutral = decide(freshen(bySymbol.EARLY, 25), context, null);
  const boosted = decide(freshen(bySymbol.EARLY, 25), context, { score: 15, note: 'test' });
  const order = { låg: 0, medel: 1, hög: 2 };
  assert.ok(order[boosted.plan.conviction] >= order[neutral.plan.conviction]);

  // En stark historik ska inte kunna handla en token med öppen mint authority.
  const gated = decide(freshen(bySymbol.RUGME, 5), context, { score: 15, note: 'test' });
  assert.equal(gated.verdict, 'AVOID');
});
