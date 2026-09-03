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
  const out = r.evict(Date.now() + 60 * 60_000);
  assert.deepEqual(out.release, ['old']);
  assert.deepEqual(out.drop, ['old']);
  assert.equal(r.tokens.size, 0);
});

test('probe-fönstret släpper prenumerationen men behåller raden', () => {
  const r = new Radar();
  const e = r.onLaunch({ mint: 'quiet', symbol: 'Q' });
  e.tracking = true;

  // Utan traktion inom probe-fönstret ska vi sluta lyssna — men token ska
  // finnas kvar i radarn tills hela fönstret gått ut.
  const out = r.evict(Date.now() + 120_000);
  assert.deepEqual(out.release, ['quiet']);
  assert.deepEqual(out.drop, []);
  assert.equal(r.tokens.size, 1);
  assert.equal(r.board()[0].probeExpired, true);
});

test('en kvalificerad token behåller sin prenumeration förbi probe-fönstret', () => {
  const r = new Radar();
  const e = r.onLaunch({ mint: 'hot', symbol: 'H' });
  e.tracking = true;
  for (let i = 0; i < 10; i++) r.onTrade({ mint: 'hot', txType: 'buy', solAmount: 1, traderPublicKey: `b${i}` });
  assert.equal(e.qualified, true);
  assert.deepEqual(r.evict(Date.now() + 120_000).release, []);
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

/* ---------- omdömet ---------- */
import { verdictFor } from '../src/engine/verdict.js';

const row = (o = {}) => ({
  qualified: true, tracking: true, probeExpired: false, flowReversed: false,
  earlyExits: 0, curveProgress: 0.3, creatorOpeningShare: 3,
  preflight: { state: 'pass', checks: { authority: { state: 'pass', detail: 'ok' } } },
  holders: { unknown: false, topHolderPct: 30 },
  metrics: { uniqueBuyers: 20, uniqueSellers: 4, netSol: 5, totalTrades: 40, largestBuyShare: 0.2 },
  ...o,
});

test('KÖP kräver att allt är känt och över tröskel', () => {
  assert.equal(verdictFor(row()).verdict, 'KÖP');
});

test('okänd data ger VÄNTA, aldrig KÖP', () => {
  assert.equal(verdictFor(row({ preflight: null })).verdict, 'VÄNTA');
  assert.equal(verdictFor(row({ holders: { unknown: true, reason: 'strypt' } })).verdict, 'VÄNTA');
  assert.equal(verdictFor(row({ creatorOpeningShare: null })).verdict, 'VÄNTA');

  // Ett strypt RPC får aldrig se ut som en godkänd kontroll.
  const throttled = verdictFor(row({
    preflight: { state: 'unknown', checks: { authority: { state: 'unknown', detail: '429' } } },
  }));
  assert.equal(throttled.verdict, 'VÄNTA');
});

test('ett diskvalificerande fynd slår allt annat', () => {
  const good = row();
  for (const patch of [
    { preflight: { state: 'fail', checks: { authority: { state: 'fail', detail: 'mint aktiv' } } } },
    { holders: { unknown: false, topHolderPct: 72 } },
    { creatorOpeningShare: 22 },
    { flowReversed: true },
    { earlyExits: 6 },
    { probeExpired: true, qualified: false },
  ]) {
    assert.equal(verdictFor({ ...good, ...patch }).verdict, 'SKIPPA',
      `väntade SKIPPA för ${JSON.stringify(Object.keys(patch))}`);
  }
});

test('för svag traktion ger VÄNTA, inte SKIPPA', () => {
  assert.equal(verdictFor(row({ metrics: { ...row().metrics, uniqueBuyers: 5 } })).verdict, 'VÄNTA');
  assert.equal(verdictFor(row({ metrics: { ...row().metrics, netSol: 0.1 } })).verdict, 'VÄNTA');
});

/* ---------- utfallsboken ---------- */
import { OutcomeLedger } from '../src/engine/outcomes.js';

const graded = (mint, verdict, over = {}) => ({
  mint, symbol: mint.toUpperCase(), creator: 'dev', ageSec: 90,
  launchMarketCapSol: 30, curveProgress: 0.1,
  verdict: { verdict, reason: 'test' },
  metrics: { marketCapSol: 30, uniqueBuyers: 15 },
  ...over,
});

test('bara den första domen per token bokförs', () => {
  const l = new OutcomeLedger({ dir: tmp() });
  assert.equal(l.grade(graded('a', 'VÄNTA')), true);
  // En dom som får skrivas över i efterhand mäter efterklokhet, inte träff.
  assert.equal(l.grade(graded('a', 'KÖP')), false);
  assert.equal(l.rows.get('a').verdict, 'VÄNTA');
});

test('en rad utan omdöme bokförs inte', () => {
  const l = new OutcomeLedger({ dir: tmp() });
  assert.equal(l.grade({ mint: 'x', metrics: {} }), false);
  assert.equal(l.rows.size, 0);
});

test('graduation registreras och överlever omstart', () => {
  const dir = tmp();
  const l = new OutcomeLedger({ dir });
  l.grade(graded('b', 'KÖP'));
  assert.equal(l.recordGraduation('b'), true);
  assert.equal(l.recordGraduation('b'), false, 'samma graduation två gånger');

  const reloaded = new OutcomeLedger({ dir });
  assert.equal(reloaded.rows.get('b').graduated, true);
});

test('toppnoteringen är en undre gräns och går bara uppåt', () => {
  const l = new OutcomeLedger({ dir: tmp() });
  l.grade(graded('c', 'KÖP', { metrics: { marketCapSol: 30, uniqueBuyers: 15 } }));
  l.mark('c', 90);
  l.mark('c', 45);
  assert.equal(l.rows.get('c').peakMcap, 90);
  assert.equal(l.rows.get('c').peakIsLowerBound, true);
});

test('färska domar räknas inte som misslyckade', () => {
  const l = new OutcomeLedger({ dir: tmp() });
  l.grade(graded('d', 'KÖP'));
  const s = l.stats();
  assert.equal(s.classes['KÖP'].graded, 1);
  assert.equal(s.classes['KÖP'].settled, 0, 'en färsk dom är inte avgjord');
  assert.equal(s.classes['KÖP'].pending, 1);
  assert.equal(s.classes['KÖP'].graduationRate, null, 'utan underlag: ingen siffra');
});

test('lyftet mäter KÖP mot flödet i stort', () => {
  const l = new OutcomeLedger({ dir: tmp() });
  const old = Date.now() - 7 * 3600_000;

  // Tio KÖP varav fyra graduerar, tjugo SKIPPA varav en.
  for (let i = 0; i < 10; i++) {
    l.grade(graded(`buy${i}`, 'KÖP'));
    l.rows.get(`buy${i}`).gradedAt = old;
    if (i < 4) l.recordGraduation(`buy${i}`);
  }
  for (let i = 0; i < 20; i++) {
    l.grade(graded(`skip${i}`, 'SKIPPA'));
    l.rows.get(`skip${i}`).gradedAt = old;
    if (i < 1) l.recordGraduation(`skip${i}`);
  }

  const s = l.stats();
  assert.equal(s.classes['KÖP'].graduationRate, 0.4);
  assert.equal(s.classes['SKIPPA'].graduationRate, 0.05);
  // Basen är 5/30; KÖP ligger klart över den.
  assert.ok(s.lift > 2, `väntade tydligt lyft, fick ${s.lift}`);
});

test('dev som säljer sin egen token upptäcks och diskvalificerar', () => {
  const sells = [];
  const r = new Radar({ onDevSell: (e, sol) => sells.push([e.mint, sol]) });
  r.onLaunch({ mint: 'd1', symbol: 'D', traderPublicKey: 'devwallet' });

  // Andra wallets som säljer är normalt och ska inte flaggas.
  r.onTrade({ mint: 'd1', txType: 'sell', solAmount: 5, traderPublicKey: 'någon-annan' });
  assert.equal(sells.length, 0);

  r.onTrade({ mint: 'd1', txType: 'sell', solAmount: 2.5, traderPublicKey: 'devwallet' });
  assert.deepEqual(sells, [['d1', 2.5]]);

  const row = r.board()[0];
  assert.equal(row.devSells, 1);
  assert.ok(Math.abs(row.devSoldSol - 2.5) < 1e-9);
  assert.equal(verdictFor(row).verdict, 'SKIPPA');
  assert.match(verdictFor(row).reason, /dev har sålt/);
});

test('dev-sälj slår igenom även när allt annat ser perfekt ut', () => {
  const perfect = row({ devSells: 1, devSoldSol: 3.2 });
  assert.equal(verdictFor(row()).verdict, 'KÖP', 'utan dev-sälj ska den vara KÖP');
  assert.equal(verdictFor(perfect).verdict, 'SKIPPA');
});

test('en dev som köper flaggas inte', () => {
  const r = new Radar();
  r.onLaunch({ mint: 'd2', traderPublicKey: 'dev2' });
  r.onTrade({ mint: 'd2', txType: 'buy', solAmount: 1, traderPublicKey: 'dev2' });
  assert.equal(r.board()[0].devSells, 0);
});
