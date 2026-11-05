import { emptyMoments } from './model.js';

// Cadence and intensity from raw accelerometer samples, and the per-session
// accumulator that turns them into the moments the model is fitted on.
//
// A sensor link (links.js) feeds samples in and, once a second, emits a live
// reading; readSums() returns the session's cumulative moments. A future
// watch link only has to produce the same two shapes.

export const CMD = { START: 1, PAUSE: 2, RESUME: 3, STOP: 4 };
export const STATE = { IDLE: 0, ACTIVE: 1, PAUSED: 2, STOPPED: 3 };
export const FLAG = { RUN: 1, ACTIVE: 2, PAUSED: 4 };

const FS = 50; // resample rate, Hz
const WINDOW_S = 8;
const G = 9.80665;
const MIN_LAG = Math.round(0.25 * FS);
const MIN_STRIDE_LAG = Math.round(0.5 * FS);
const MAX_LAG = Math.round(1.6 * FS);
const STILL_G = 0.04;
// Where-on-the-body features need a clean rhythm to mean anything.
const CARRY_QUALITY = 0.4;

export class CadenceEstimator {
  #t = [];
  #mag = [];
  #axes = [[], [], []]; // x, y, z, for where-on-the-body features
  #steps = []; // [t, cumulative count] from a hardware step counter

