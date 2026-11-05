import { features, predict, speed } from './model.js';
import { FLAG } from './sensor.js';

// Live distance for one run. The link's cumulative sums are the source of
// truth (read every few seconds); per-second live readings fill in between
// reads so the numbers move smoothly.
export class RunSession {
  constructor(beta, saved) {
    this.beta = beta;
    this.base = null; // { elapsedMs, distance }
    this.extra = 0; // meters from LIVE packets since base
    this.last = null; // last LIVE packet
    this.vSmooth = 0;
    this.shown = saved?.shown ?? 0;
    this.timeline = saved?.timeline ?? [];
  }

  onSums(sums) {
    this.base = { elapsedMs: sums.elapsedMs, distance: predict(this.beta, features(sums.moments)) };
    this.lastSums = sums;
    // LIVE packets newer than this read are not in it yet.
    const ahead = this.last ? this.last.elapsedMs - sums.elapsedMs : 0;
    this.extra = ahead > 0 ? (this.vLast * ahead) / 1000 : 0;
  }

  onLive(p) {
    const v = p.flags & FLAG.ACTIVE ? speed(this.beta, p.gait, p.cadence, p.intensity) : 0;
    this.vSmooth = this.last ? this.vSmooth + 0.3 * (v - this.vSmooth) : v;
    if (this.base && this.last) {
      const from = Math.max(this.last.elapsedMs, this.base.elapsedMs);
      if (p.elapsedMs > from) this.extra += (v * (p.elapsedMs - from)) / 1000;
    }
    this.vLast = v;
    this.last = p;
    this.shown = Math.max(this.shown, this.distance);

    const t = Math.round(p.elapsedMs / 1000);
    const prev = this.timeline[this.timeline.length - 1];
    if (p.flags & FLAG.ACTIVE && (!prev || t > prev.t)) {
      this.timeline.push({ t, d: round1(this.shown), c: p.cadence, i: p.intensity, hr: p.hr });
    }
  }

  // A refit mid-run (after a calibration segment) changes every distance so
  // far; drop the monotonic floor so the display can move down to it.
  setBeta(beta) {
    this.beta = beta;
    this.shown = 0;
    if (this.lastSums) this.onSums(this.lastSums);
  }

  get distance() {
    return this.base ? this.base.distance + this.extra : 0;
  }

  // Meters per second, smoothed over the last few packets.
  get currentSpeed() {
    return this.vSmooth;
  }
}

const round1 = (x) => Math.round(x * 10) / 10;

// Scales a run's timeline so it ends at the treadmill's distance.
export function rescale(timeline, finalDistance) {
  const last = timeline[timeline.length - 1];
  if (!last || !(last.d > 0)) return timeline;
  const k = finalDistance / last.d;
  return timeline.map((p) => ({ ...p, d: round1(p.d * k) }));
}

// Time at which the timeline crosses each whole unit (mile or km), plus the
// final partial split.
export function splits(timeline, unitM) {
  const out = [];
  let prevT = 0;
  let next = unitM;
  for (let i = 1; i < timeline.length; i++) {
    const a = timeline[i - 1];
    const b = timeline[i];
    while (b.d >= next && b.d > a.d) {
      const t = a.t + ((next - a.d) / (b.d - a.d)) * (b.t - a.t);
      out.push({ n: out.length + 1, fraction: 1, seconds: t - prevT });
      prevT = t;
      next += unitM;
    }
  }
  const last = timeline[timeline.length - 1];
  if (last) {
    const rest = last.d - (next - unitM);
    if (rest > unitM * 0.05) {
      out.push({ n: out.length + 1, fraction: rest / unitM, seconds: last.t - prevT });
    }
  }
  return out;
}

export function averages(timeline) {
  const hr = timeline.filter((p) => p.hr > 0);
  const moving = timeline.filter((p) => p.c > 30);
  return {
    hr: hr.length ? hr.reduce((s, p) => s + p.hr, 0) / hr.length : 0,
    cadence: moving.length ? moving.reduce((s, p) => s + p.c, 0) / moving.length : 0,
  };
}
