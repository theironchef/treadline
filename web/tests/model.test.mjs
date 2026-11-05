import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyMoments, features, fit, predict, prior, speed, diffMoments } from '../js/model.js';
import { rescale, splits, milestones, announcement, crossingTime } from '../js/run.js';
import { spokenDuration, spokenDistance } from '../js/format.js';

// A runner whose true step length is not the prior's: longer strides that
// grow faster with cadence and with intensity.
const TRUE = [0.75, 0.06, 0.1, 1.12, 0.42, 0.25];

// Moments and true distance for a span at constant cadence/intensity.
function span(gait, cadence, intensity, seconds, beta = TRUE) {
  const m = emptyMoments();
  const n = (cadence / 60) * seconds;
  Object.assign(m[gait], { dt: seconds, n, nc: n * cadence, ni: n * intensity, ncc: n * cadence * cadence });
  return { m, d: predict(beta, features(m)) };
}

function add(a, b) {
  const out = emptyMoments();
  for (const g of ['walk', 'run']) for (const k of Object.keys(out[g])) out[g][k] = a[g][k] + b[g][k];
  return out;
}

let id = 0;
const obs = (m, distance, sigma = 0.01) => ({ id: String(id++), t: Date.now(), moments: m, distance, sigma });

test('prior gives plausible paces for a 1.75 m runner', () => {
  const { mean } = prior(1.75);
  const mph = (mps) => mps * 2.23694;
  assert.ok(mph(speed(mean, 'walk', 115, 0.25)) > 2.8 && mph(speed(mean, 'walk', 115, 0.25)) < 4);
  assert.ok(mph(speed(mean, 'run', 165, 0.9)) > 5.5 && mph(speed(mean, 'run', 165, 0.9)) < 7.5);
  assert.ok(speed(mean, 'run', 180, 1) > speed(mean, 'run', 160, 1));
});

test('calibration segments at three speeds recover the runner', () => {
  const pri = prior(1.75);
  const segs = [
    span('run', 158, 0.8, 120),
    span('run', 166, 1.0, 120),
    span('run', 176, 1.25, 120),
    span('walk', 112, 0.22, 120),
  ];
  const model = fit(segs.map((s) => obs(s.m, s.d, 0.015)), pri);
  // An unseen steady run in the calibrated range.
  const test = span('run', 170, 1.1, 1800);
  const err = predict(model.beta, features(test.m)) / test.d - 1;
  assert.ok(Math.abs(err) < 0.02, `error ${(err * 100).toFixed(2)}%`);
  const priorErr = predict(pri.mean, features(test.m)) / test.d - 1;
  assert.ok(Math.abs(priorErr) > Math.abs(err) * 3, 'calibration should beat the prior');
});

test('whole runs with treadmill distance calibrate too', () => {
  const pri = prior(1.75);
  const runs = [];
  for (const [c1, c2, i1, i2] of [
    [160, 168, 0.85, 1.05],
    [163, 175, 0.9, 1.2],
    [158, 164, 0.8, 0.95],
    [165, 180, 0.95, 1.35],
  ]) {
    const warm = span('walk', 112, 0.22, 300);
    const a = span('run', c1, i1, 900);
    const b = span('run', c2, i2, 900);
    const m = add(add(warm.m, a.m), b.m);
    runs.push(obs(m, warm.d + a.d + b.d));
  }
  const model = fit(runs, pri);
  assert.equal(model.count, 4);
  assert.ok(model.error.rms < 0.02, `LOO rms ${(model.error.rms * 100).toFixed(2)}%`);
  const unseen = add(span('walk', 112, 0.22, 300).m, span('run', 170, 1.15, 1500).m);
  const truth = predict(TRUE, features(unseen));
  const err = predict(model.beta, features(unseen)) / truth - 1;
  assert.ok(Math.abs(err) < 0.02, `error ${(err * 100).toFixed(2)}%`);
});