  addAccel(t, x, y, z) {
    this.#t.push(t);
    this.#mag.push(Math.hypot(x, y, z));
    this.#axes[0].push(x);
    this.#axes[1].push(y);
    this.#axes[2].push(z);
    while (this.#t.length && this.#t[0] < t - WINDOW_S - 1) {
      this.#t.shift();
      this.#mag.shift();
      for (const a of this.#axes) a.shift();
    }
  }

  addSteps(t, count) {
    this.#steps.push([t, count]);
    while (this.#steps.length && this.#steps[0][0] < t - 15) this.#steps.shift();
  }

  // { cadence (spm), intensity (g), quality (0–1), source, carry }, where
  // carry holds the where-on-the-body features when there's a clear rhythm.
  estimate(now) {
    const est = this.#cadence(now);
    if (est.source === 'accel' && est.cadence > 0 && est.quality >= CARRY_QUALITY) {
      est.carry = this.#carry(now, est.cadence);
    }
    return est;
  }

  // Two rhythm ratios, both indifferent to which way the phone faces (see
  // placement.js). With f the step frequency and f/2 the stride frequency:
  //   limb: motion of the whole 3-axis vector at f/2 against at f
  //   asym: the same for the size of the acceleration alone
  #carry(now, cadence) {
    const n = this.#t.length;
    const end = this.#t[n - 1];
    const start = Math.max(this.#t[0], end - WINDOW_S);
    const step = cadence / 60;
    const axes = this.#axes.map((a) => resample(this.#t, a, start, end));
    const mag = resample(this.#t, this.#mag, start, end);
    const vec = (f) => Math.hypot(...axes.map((a) => amplitude(a, f)));
    return { limb: vec(step / 2) / vec(step), asym: amplitude(mag, step / 2) / amplitude(mag, step) };
  }

  #cadence(now) {
    const none = { cadence: 0, intensity: 0, quality: 0, source: 'none' };
    const n = this.#t.length;
    if (n < 2 || now - this.#t[n - 1] > 2) return none;
    const end = this.#t[n - 1];
    const start = Math.max(this.#t[0], end - WINDOW_S);
    if (end - start < 4) return none;

    const s = resample(this.#t, this.#mag, start, end);
    const mean = s.reduce((a, b) => a + b, 0) / s.length;
    let ss = 0;
    for (let i = 0; i < s.length; i++) {
      s[i] -= mean;
      ss += s[i] * s[i];
    }
    const intensity = Math.sqrt(ss / s.length) / G;
    if (intensity < STILL_G) return { ...none, intensity, source: 'still' };

    const r = autocorr(s, MAX_LAG);
    const hw = this.#hardwareCadence(now);

    if (hw != null && hw > 40) {
      // Look for the stride (two-step) period near what the step counter says;
      // the wrist repeats once per stride whether or not single steps show.
      const expect = (120 / hw) * FS;
      const lo = Math.max(MIN_LAG, Math.floor(expect * 0.85));
      const hi = Math.min(MAX_LAG - 1, Math.ceil(expect * 1.15));
      const L = argmaxPeak(r, lo, hi);
      if (L > 0 && r[L] >= 0.25) {
        const cadence = (120 * FS) / refine(r, L);
        if (Math.abs(cadence / hw - 1) < 0.12) return { cadence, intensity, quality: r[L], source: 'accel' };
      }
      return { cadence: hw, intensity, quality: 0.5, source: 'steps' };
    }
    if (hw === 0) return { cadence: 0, intensity, quality: 0.5, source: 'steps' };

    // No step counter: take the shortest strong periodicity in the stride range.
    let best = 0;
    for (let L = MIN_STRIDE_LAG; L < MAX_LAG; L++) if (isPeak(r, L)) best = Math.max(best, r[L]);
    if (best < 0.3) return { cadence: 0, intensity, quality: best, source: 'accel' };
    let L = MIN_STRIDE_LAG;
    while (!(isPeak(r, L) && r[L] >= 0.85 * best)) L++;
    let cadence = (120 * FS) / refine(r, L);
    // A walking step period can land in the stride range; nobody walks at 200+.
    if (cadence > 200 && intensity < 0.6) cadence /= 2;
    return { cadence, intensity, quality: r[L], source: 'accel' };
  }

  #hardwareCadence(now) {
    const recent = this.#steps.filter(([t]) => t >= now - 12);
    if (recent.length >= 2) {
      const [t0, c0] = recent[0];
      const [t1, c1] = recent[recent.length - 1];
      if (t1 - t0 >= 4) return ((c1 - c0) / (t1 - t0)) * 60;
    }
    // The counter has reported before but has been silent: standing still.
    if (this.#steps.length && now - this.#steps[this.#steps.length - 1][0] > 6) return 0;
    return null;
  }
}

function resample(t, v, start, end) {
  const n = Math.floor((end - start) * FS);
  const out = new Float64Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const ti = start + i / FS;
    while (j < t.length - 2 && t[j + 1] < ti) j++;
    const span = t[j + 1] - t[j];
    const f = span > 0 ? Math.min(1, Math.max(0, (ti - t[j]) / span)) : 0;
    out[i] = v[j] + f * (v[j + 1] - v[j]);
  }
  return out;
}

function autocorr(s, maxLag) {
  const r = new Float64Array(maxLag + 1);
  for (let L = MIN_LAG - 1; L <= maxLag && L < s.length; L++) {
    let xy = 0;
    let xx = 0;
    let yy = 0;
    for (let i = 0; i + L < s.length; i++) {
      xy += s[i] * s[i + L];
      xx += s[i] * s[i];
      yy += s[i + L] * s[i + L];
    }
    r[L] = xx > 0 && yy > 0 ? xy / Math.sqrt(xx * yy) : 0;
  }
  return r;
}

// Size of the component of s at frequency f (Hz): a single-frequency Fourier
// coefficient, through a Hann window so the strong step rhythm doesn't leak
// into the stride rhythm next to it. The best of f ± 3% allows for cadence
// drifting a little within the window. Only ratios of these are used, so the
// scale doesn't matter.
function amplitude(s, f) {
  const n = s.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += s[i];
  mean /= n;
  let best = 0;
  for (const k of [0.97, 1, 1.03]) {
    const w = (2 * Math.PI * f * k) / FS;
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      const v = (s[i] - mean) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
      re += v * Math.cos(w * i);
      im -= v * Math.sin(w * i);
    }
    best = Math.max(best, Math.hypot(re, im));
  }
  return best;
}

const isPeak = (r, L) => r[L] > r[L - 1] && r[L] >= r[L + 1];

function argmaxPeak(r, lo, hi) {
  let best = -1;
  for (let L = lo; L <= hi; L++) if (isPeak(r, L) && (best < 0 || r[L] > r[best])) best = L;
  return best;
}

// Sub-sample peak position by fitting a parabola through three points.
function refine(r, L) {
  const a = r[L - 1];
  const b = r[L];
  const c = r[L + 1];
  const den = a - 2 * b + c;
  const d = den < 0 ? (0.5 * (a - c)) / den : 0;
  return L + Math.max(-0.5, Math.min(0.5, d));
}

// Gait switches to running at 140 spm and back below 130.
const RUN_ON = 140;
const RUN_OFF = 130;

export class Session {
  state = STATE.IDLE;
  sessionId = 0;
  elapsedMs = 0;
  gapMs = 0; // active time with no sensor data, so no distance
  steps = 0;
  running = false;
  moments = emptyMoments();

  command(cmd) {
    if (cmd === CMD.START) {
      this.sessionId = (Math.random() * 2 ** 32) >>> 0;
      this.elapsedMs = 0;
      this.gapMs = 0;
      this.steps = 0;
      this.running = false;
      this.moments = emptyMoments();
      this.state = STATE.ACTIVE;
    } else if (cmd === CMD.PAUSE && this.state === STATE.ACTIVE) this.state = STATE.PAUSED;
    else if (cmd === CMD.RESUME && this.state === STATE.PAUSED) this.state = STATE.ACTIVE;
    else if (cmd === CMD.STOP) this.state = STATE.STOPPED;
  }

  tick(dt, est) {
    if (this.state !== STATE.ACTIVE) return;
    const c = est.cadence;
    this.running = this.running ? c >= RUN_OFF : c >= RUN_ON;
    const m = this.moments[this.running ? 'run' : 'walk'];
    const n = (c / 60) * dt;
    m.dt += dt;
    m.n += n;
    m.nc += n * c;
    m.ni += n * est.intensity;
    m.ncc += n * c * c;
    this.steps += n;
    this.elapsedMs += Math.round(dt * 1000);
  }

  gap(dt) {
    if (this.state !== STATE.ACTIVE) return;
    this.elapsedMs += Math.round(dt * 1000);
    this.gapMs += Math.round(dt * 1000);
  }
}
