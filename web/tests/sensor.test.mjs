import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CadenceEstimator, Session, CMD } from '../js/sensor.js';
import { synth } from '../js/links.js';

// Feeds `seconds` of synthetic signal at a phone-like ~60 Hz with timing
// jitter, then returns the estimate at the end.
function run(cadence, amp, { seconds = 10, hz = 60 } = {}) {
  const est = new CadenceEstimator();
  let t = 0;
  let phase = 0;
  while (t < seconds) {
    const dt = (1 / hz) * (0.8 + 0.4 * Math.random());
    t += dt;
    phase += (cadence / 60) * dt;
    est.addAccel(t, 0.3, 0.2, synth(phase, amp));
  }
  return est.estimate(t);
}

for (const [cadence, amp] of [
  [100, 1.5],
  [115, 2.2],
  [128, 2.8],
  [150, 5],
  [165, 6],
  [178, 7.5],
  [192, 9],
]) {
  test(`recovers ${cadence} spm`, () => {
    const e = run(cadence, amp);
    assert.ok(Math.abs(e.cadence - cadence) < 2, `got ${e.cadence.toFixed(1)}`);
    assert.ok(e.quality > 0.3);
  });
}

test('standing still reads as zero cadence', () => {
  const e = run(0, 0);
  assert.equal(e.cadence, 0);
});

test('no recent samples reads as no data', () => {
  const est = new CadenceEstimator();
  for (let i = 0; i < 500; i++) est.addAccel(i / 50, 0, 0, synth((i / 50) * 2.8, 6));
  assert.equal(est.estimate(30).source, 'none');
});

test('hardware step counter resolves the period when present', () => {
  const est = new CadenceEstimator();
  let phase = 0;
  for (let i = 1; i <= 500; i++) {
    const t = i / 50;
    phase += 170 / 60 / 50;
    est.addAccel(t, 0, 0, synth(phase, 6));
    if (i % 25 === 0) est.addSteps(t, Math.floor(phase));
  }
  const e = est.estimate(10);
  assert.equal(e.source, 'accel');
  assert.ok(Math.abs(e.cadence - 170) < 2, `got ${e.cadence}`);
});

test('session accumulates per-gait moments with hysteresis', () => {
  const s = new Session();
  s.command(CMD.START);
  for (let i = 0; i < 60; i++) s.tick(1, { cadence: 115, intensity: 0.3 });
  for (let i = 0; i < 60; i++) s.tick(1, { cadence: 135, intensity: 0.5 }); // still walking
  for (let i = 0; i < 60; i++) s.tick(1, { cadence: 165, intensity: 1 });
  for (let i = 0; i < 60; i++) s.tick(1, { cadence: 135, intensity: 0.8 }); // still running
  assert.equal(s.moments.walk.dt, 120);
  assert.equal(s.moments.run.dt, 120);
  assert.ok(Math.abs(s.moments.run.n - (165 + 135)) < 1e-9);
  s.command(CMD.PAUSE);
  s.tick(1, { cadence: 165, intensity: 1 });
  assert.equal(s.elapsedMs, 240000);
  s.command(CMD.RESUME);
  s.gap(30);
  assert.equal(s.gapMs, 30000);
  assert.equal(s.elapsedMs, 270000);
});
