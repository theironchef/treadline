import { CadenceEstimator, Session, CMD, STATE, FLAG } from './sensor.js';

// Sensor links. Each runs the estimator once a second and emits:
//   'status' — 'disconnected' | 'connected'
//   'live'   — { cadence, intensity, quality, flags, gait, elapsedMs, gapMs,
//                steps, sessionId, hr, carry }, carry being the
//                where-on-the-body features (or null)
// and answers readSums() with the session's cumulative moments.

// A tick arriving later than this means the page was frozen (screen off or
// app switched): that time counts as a gap, not as zero-cadence running.
const MAX_TICK_S = 3;

class LocalLink extends EventTarget {
  status = 'disconnected';
  session = new Session();
  estimator = new CadenceEstimator();
  #timer = null;
  #last = null;

  get connected() {
    return this.status === 'connected';
  }

  async readSums() {
    const s = this.session;
    return {
      sessionId: s.sessionId,
      elapsedMs: s.elapsedMs,
      gapMs: s.gapMs,
      steps: Math.floor(s.steps),
      state: s.state,
      moments: structuredClone(s.moments),
    };
  }

  async control(cmd) {
    this.session.command(cmd);
  }

  disconnect() {
    clearInterval(this.#timer);
    this.#timer = null;
    this.#set('disconnected');
  }

  _startTicking(intervalMs) {
    clearInterval(this.#timer);
    this.#last = null;
    this.#timer = setInterval(() => this._tick(), intervalMs);
    this.#set('connected');
  }

  _tick(now = this._now()) {
    const dt = this.#last == null ? 0 : now - this.#last;
    this.#last = now;
    const est = this.estimator.estimate(now);
    if (dt > MAX_TICK_S) this.session.gap(dt);
    else if (dt > 0) this.session.tick(dt, est);

    const s = this.session;
    let flags = 0;
    if (s.running) flags |= FLAG.RUN;
    if (s.state === STATE.ACTIVE) flags |= FLAG.ACTIVE;
    if (s.state === STATE.PAUSED) flags |= FLAG.PAUSED;
    const detail = {
      cadence: est.cadence,
      intensity: est.intensity,
      quality: est.quality,
      hr: 0,
      flags,
      gait: s.running ? 'run' : 'walk',
      elapsedMs: s.elapsedMs,
      gapMs: s.gapMs,
      steps: Math.floor(s.steps),
      sessionId: s.sessionId,
      carry: est.carry ?? null,
    };
    this.dispatchEvent(new CustomEvent('live', { detail }));
  }

  #set(status) {
    if (this.status === status) return;
    this.status = status;
    this.dispatchEvent(new CustomEvent('status', { detail: status }));
  }
}

// The phone's own accelerometer. It only reports while the page is visible,
// so the app holds a screen wake lock during runs.
export class PhoneLink extends LocalLink {
  name = 'Phone';
  lastSampleAt = 0;

  static supported() {
    return 'DeviceMotionEvent' in window;
  }

  #onMotion = (e) => {
    const a = e.accelerationIncludingGravity;
    if (a?.x == null) return;
    this.lastSampleAt = performance.now();
    this.estimator.addAccel(e.timeStamp / 1000, a.x, a.y, a.z);
  };

