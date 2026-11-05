import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GpsTrack, loopPoint } from '../js/gps.js';

const M_PER_DEG = (6371008.8 * Math.PI) / 180;
const COS = Math.cos((43 * Math.PI) / 180);
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) * 1.41;

const fixAt = (t, x, y, accuracy = 5) => ({ t: t * 1000, lat: 43 + y / M_PER_DEG, lon: -88 + x / (M_PER_DEG * COS), accuracy });

// Phone-like error: a slow drift (AR(1), 3 m) plus 1 m of jitter per fix.
function noisy(path) {
  let ex = 0;
  let ey = 0;
  return (s) => {
    ex = 0.95 * ex + 0.94 * gauss();
    ey = 0.95 * ey + 0.94 * gauss();
    const p = path(s);
    return { x: p.x + ex + gauss(), y: p.y + ey + gauss() };
  };
}

const line = (s) => ({ x: s, y: 0 });

for (const [name, path] of [
  ['straight road', line],
  ['loop with corners', loopPoint],
]) {
  test(`distance on a ${name} is within 2.5% at walking and running pace`, () => {
    for (const speed of [1.5, 3, 4.5]) {
      const track = new GpsTrack();
      const at = noisy(path);
      for (let t = 0; t <= 1200; t++) {
        const p = at(speed * t);
        track.add(fixAt(t, p.x, p.y));
      }
      const err = track.distance / (speed * 1200) - 1;
      assert.ok(Math.abs(err) < 0.025, `${speed} m/s: ${(err * 100).toFixed(2)}%`);
    }
  });
}

test('standing still adds little distance', () => {
  const track = new GpsTrack();
  const at = noisy(line);
  for (let t = 0; t <= 300; t++) {
    const p = at(0);
    track.add(fixAt(t, p.x, p.y));
  }
  assert.ok(track.distance < 25, `${track.distance.toFixed(1)} m`);
});

test('a single wild fix is ignored', () => {
  const track = new GpsTrack();
  for (let t = 0; t <= 300; t++) {
    track.add(t === 150 ? fixAt(t, 3 * t, 250) : fixAt(t, 3 * t, 0));
  }
  assert.ok(Math.abs(track.distance - 900) < 20, `${track.distance.toFixed(1)} m`);
});

test('inaccurate fixes are ignored', () => {
  const track = new GpsTrack();
  for (let t = 0; t <= 100; t++) track.add(fixAt(t, 3 * t + (t % 2 ? 40 : 0), 0, t % 2 ? 60 : 5));
  assert.ok(Math.abs(track.distance - 300) < 20, `${track.distance.toFixed(1)} m`);
  assert.equal(track.fixes, 51);
});

test('a lost signal is bridged and counted as a gap', () => {
  const track = new GpsTrack();
  for (let t = 0; t <= 600; t++) {
    if (t > 200 && t < 240) continue;
    track.add(fixAt(t, 3 * t, 0));
  }
  assert.ok(Math.abs(track.distance - 1800) < 20, `${track.distance.toFixed(1)} m`);
  assert.equal(track.gapMs, 40000);
});

test('moving while paused does not count', () => {
  const track = new GpsTrack();
  for (let t = 0; t <= 100; t++) track.add(fixAt(t, 3 * t, 0));
  track.pause();
  for (let t = 101; t <= 160; t++) track.add(fixAt(t, 300, 2 * (t - 100)));
  track.resume();
  for (let t = 161; t <= 260; t++) track.add(fixAt(t, 300 + 3 * (t - 160), 120));
  assert.ok(Math.abs(track.distance - 600) < 25, `${track.distance.toFixed(1)} m`);
});
