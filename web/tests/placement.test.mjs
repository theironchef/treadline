import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CadenceEstimator, CMD } from '../js/sensor.js';
import { carrySample, SimLink } from '../js/links.js';
import { PlacementVote } from '../js/placement.js';

// A walk, a jog and a hard run, as runner() in links.js would move.
const PACES = {
  'walk 3 mph': { cadence: 105, amp: 2 },
  'jog 6 mph': { cadence: 160, amp: 6.6 },
  'run 9 mph': { cadence: 172, amp: 10.2 },
};

// Votes from `seconds` of simulated motion at a phone-like, jittery ~60 Hz,
// with the phone turned by `rotate` (a 3×3 matrix) in its pocket or strap.
function detect(place, { cadence, amp }, rotate = null, seconds = 50) {
  const est = new CadenceEstimator();
  const vote = new PlacementVote();
  let t = 0;
  let phase = 0;
  let nextVote = 9;
  while (t < seconds) {
    const dt = (1 / 60) * (0.85 + 0.3 * Math.random());
    t += dt;
    phase += (cadence / 60) * dt;
    let { x, y, z } = carrySample(phase, amp, place);
    if (rotate) [x, y, z] = rotate.map((r) => r[0] * x + r[1] * y + r[2] * z);
    est.addAccel(t, x, y, z);
    if (t >= nextVote) {
      nextVote += 1;
      const e = est.estimate(t);
      if (e.carry) vote.add(e.carry);
    }
  }
  return vote;
}

for (const place of ['pocket', 'armband', 'waist']) {
  test(`a phone on the ${place} is recognised at walking and running pace`, () => {
    for (const [pace, gait] of Object.entries(PACES)) {
      const vote = detect(place, gait);
      assert.equal(vote.winner, place, `${pace}: ${JSON.stringify(vote.counts)}`);
    }
  });
}

test('which way the phone faces makes no difference', () => {
  // Upside down, on its side, and a skewed angle.
  const c = Math.cos(0.7);
  const s = Math.sin(0.7);
  const turns = [
    [
      [1, 0, 0],
      [0, -1, 0],
      [0, 0, -1],
    ],
    [
      [0, 1, 0],
      [-1, 0, 0],
      [0, 0, 1],
    ],
    [
      [c, -s, 0],
      [s * c, c * c, -s],
      [s * s, c * s, c],
    ],
  ];
  for (const place of ['pocket', 'armband', 'waist']) {
    for (const turn of turns) assert.equal(detect(place, PACES['jog 6 mph'], turn).winner, place);
  }
});

test('the vote waits for enough agreement', () => {
  const vote = new PlacementVote();
  const pocket = { limb: 1, asym: 0.3 };
  const waist = { limb: 0.3, asym: 0.03 };
  for (let i = 0; i < 20; i++) vote.add(pocket);
  assert.equal(vote.winner, null, 'too few votes yet');
  for (let i = 0; i < 20; i++) vote.add(pocket);
  for (let i = 0; i < 8; i++) vote.add(waist); // stopping at a light, say
  assert.equal(vote.winner, 'pocket');
  for (let i = 0; i < 30; i++) vote.add(waist);
  assert.equal(vote.winner, null, 'split: no clear answer');
});

test('the simulated runner sends the features with each live reading', async () => {
  const sim = new SimLink(1, [[120, 6.5]], 'armband');
  const vote = new PlacementVote();
  sim.addEventListener('live', (e) => e.detail.carry && vote.add(e.detail.carry));
  await sim.control(CMD.START);
  for (let i = 0; i < 120; i++) sim._tick();
  assert.equal(vote.winner, 'armband', JSON.stringify(vote.counts));
});