test('excluded observations are ignored', () => {
  const pri = prior(1.75);
  const s = span('run', 165, 0.9, 600);
  const bad = { ...obs(s.m, s.d * 2), include: false };
  const model = fit([bad], pri);
  assert.equal(model.count, 0);
  assert.deepEqual(model.beta.map((x) => x.toFixed(6)), pri.mean.map((x) => x.toFixed(6)));
});

test('moment differences give segment features', () => {
  const a = span('run', 165, 0.9, 100).m;
  const b = add(a, span('run', 170, 1.0, 60).m);
  const d = diffMoments(b, a);
  assert.ok(Math.abs(d.run.dt - 60) < 1e-9);
  assert.ok(Math.abs(d.run.nc / d.run.n - 170) < 1e-9);
});

test('splits interpolate mile crossings', () => {
  // 3 m/s for 1200 s = 3600 m.
  const tl = [];
  for (let t = 0; t <= 1200; t++) tl.push({ t, d: 3 * t });
  const s = splits(tl, 1609.344);
  assert.equal(s.length, 3);
  assert.ok(Math.abs(s[0].seconds - 536.448) < 0.01);
  assert.ok(Math.abs(s[2].fraction - (3600 - 2 * 1609.344) / 1609.344) < 1e-6);
  const r = rescale(tl, 3960);
  assert.ok(Math.abs(r[r.length - 1].d - 3960) < 0.1);
});

test('milestones fire once each for miles, halfway and the target', () => {
  const MI = 1609.344;
  const target = 3.1 * MI;
  const seen = [];
  let d0 = 0;
  for (let d = 0; d <= 3.3 * MI; d += 7) {
    seen.push(...milestones(d0, d, MI, target).map((e) => e.kind + (e.k ?? '')));
    d0 = d;
  }
  assert.deepEqual(seen, ['split1', 'half', 'split2', 'split3', 'target']);
  assert.deepEqual(milestones(0, 5000, MI, 0).map((e) => e.k), [1, 2, 3]);
});

test('announcements give the split and the average pace', () => {
  const MI = 1609.344;
  // 8:00 first mile, then 9:00 per mile.
  const tl = [];
  for (let t = 0; t <= 1600; t++) tl.push({ t, d: t <= 480 ? (t / 480) * MI : MI + ((t - 480) / 540) * MI });
  assert.equal(Math.round(crossingTime(tl, 2 * MI)), 1020);
  assert.equal(
    announcement([{ kind: 'split', k: 2, at: 2 * MI }], tl, 'mi'),
    'Mile 2. Split 9 minutes. Average pace 8 minutes 30 seconds per mile.',
  );
  assert.equal(
    announcement([{ kind: 'half', at: 1.5 * MI }], tl, 'mi'),
    'Halfway. 1.5 miles in 12 minutes 30 seconds. Average pace 8 minutes 20 seconds per mile.',
  );
  assert.equal(
    announcement([{ kind: 'split', k: 1, at: MI }, { kind: 'half', at: MI }], tl, 'mi'),
    'Mile 1. Split 8 minutes. Halfway. Average pace 8 minutes per mile.',
  );
  assert.equal(spokenDuration(3725), '1 hour 2 minutes 5 seconds');
  assert.equal(spokenDistance(1000, 'km'), '1 kilometer');
});

test('stretches of one run count and are left out together', () => {
  const pri = prior(1.75);
  const a = span('run', 165, 0.95, 400);
  const b = span('run', 172, 1.1, 400);
  const c = span('run', 168, 1.0, 900);
  const model = fit(
    [
      { ...obs(a.m, a.d, 0.02), group: 'out' },
      { ...obs(b.m, b.d, 0.02), group: 'out' },
      obs(c.m, c.d),
    ],
    pri,
  );
  assert.equal(model.count, 2);
  const ids = Object.keys(model.error.byId);
  assert.equal(ids.length, 3);
  assert.equal(model.error.byId[ids[0]], model.error.byId[ids[1]]);
});
