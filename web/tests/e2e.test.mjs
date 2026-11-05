import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimLink } from '../js/links.js';
import { CMD } from '../js/sensor.js';
import { fit, prior, predict, features, diffMoments } from '../js/model.js';

// Whole pipeline on the simulated runner: synthetic accelerometer samples →
// cadence estimator → session moments → model. Calibrate on one set of
// treadmill speeds, then check a run at different speeds.

const MPH = 0.44704;

async function simulate(program) {
  const sim = new SimLink(1, program);
  await sim.control(CMD.START);
  const marks = [];
  let t = 0;
  for (const [dur, mph] of program) {
    // Skip the first 20 s of each speed, as a runner settling in would.
    for (let i = 0; i < dur; i++, t++) {
      if (i === 20) marks.push({ mph, start: await sim.readSums() });
      sim._tick();
    }
    marks[marks.length - 1].end = await sim.readSums();
  }
  return { sums: await sim.readSums(), truth: sim.treadmillMeters, marks };
}

const relErr = (beta, sums, truth) => predict(beta, features(sums.moments)) / truth - 1;

test('segments at four speeds calibrate an unseen interval run', async () => {
  const pri = prior(1.75);
  const cal = await simulate([
    [150, 3.5],
    [150, 5.5],
    [150, 6.5],
    [150, 7.5],
  ]);
  const obs = cal.marks.map((m, k) => {
    const seconds = (m.end.elapsedMs - m.start.elapsedMs) / 1000;
    return {
      id: String(k),
      t: Date.now(),
      moments: diffMoments(m.end.moments, m.start.moments),
      distance: m.mph * MPH * seconds,
      sigma: 0.015,
    };
  });
  const model = fit(obs, pri);

  const intervals = await simulate([
    [240, 3.8],
    [300, 6.0],
    [120, 8.0],
    [180, 5.8],
    [120, 8.0],
    [300, 6.2],
  ]);
  const before = relErr(pri.mean, intervals.sums, intervals.truth);
  const after = relErr(model.beta, intervals.sums, intervals.truth);
  console.log(`uncalibrated ${(before * 100).toFixed(1)}%, calibrated ${(after * 100).toFixed(1)}%`);
  assert.ok(Math.abs(after) < 0.03, `calibrated error ${(after * 100).toFixed(2)}%`);
  assert.ok(Math.abs(after) < Math.abs(before));
});

test('two whole runs with treadmill distances calibrate a third', async () => {
  const pri = prior(1.75);
  const runs = [];
  for (const program of [
    [
      [180, 3.5],
      [1200, 6.0],
      [300, 7.0],
    ],
    [
      [120, 3.2],
      [600, 6.5],
      [600, 7.2],
    ],
  ]) {
    const r = await simulate(program);
    runs.push({ id: String(runs.length), t: Date.now(), moments: r.sums.moments, distance: r.truth, sigma: 0.01 });
  }
  const model = fit(runs, pri);
  const third = await simulate([
    [180, 3.5],
    [900, 6.3],
    [600, 6.8],
  ]);
  const after = relErr(model.beta, third.sums, third.truth);
  console.log(`third run calibrated error ${(after * 100).toFixed(1)}%`);
  assert.ok(Math.abs(after) < 0.03, `calibrated error ${(after * 100).toFixed(2)}%`);
});

test('an outdoor run with GPS calibrates a later treadmill run', async () => {
  const { SimGps, GpsTrack } = await import('../js/gps.js');
  const { Chunker, usableChunk } = await import('../js/run.js');
  const pri = prior(1.75);
  const program = [
    [240, 3.4],
    [600, 5.6],
    [480, 6.6],
    [360, 7.6],
    [300, 6.0],
  ];
  const sim = new SimLink(1, program);
  const gps = new SimGps(sim);
  const track = new GpsTrack();
  gps.addEventListener('fix', (e) => track.add(e.detail));
  gps.start();
  const chunker = new Chunker();
  await sim.control(CMD.START);
  for (let t = 0; t < 1980; t++) {
    sim._tick();
    chunker.update(track.snapshot(), await sim.readSums());
  }
  const chunks = chunker.finish(track.snapshot(), await sim.readSums());
  const gpsErr = track.distance / sim.treadmillMeters - 1;
  console.log(`GPS distance error ${(gpsErr * 100).toFixed(1)}%, ${chunks.length} chunks`);
  assert.ok(Math.abs(gpsErr) < 0.02, `GPS error ${(gpsErr * 100).toFixed(2)}%`);
  assert.ok(chunks.length >= 6 && chunks.every(usableChunk));

  const obs = chunks.map((c, k) => ({ id: String(k), t: Date.now(), moments: c.moments, distance: c.distance, sigma: 0.02 }));
  const model = fit(obs, pri);
  const treadmill = await simulate([
    [240, 3.8],
    [300, 6.0],
    [120, 8.0],
    [300, 6.2],
  ]);
  const before = relErr(pri.mean, treadmill.sums, treadmill.truth);
  const after = relErr(model.beta, treadmill.sums, treadmill.truth);
  console.log(`treadmill uncalibrated ${(before * 100).toFixed(1)}%, GPS-calibrated ${(after * 100).toFixed(1)}%`);
  assert.ok(Math.abs(after) < 0.025, `calibrated error ${(after * 100).toFixed(2)}%`);
  assert.ok(Math.abs(after) < Math.abs(before));
});
