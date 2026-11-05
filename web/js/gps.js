// GPS distance for outdoor runs.
//
// Raw phone fixes jitter by a few meters each second. Summing fix-to-fix
// distances turns that jitter into extra distance (5–10% at running pace, far
// more when walking), so fixes go through a constant-velocity Kalman filter,
// and distance is only counted once the filtered position has moved ANCHOR_M
// from the last counted point. Fixes worse than MAX_ACCURACY_M are ignored.

const M_PER_DEG = (6371008.8 * Math.PI) / 180;
const MAX_ACCURACY_M = 30;
const ANCHOR_M = 12;
// Process noise: how hard a runner can change velocity, m/s².
const ACCEL = 1.2;
// Fixes further apart than this count as lost signal.
const GAP_MS = 10000;
// A fix this far outside the filter's prediction is a glitch; after
// MAX_REJECTS in a row, the filter restarts at the new position instead.
const REJECT_SIGMAS = 4;
const REJECT_MIN_M = 25;
const MAX_REJECTS = 4;

export class GpsTrack {
  distance = 0;
  gapMs = 0;
  fixes = 0;
  accuracySum = 0;
  lastFixAt = null;
  #origin = null;
  #x = null; // filter state per axis: { p, v, P: [p00, p01, p11] }
  #y = null;
  #t = null;
  #anchor = null;
  #rejects = 0;
  #paused = false;

