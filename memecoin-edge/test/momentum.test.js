import test from 'node:test';
import assert from 'node:assert/strict';
import { TradeWindow } from '../src/scoring/window.js';
import { scoreMomentum } from '../src/scoring/momentum.js';
import { config } from '../src/config.js';

const t0 = 1_700_000_000_000;

function trade(over = {}) {
  return {
    token: 'tok', ts: t0, side: 'buy', amountUsd: 100, priceUsd: 1,
    wallet: 'w1', walletAgeHours: 100, smartMoney: false, ...over,
  };
}

test('fönstret räknar unika köpare och släpper gamla affärer', () => {
  const w = new TradeWindow('tok', 60_000);
  for (let i = 0; i < 5; i++) w.add(trade({ ts: t0 + i * 1000, wallet: `w${i}` }));
  assert.equal(w.metrics(t0 + 5000).uniqueBuyers, 5);

  // En affär långt senare ska rulla ut alla de tidigare ur fönstret.
  w.add(trade({ ts: t0 + 200_000, wallet: 'late' }));
  assert.equal(w.metrics(t0 + 200_000).uniqueBuyers, 1);
  assert.equal(w.totalTrades, 6, 'totalen ska räkna allt, inte bara fönstret');
});

test('innehavarantalet minskar när en wallet säljer ut hela sin position', () => {
  const w = new TradeWindow('tok', 60_000);
  w.add(trade({ ts: t0, wallet: 'a', amountUsd: 100 }));
  w.add(trade({ ts: t0 + 1000, wallet: 'b', amountUsd: 100 }));
  assert.equal(w.holderCount, 2);
  w.add(trade({ ts: t0 + 2000, wallet: 'a', side: 'sell', amountUsd: 100 }));
  assert.equal(w.holderCount, 1);
});

test('wash trading från en enda wallet ger inte momentum', () => {
  const w = new TradeWindow('tok', 60_000);
  // 200 affärer, enorm volym, men bara en motpart.
  for (let i = 0; i < 200; i++) {
    w.add(trade({ ts: t0 + i * 200, wallet: 'whale', side: i % 2 ? 'sell' : 'buy', amountUsd: 5000 }));
  }
  const score = scoreMomentum(w.metrics(t0 + 40_000), config).score;
  assert.ok(score < config.momentum.minScore, `wash trading fick ${score}, ska ligga under tröskeln`);
});

test('brett organiskt köptryck ger momentum över tröskeln', () => {
  const w = new TradeWindow('tok', config.momentum.windowMs);
  let ts = t0;
  for (let i = 0; i < 90; i++) {
    ts += 1200;
    w.add(trade({ ts, wallet: `buyer${i}`, amountUsd: 150 + (i % 7) * 30, smartMoney: i % 25 === 0 }));
    if (i % 6 === 0) w.add(trade({ ts: ts + 200, wallet: `buyer${i - 3}`, side: 'sell', amountUsd: 120 }));
  }
  const score = scoreMomentum(w.metrics(ts), config).score;
  assert.ok(score >= config.momentum.minScore, `organiskt flöde fick bara ${score}`);
});

test('nettoutflöde nollar accelerationskomponenten', () => {
  const m = {
    uniqueBuyers: 3, uniqueSellers: 20, uniqueBuyersPerMin: 1, buyerSellerRatio: 0.15,
    netFlowUsd: -5000, netFlowRecent: -3000, netFlowEarlier: -2000, smartMoneyBuyers: 0,
    largestBuyShare: 0.9, holderCount: 10, holderGrowthPerMin: -2, freshWalletBuyerRate: 0.5,
    tradeCount: 23, totalTrades: 23, priceUsd: 1,
  };
  const v = scoreMomentum(m, config);
  const accel = v.factors.find((f) => f.id === 'netInflowAcceleration');
  assert.equal(accel.points, 0);
  assert.ok(v.score < 30, `säljflöde ska ge låg poäng, fick ${v.score}`);
});

test('poängen håller sig inom 0–100', () => {
  const w = new TradeWindow('tok', config.momentum.windowMs);
  for (let i = 0; i < 500; i++) {
    w.add(trade({ ts: t0 + i * 50, wallet: `w${i}`, amountUsd: 300, smartMoney: true }));
  }
  const score = scoreMomentum(w.metrics(t0 + 25_000), config).score;
  assert.ok(score >= 0 && score <= 100, `utanför intervallet: ${score}`);
});