  // Starts listening without asking. Android sends motion data straight away;
  // iOS sends nothing until pick() has asked, which needs a tap.
  listen() {
    window.removeEventListener('devicemotion', this.#onMotion);
    window.addEventListener('devicemotion', this.#onMotion);
    if (!this.connected) this._startTicking(1000);
  }

  // From a tap: ask for permission where the browser wants that, then listen.
  async pick() {
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      if ((await DeviceMotionEvent.requestPermission()) !== 'granted') {
        throw new Error('Motion access is blocked. Allow motion sensors for this site in the browser’s settings.');
      }
    }
    this.listen();
  }

  // Whether motion data is actually arriving. (lastSampleAt starts at 0, so
  // check for a sample at all: performance.now() is small just after load.)
  get receiving() {
    return this.lastSampleAt > 0 && performance.now() - this.lastSampleAt < 3000;
  }

  disconnect() {
    window.removeEventListener('devicemotion', this.#onMotion);
    super.disconnect();
  }

  _now() {
    return performance.now() / 1000;
  }
}

// A runner on a treadmill program, synthesized as raw accelerometer samples
// so the whole pipeline (estimator, session, model, UI) runs without a
// device. ?sim=20 runs 20× faster.
const MPH = 0.44704;
const G = 9.80665;
// [duration s, treadmill mph]
const PROGRAM = [
  [180, 3.5],
  [480, 6.0],
  [420, 7.0],
  [300, 6.5],
  [Infinity, 6.0],
];

export class SimLink extends LocalLink {
  name = 'Simulator';
  treadmillMeters = 0;
  #speedup;
  #program;
  #t = 0;
  #phase = 0;
  #drift = 0;

  // place: where the simulated phone rides, 'pocket', 'armband' or 'waist'.
  constructor(speedup = 1, program = PROGRAM, place = 'pocket') {
    super();
    this.#speedup = speedup;
    this.#program = program;
    this.place = place;
  }

  static supported() {
    return true;
  }

  async pick() {
    this._startTicking(1000 / this.#speedup);
  }

  async control(cmd) {
    if (cmd === CMD.START) this.treadmillMeters = 0;
    return super.control(cmd);
  }

  _now() {
    return this.#t;
  }

  _tick() {
    const active = this.session.state === STATE.ACTIVE;
    const mph = active ? programMph(this.#program, this.session.elapsedMs / 1000) : 0;
    this.#drift += 0.2 * (gauss() - this.#drift * 0.3);
    const { cadence, amp } = runner(mph);
    const c = cadence > 0 ? cadence + this.#drift : 0;
    for (let k = 1; k <= 50; k++) {
      this.#phase += c / 60 / 50;
      const a = carrySample(this.#phase, amp, this.place);
      this.estimator.addAccel(this.#t + k / 50, a.x, a.y, a.z);
    }
    this.#t += 1;
    if (active) this.treadmillMeters += mph * MPH;
    super._tick(this.#t);
  }
}

function programMph(program, t) {
  let end = 0;
  for (const [dur, mph] of program) {
    end += dur;
    if (t < end) return mph;
  }
  return 0;
}

// How the simulated runner moves at a given treadmill speed.
function runner(mph) {
  if (mph <= 0) return { cadence: 0, amp: 0 };
  if (mph <= 4.5) return { cadence: 108 + 5 * (mph - 3), amp: 2 + 0.6 * (mph - 3) };
  return { cadence: 158 + 4 * (mph - 5.5), amp: 6 + 1.2 * (mph - 5.5) };
}

// Acceleration magnitude of a pocketed phone: a foot-strike pulse each step
// (the near leg's stronger), a stride-rate leg swing, and sensor noise.
export function synth(phase, amp) {
  const within = phase % 1;
  const near = Math.floor(phase) % 2 === 0;
  const pulse = Math.exp(-((within - 0.1) ** 2) / 0.004) * (near ? 1 : 0.7);
  const swing = Math.sin(Math.PI * phase);
  return G + amp * (2.2 * pulse + 0.6 * swing) + (0.05 + 0.25 * amp) * gauss();
}

// The same runner as the phone feels it on each spot, in the phone's own
// axes (m/s²). The body's up, forward and side accelerations are tilted by
// the limb's swing: a thigh rocks about ±20° walking and ±35° running, an
// upper arm about ±12–22°, the pelvis a few degrees. On the thigh the far
// foot's strike arrives at about 40% of the near one's; the arm gets both
// softened. Everyone sways side to side once per stride. Numbers scale with
// `amp`, about 2 walking and 6–8 running.
const CARRY = {
  pocket: { tilt: [15, 3], far: 0.4, impact: 1, swing: 0.6 },
  armband: { tilt: [8, 2], far: 0.9, impact: 0.45, swing: 0.45 },
  waist: { tilt: [2, 0.2], far: 0.9, impact: 0.9, swing: 0.08 },
};
const SWAY = 0.25;

export function carrySample(phase, amp, place = 'pocket') {
  const c = CARRY[place];
  const near = Math.floor(phase) % 2 === 0;
  const pulse = Math.exp(-(((phase % 1) - 0.1) ** 2) / 0.004) * (near ? 1 : c.far);
  const stride = Math.PI * phase; // one cycle every two steps
  const up = G + amp * (2.2 * c.impact * pulse + 0.3 * Math.cos(2 * Math.PI * phase));
  const forward = c.swing * amp * Math.sin(stride + 0.5);
  const side = SWAY * amp * Math.sin(stride);
  const tilt = (((c.tilt[0] + c.tilt[1] * amp) * Math.PI) / 180) * Math.sin(stride);
  const noise = 0.05 + 0.15 * amp;
  return {
    x: side + noise * gauss(),
    y: up * Math.cos(tilt) + forward * Math.sin(tilt) + noise * gauss(),
    z: -up * Math.sin(tilt) + forward * Math.cos(tilt) + noise * gauss(),
  };
}

function gauss() {
  return (Math.random() + Math.random() + Math.random() - 1.5) * 1.41;
}
