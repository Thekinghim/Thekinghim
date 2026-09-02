import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TokenWindow } from '../src/engine/windows.js';
import { Radar } from '../src/engine/radar.js';
import { EventStore } from '../src/store/event-store.js';
import { CreatorRegistry } from '../src/engine/creators.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rl-'));
const t0 = 1_700_000_000_000;
const trade = (o = {}) => ({ ts: t0, side: 'buy', sol: 1, wallet: 'w1', marketCapSol: 30, ...o });

test('fönstret räknar unika köpare och rullar ut gamla affärer', () => {
  const w = new TokenWindow('m', 60_000);
  for (let i = 0; i < 6; i++) w.add(trade({ ts: t0 + i * 1000, wallet: `w${i}` }));
  assert.equal(w.metrics(t0 + 6000).uniqueBuyers, 6);

  w.add(trade({ ts: t0 + 300_000, wallet: 'sen' }));
  assert.equal(w.metrics(t0 + 300_000).uniqueBuyers, 1, 'gamla affärer ska ha rullat ut');
  assert.equal(w.totalTrades, 7, 'totalen räknar allt');
});

test('en wallet som säljer ut hela positionen räknas inte som innehavare', () => {
  const w = new TokenWindow('m', 60_000);
  w.add(trade({ wallet: 'a', sol: 2 }));
  w.add(trade({ ts: t0 + 100, wallet: 'b', sol: 1 }));
  assert.equal(w.metrics(t0 + 100).holders, 2);
  w.add(trade({ ts: t0 + 200, wallet: 'a', side: 'sell', sol: 2 }));
  assert.equal(w.metrics(t0 + 200).holders, 1);
  assert.equal(w.earlyBuyersExited(), 1);
});

test('wash trading från en wallet ger inga unika köpare', () => {
  const w = new TokenWindow('m', 60_000);
  for (let i = 0; i < 60; i++) {
    w.add(trade({ ts: t0 + i * 500, wallet: 'whale', side: i % 2 ? 'sell' : 'buy', sol: 5 }));
  }
  const m = w.metrics(t0 + 30_000);
  assert.equal(m.uniqueBuyers, 1, 'volym utan bredd ska inte bli köpare');
  assert.equal(m.largestBuyShare > 0, true);
});

test('radarn kvalificerar först vid tillräckligt många unika köpare och nettoinflöde', () => {
  const qualified = [];
  const r = new Radar({ onQualified: (e) => qualified.push(e.mint) });
  r.onLaunch({ mint: 'm1', symbol: 'AAA', traderPublicKey: 'dev', initialBuy: 100, vTokensInBondingCurve: 900 });

  for (let i = 0; i < 7; i++) r.onTrade({ mint: 'm1', txType: 'buy', solAmount: 0.5, traderPublicKey: `b${i}` });
  assert.equal(qualified.length, 0, 'sju köpare ska inte räcka');

  r.onTrade({ mint: 'm1', txType: 'buy', solAmount: 0.5, traderPublicKey: 'b7' });
  assert.deepEqual(qualified, ['m1']);
});

test('köpare utan nettoinflöde kvalificerar inte', () => {
  const qualified = [];
  const r = new Radar({ onQualified: (e) => qualified.push(e.mint) });
  r.onLaunch({ mint: 'm2', symbol: 'BBB' });
  // Säljtrycket kommer först, så nettot är negativt när köparna räknas ihop.
  r.onTrade({ mint: 'm2', txType: 'sell', solAmount: 50, traderPublicKey: 'dump' });
  for (let i = 0; i < 12; i++) r.onTrade({ mint: 'm2', txType: 'buy', solAmount: 0.1, traderPublicKey: `b${i}` });
  assert.equal(qualified.length, 0, 'brett köptryck utan nettoinflöde ska inte räcka');
});

test('en kvalificerad token vars flöde vänder flaggas', () => {
  const r = new Radar();
  r.onLaunch({ mint: 'm3', symbol: 'CCC' });
  for (let i = 0; i < 10; i++) r.onTrade({ mint: 'm3', txType: 'buy', solAmount: 1, traderPublicKey: `b${i}` });
  assert.equal(r.board()[0].qualified, true);
  assert.equal(r.board()[0].flowReversed, false);

  r.onTrade({ mint: 'm3', txType: 'sell', solAmount: 40, traderPublicKey: 'b0' });
  const row = r.board()[0];
  // Kvalificeringen står kvar — anropen är spenderade — men vändningen syns.
  assert.equal(row.qualified, true);
  assert.equal(row.flowReversed, true, 'ett vänt flöde måste synas i gränssnittet');
});

test('dev-andelen är null när fälten saknas, inte noll', () => {
  const r = new Radar();
  const withData = r.onLaunch({ mint: 'a', initialBuy: 200, vTokensInBondingCurve: 800 });
  assert.equal(Radar.creatorOpeningShare(withData), 20);

  const without = r.onLaunch({ mint: 'b' });
  assert.equal(Radar.creatorOpeningShare(without), null, 'okänt får inte bli 0 %');
});

test('evict släpper gamla tokens och rapporterar vilka som spårades', () => {
  const r = new Radar();
  const e = r.onLaunch({ mint: 'old', symbol: 'O' });
  e.tracking = true;
  assert.deepEqual(r.evict(Date.now() + 60 * 60_000), ['old']);
  assert.equal(r.tokens.size, 0);
});

test('händelselagret dedupliceras på signatur och kan spelas upp', () => {
  const dir = tmp();
  const s = new EventStore({ dir });
  assert.equal(s.append('launch', { mint: 'a', signature: 'sig1' }), true);
  assert.equal(s.append('launch', { mint: 'a', signature: 'sig1' }), false, 'dubblett ska avvisas');
  assert.equal(s.append('trade', { mint: 'a', signature: 'sig2' }), true);
  s.close();

  const replayed = [...new EventStore({ dir }).replay()];
  assert.equal(replayed.length, 2);
  assert.equal(replayed[0].kind, 'launch');
  assert.equal(replayed[0].raw.signature, 'sig1');
});

test('creator-registret är punkt-i-tiden-korrekt', () => {
  const reg = new CreatorRegistry({ dir: tmp() });
  const now = Date.now();
  reg.recordLaunch({ mint: 'x', creator: 'dev', symbol: 'X', name: 'X', ts: now - 20 * 3600_000 });
  reg.recordGraduation('x', now - 19 * 3600_000);

  // Uppslag före graduationen får inte se den.
  const before = reg.reputationAt('dev', now - 20 * 3600_000 + 1000);
  assert.equal(before.graduations, 0, 'ett framtida utfall får inte läcka bakåt');

  const after = reg.reputationAt('dev', now);
  assert.equal(after.settledLaunches, 1);
  assert.equal(after.graduations, 1);
});

test('en launch som ännu kan gradera räknas varken som lyckad eller misslyckad', () => {
  const reg = new CreatorRegistry({ dir: tmp() });
  const now = Date.now();
  reg.recordLaunch({ mint: 'fresh', creator: 'dev', ts: now - 60_000 });
  const rep = reg.reputationAt('dev', now);
  assert.equal(rep.settledLaunches, 0, 'en färsk launch är inte avgjord');
  assert.equal(rep.known, false);
  assert.equal(rep.launchesLast24h, 1);
});