  // fix: { t (ms), lat, lon, accuracy (m) }. Returns meters added.
  add(fix) {
    if (this.#paused || !(fix.accuracy <= MAX_ACCURACY_M)) return 0;
    if (!this.#origin) this.#origin = { lat: fix.lat, lon: fix.lon, cos: Math.cos((fix.lat * Math.PI) / 180) };
    const z = this.#project(fix);
    const r = (fix.accuracy / 1.5) ** 2;

    if (!this.#x) return this.#reset(fix, z, r), 0;
    const dt = (fix.t - this.#t) / 1000;
    if (!(dt > 0)) return 0;

    const px = predict(this.#x, dt);
    const py = predict(this.#y, dt);
    const miss = Math.hypot(z.x - px.p, z.y - py.p);
    const sigma = Math.sqrt(Math.max(px.P[0], py.P[0]) + r);
    if (miss > REJECT_SIGMAS * sigma && miss > REJECT_MIN_M && ++this.#rejects < MAX_REJECTS) return 0;

    if (dt * 1000 > GAP_MS) this.gapMs += dt * 1000;
    this.#count(fix);
    if (this.#rejects >= MAX_REJECTS) {
      // Reacquired somewhere else (after a tunnel, say): bridge in a straight
      // line, as a lost signal would anyway.
      const before = this.distance;
      this.#reset(fix, z, r);
      this.#advance(z, true);
      return this.distance - before;
    }
    this.#rejects = 0;
    this.#x = update(px, z.x, r);
    this.#y = update(py, z.y, r);
    this.#t = fix.t;
    const before = this.distance;
    this.#advance({ x: this.#x.p, y: this.#y.p });
    return this.distance - before;
  }

  // While paused fixes are ignored, and the first fix after resuming starts
  // fresh, so walking around during a pause doesn't count. Pausing (or
  // finishing) keeps the stretch run since the last counted point.
  pause() {
    if (this.#paused) return;
    this.distance = this.liveDistance;
    this.#paused = true;
  }

  resume() {
    this.#paused = false;
    this.#x = null;
    this.#anchor = null;
  }

  // distance plus the stretch since the last counted point. Moves smoothly,
  // where distance moves in ANCHOR_M steps, so it's what the screen and the
  // live pace use.
  get liveDistance() {
    if (this.#paused || !this.#x || !this.#anchor) return this.distance;
    return this.distance + Math.hypot(this.#x.p - this.#anchor.x, this.#y.p - this.#anchor.y);
  }

  get accuracy() {
    return this.fixes ? this.accuracySum / this.fixes : 0;
  }

  snapshot() {
    return { distance: this.distance, gapMs: this.gapMs, fixes: this.fixes, accuracySum: this.accuracySum };
  }

  #reset(fix, z, r) {
    const P = [r, 0, 9];
    this.#x = { p: z.x, v: 0, P };
    this.#y = { p: z.y, v: 0, P: [...P] };
    this.#t = fix.t;
    this.#rejects = 0;
    if (!this.#anchor) {
      this.#anchor = z;
      this.#count(fix);
    }
  }

  #advance(pos, force = false) {
    const d = Math.hypot(pos.x - this.#anchor.x, pos.y - this.#anchor.y);
    if (d >= ANCHOR_M || force) {
      this.distance += d;
      this.#anchor = pos;
    }
  }

  #count(fix) {
    this.fixes++;
    this.accuracySum += fix.accuracy;
    this.lastFixAt = fix.t;
  }

  #project(fix) {
    const o = this.#origin;
    return { x: (fix.lon - o.lon) * o.cos * M_PER_DEG, y: (fix.lat - o.lat) * M_PER_DEG };
  }
}

function predict(s, dt) {
  const q = ACCEL * ACCEL;
  const [p00, p01, p11] = s.P;
  return {
    p: s.p + s.v * dt,
    v: s.v,
    P: [
      p00 + 2 * dt * p01 + dt * dt * p11 + (q * dt ** 4) / 4,
      p01 + dt * p11 + (q * dt ** 3) / 2,
      p11 + q * dt * dt,
    ],
  };
}

function update(s, z, r) {
  const [p00, p01, p11] = s.P;
  const S = p00 + r;
  const k0 = p00 / S;
  const k1 = p01 / S;
  const y = z - s.p;
  return {
    p: s.p + k0 * y,
    v: s.v + k1 * y,
    P: [(1 - k0) * p00, (1 - k0) * p01, p11 - k1 * p01],
  };
}

// ---------- sources ----------
// Each emits 'fix' { t, lat, lon, accuracy } and 'status' with .status one of
// 'off' | 'waiting' | 'ok' | 'denied' | 'error'.

class GpsSource extends EventTarget {
  status = 'off';
  last = null;

  _fix(fix) {
    this.last = fix;
    this.lastAt = performance.now();
    this._set('ok');
    this.dispatchEvent(new CustomEvent('fix', { detail: fix }));
  }

  _set(status, message = '') {
    this.message = message;
    if (this.status === status) return;
    this.status = status;
    this.dispatchEvent(new CustomEvent('status', { detail: status }));
  }
}

export class PhoneGps extends GpsSource {
  #watch = null;

  static supported() {
    return 'geolocation' in navigator;
  }

  start() {
    if (this.#watch != null) return;
    this._set('waiting');
    this.#watch = navigator.geolocation.watchPosition(
      (p) => this._fix({ t: p.timestamp, lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => {
        // Timeouts are routine (no fix yet); keep watching.
        if (e.code === e.PERMISSION_DENIED) {
          this.stop();
          this._set('denied', 'Location is blocked. Allow it for this site in Chrome’s site settings.');
        } else if (e.code !== e.TIMEOUT) {
          this._set('error', e.message);
        }
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 },
    );
  }

  stop() {
    if (this.#watch != null) navigator.geolocation.clearWatch(this.#watch);
    this.#watch = null;
    this._set('off');
  }
}

// GPS for the simulated runner: follows a ~930 m loop at the simulator's
// true speed, with the drifting error plus jitter that real fixes have.
const SIM_ORIGIN = { lat: 43.0, lon: -88.0 };

export class SimGps extends GpsSource {
  #link;
  #ex = 0;
  #ey = 0;

  constructor(link) {
    super();
    this.#link = link;
  }

  start() {
    if (this.status !== 'off') return;
    this._set('waiting');
    this.#link.addEventListener('live', this.#onTick);
  }

  stop() {
    this.#link.removeEventListener('live', this.#onTick);
    this._set('off');
  }

  #onTick = () => {
    const rho = 0.95;
    this.#ex = rho * this.#ex + 3 * Math.sqrt(1 - rho * rho) * gauss();
    this.#ey = rho * this.#ey + 3 * Math.sqrt(1 - rho * rho) * gauss();
    const pos = loopPoint(this.#link.treadmillMeters);
    const x = pos.x + this.#ex + gauss();
    const y = pos.y + this.#ey + gauss();
    this._fix({
      t: this.#link._now() * 1000,
      lat: SIM_ORIGIN.lat + y / M_PER_DEG,
      lon: SIM_ORIGIN.lon + x / (M_PER_DEG * Math.cos((SIM_ORIGIN.lat * Math.PI) / 180)),
      accuracy: 4 + Math.abs(gauss()),
    });
  };
}

// A rounded rectangle: 320 × 160 m with 15 m corner radius.
const LOOP = { w: 320, h: 160, r: 15 };

export function loopLength(loop = LOOP) {
  return 2 * (loop.w - 2 * loop.r) + 2 * (loop.h - 2 * loop.r) + 2 * Math.PI * loop.r;
}

export function loopPoint(s, loop = LOOP) {
  const { w, h, r } = loop;
  const a = w - 2 * r;
  const b = h - 2 * r;
  const arc = (Math.PI * r) / 2;
  // Straight, corner, straight, corner... counter-clockwise from the bottom left.
  const parts = [
    [a, (t) => ({ x: r + t, y: 0 })],
    [arc, (t) => corner(w - r, r, -Math.PI / 2, t / r)],
    [b, (t) => ({ x: w, y: r + t })],
    [arc, (t) => corner(w - r, h - r, 0, t / r)],
    [a, (t) => ({ x: w - r - t, y: h })],
    [arc, (t) => corner(r, h - r, Math.PI / 2, t / r)],
    [b, (t) => ({ x: 0, y: h - r - t })],
    [arc, (t) => corner(r, r, Math.PI, t / r)],
  ];
  let rest = ((s % loopLength(loop)) + loopLength(loop)) % loopLength(loop);
  for (const [len, at] of parts) {
    if (rest <= len) return at(rest);
    rest -= len;
  }
  return parts[0][1](0);

  function corner(cx, cy, from, angle) {
    return { x: cx + r * Math.cos(from + angle), y: cy + r * Math.sin(from + angle) };
  }
}

function gauss() {
  return (Math.random() + Math.random() + Math.random() - 1.5) * 1.41;
}
