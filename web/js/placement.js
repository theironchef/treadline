// Where on the body the phone rides, from how it moves. Each spot is
// calibrated separately (its readings differ in size), so knowing it means
// nobody has to set it.
//
// Two rhythm ratios from the cadence estimator (sensor.js), both indifferent
// to which way the phone faces and to running speed:
//
//   limb  Motion once per stride (two steps) against motion once per step. A
//         thigh or an arm swings once per stride; the waist mostly bounces
//         once per step, the same for either foot. High in a pocket or on an
//         armband, low at the waist.
//   asym  How differently alternate steps land, in the size of the
//         acceleration alone. In a front pocket the phone rides the leg that
//         lands every other step, and that foot strike hits much harder than
//         the other one. The arm and the waist feel both feet about equally.
//
// The thresholds sit between what each spot's movement should give (see
// carrySample in links.js, which simulates them). They aren't fitted to
// recordings, so the app shows its guess and lets you correct it.

export const PLACES = ['pocket', 'armband', 'waist'];
export const PLACE_NAMES = { pocket: 'Front pocket', armband: 'Armband', waist: 'Waistband' };

const LIMB = 0.55;
const ASYM = 0.12;

export function classify({ limb, asym }) {
  if (limb < LIMB) return 'waist';
  return asym > ASYM ? 'pocket' : 'armband';
}

// One vote a second while moving. A spot wins once it has MIN_VOTES and
// LEAD of them; the windows around a stumble, a stop or a phone moved from
// hand to pocket can't swing it.
const MIN_VOTES = 30;
const LEAD = 0.7;

export class PlacementVote {
  constructor(saved) {
    this.counts = { pocket: 0, armband: 0, waist: 0, ...saved };
  }

  add(carry) {
    this.counts[classify(carry)]++;
  }

  get total() {
    return PLACES.reduce((s, p) => s + this.counts[p], 0);
  }

  // The winning spot, or null while it's still unclear.
  get winner() {
    const total = this.total;
    if (total < MIN_VOTES) return null;
    const best = PLACES.reduce((a, b) => (this.counts[b] > this.counts[a] ? b : a));
    return this.counts[best] >= LEAD * total ? best : null;
  }

  toJSON() {
    return { ...this.counts };
  }
}
