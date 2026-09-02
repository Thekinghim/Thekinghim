import test from 'node:test';
import assert from 'node:assert/strict';
import { Pipeline } from '../src/pipeline.js';
import { config } from '../src/config.js';
import { generateLaunch, createStreams, archetypes } from '../src/ingest/mock.js';

const trapIds = new Set(archetypes.filter((a) => a.isTrap).map((a) => a.id));

test('inget larm på en token som fäller en hård grind, hur starkt momentum den än har', () => {
  const alerts = [];
  const p = new Pipeline(config, { onAlert: (c) => alerts.push(c) });
  const streams = createStreams(1234);

  // Kör tills vi hittat en honeypot och mata in hela dess förlopp.
  for (let i = 0; i < 200 && alerts.length === 0; i++) {
    const launch = generateLaunch(streams, Date.now(), i);
    if (launch.truth.archetype !== 'honeypot') continue;
    p.onToken(launch.meta, launch.truth);
    for (const trade of launch.trades) p.onTrade(trade);
  }
  assert.equal(alerts.length, 0, 'en honeypot ska aldrig larma');
});

test('larm bär med sig poängen från larmtillfället, inte det aktuella värdet', () => {
  const alerts = [];
  const updates = [];
  const p = new Pipeline(config, {
    onAlert: (c) => alerts.push(structuredClone(c)),
    onUpdate: (c) => updates.push(c),
  });
  const streams = createStreams(99);

  for (let i = 0; i < 300 && alerts.length === 0; i++) {
    const launch = generateLaunch(streams, Date.now(), i);
    p.onToken(launch.meta, launch.truth);
    for (const trade of launch.trades) p.onTrade(trade);
  }

  assert.ok(alerts.length > 0, 'testet behöver minst ett larm');
  const alert = alerts[0];
  assert.ok(alert.alert, 'larmet ska ha metadata');
  assert.ok(alert.alert.momentum >= config.momentum.minScore);
  assert.ok(alert.alert.risk <= config.risk.maxScore);

  // Sista uppdateringen för samma token kommer senare, när momentum fallit —
  // larmets sparade poäng ska inte ha ändrats av det.
  const later = updates.filter((u) => u.meta.address === alert.meta.address).at(-1);
  assert.equal(later.alert.momentum, alert.alert.momentum);
});

test('inga fällor tar sig igenom hela kedjan', () => {
  const p = new Pipeline(config);
  const streams = createStreams(20250902);
  const truth = new Map();

  for (let i = 0; i < 250; i++) {
    const launch = generateLaunch(streams, Date.now() + i * 40_000, i);
    truth.set(launch.meta.address, launch.truth.archetype);
    p.onToken(launch.meta, launch.truth);
    for (const trade of launch.trades) p.onTrade(trade);
  }

  const alerted = [...p.ledger.positions.values()].filter((pos) => pos.group === 'strategy');
  assert.ok(alerted.length > 10, `för få larm att dra slutsatser av: ${alerted.length}`);
  const leaked = alerted.filter((pos) => trapIds.has(truth.get(pos.address)));
  assert.deepEqual(leaked.map((p) => truth.get(p.address)), [], 'fällor läckte igenom filtret');
});

test('evict släpper tokens som passerat bokföringsfönstret', () => {
  const p = new Pipeline(config);
  const launch = generateLaunch(createStreams(5), Date.now(), 0);
  p.onToken(launch.meta, launch.truth);
  assert.equal(p.tracked.size, 1);
  p.evict(launch.meta.createdAt + 24 * 3600_000);
  assert.equal(p.tracked.size, 0);
});
