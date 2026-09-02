import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Journal } from '../src/journal.js';
import { buildCalibration, priorFor, bucketFor, MIN_SAMPLE } from '../src/edge/calibration.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'journal-'));

const cfg = (dir) => ({
  dir,
  horizons: [1000, 5000],
  horizonLabels: ['1s', '5s'],
  roundTripCostPct: 3.5,
});

const decision = (address, verdict = 'BUY', gap = 45) => ({
  token: { address, symbol: address.slice(0, 4) },
  verdict,
  headline: 'test',
  edge: { gap, quadrant: 'early', traction: { score: 70 }, attention: { score: 20 } },
});

test('journalen överlever en omstart', () => {
  const dir = tmpDir();
  const a = new Journal(cfg(dir));
  a.open('strategy', decision('aaa'), 1, 'gap_40_55');
  a.mark('aaa', 2, Date.now() + 2000);

  // Ny instans, samma katalog: en forward test som glöms vid omstart är
  // ingen forward test.
  const b = new Journal(cfg(dir));
  assert.equal(b.positions.size, 1);
  const pos = b.positions.get('aaa');
  assert.ok(pos.marks[0] !== null, 'stämplad horisont ska finnas kvar efter omläsning');
  assert.equal(pos.entryPrice, 1);
});

test('avkastning redovisas netto och positioner öppnas bara en gång', () => {
  const j = new Journal(cfg(tmpDir()));
  assert.equal(j.open('strategy', decision('bbb'), 1, 'gap_40_55'), true);
  assert.equal(j.open('control', decision('bbb', 'WATCH'), 5, 'gap_25_40'), false);
  assert.equal(j.open('strategy', decision('ccc'), 0, null), false, 'nollpris ska avvisas');

  j.mark('bbb', 1, Date.now() + 1500);
  assert.ok(Math.abs(j.positions.get('bbb').marks[0] - -0.035) < 1e-9);
});

test('en trasig rad tar inte ner historiken', () => {
  const dir = tmpDir();
  const j = new Journal(cfg(dir));
  j.open('strategy', decision('ddd'), 1, null);
  fs.appendFileSync(path.join(dir, 'journal.ndjson'), '{ inte giltig json\n');

  const reloaded = new Journal(cfg(dir));
  assert.equal(reloaded.positions.size, 1);
});

test('statistiken separerar strategi och kontroll', () => {
  const j = new Journal(cfg(tmpDir()));
  j.open('strategy', decision('win'), 1, 'gap_40_55');
  j.open('control', decision('lose', 'WATCH'), 1, 'gap_25_40');
  const later = Date.now() + 2000;
  j.mark('win', 3, later);
  j.mark('lose', 0.4, later);

  const s = j.stats();
  assert.equal(s.strategy.horizons[0].winRate, 1);
  assert.equal(s.control.horizons[0].winRate, 0);
});

test('kalibreringen tiger tills den har underlag', () => {
  const few = buildCalibration(
    Array.from({ length: 5 }, () => ({ bucket: 'gap_40_55', quadrant: 'early', marks: [0.1, 0.5] })),
  );
  assert.equal(few.gap_40_55.ready, false);

  const prior = priorFor(45, few);
  assert.equal(prior.score, 0, 'utan underlag ska priorn inte påverka konviktionen');
  assert.match(prior.note, /observationer/);
});

test('kalibreringen belönar en hink som betalat och straffar en som inte gjort det', () => {
  const winners = Array.from({ length: MIN_SAMPLE + 3 }, () => ({
    bucket: 'gap_55_plus', quadrant: 'early', marks: [0.2, 0.9],
  }));
  const losers = Array.from({ length: MIN_SAMPLE + 3 }, () => ({
    bucket: 'gap_25_40', quadrant: 'early', marks: [-0.1, -0.5],
  }));

  const table = buildCalibration([...winners, ...losers]);
  assert.equal(table.gap_55_plus.ready, true);
  assert.ok(priorFor(60, table).score > 0);
  assert.ok(priorFor(30, table).score < 0);

  // Taket hindrar en lyckosam period från att ta över beslutet.
  const extreme = buildCalibration(
    Array.from({ length: 40 }, () => ({ bucket: 'gap_55_plus', quadrant: 'early', marks: [5, 20] })),
  );
  assert.ok(priorFor(60, extreme).score <= 15);
});

test('hinkarna täcker gapintervallet utan hål', () => {
  assert.equal(bucketFor(24), null, 'under köptröskeln finns ingen hink');
  assert.equal(bucketFor(25), 'gap_25_40');
  assert.equal(bucketFor(40), 'gap_40_55');
  assert.equal(bucketFor(55), 'gap_55_plus');
  assert.equal(bucketFor(100), 'gap_55_plus');
});
