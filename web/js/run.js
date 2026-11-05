import { features, predict, speed, diffMoments } from './model.js';
import { FLAG } from './sensor.js';
import { UNITS, spokenDistance, spokenDuration } from './format.js';

// Live distance for one run. On the treadmill, the link's cumulative sums
// are the source of truth (read every few seconds) and per-second live
// readings fill in between reads so the numbers move smoothly. Outdoors, the
// GPS track gives the distance.
export class RunSession {
  constructor(beta, saved, track = null) {
    this.beta = beta;
    this.track = track;
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
    if (this.track) return;
    this.shown = 0;
    if (this.lastSums) this.onSums(this.lastSums);
  }

  get distance() {
    if (this.track) return this.track.liveDistance;
    return this.base ? this.base.distance + this.extra : 0;
  }

  // Meters per second: smoothed over the last few packets, or over the last
  // GPS_SPEED_S of GPS distance.
  get currentSpeed() {
    if (!this.track) return this.vSmooth;
    const tl = this.timeline;
    const b = tl[tl.length - 1];
    if (!b) return 0;
    let a = null;
    for (let i = tl.length - 2; i >= 0 && b.t - tl[i].t <= GPS_SPEED_S; i--) a = tl[i];
    return a && b.t - a.t >= 5 ? (b.d - a.d) / (b.t - a.t) : 0;
  }
}

// Shorter windows show GPS's slow position drift as pace swings.
const GPS_SPEED_S = 30;
const round1 = (x) => Math.round(x * 10) / 10;

// Cuts an outdoor run into chunks of about CHUNK_M, each pairing the
// accelerometer's moments with the GPS distance over the same stretch. Every
// steady chunk becomes a calibration measurement for treadmill runs. A switch
// between walking and running also ends a chunk, so a walk isn't buried in a
// chunk of running and the walking model gets data of its own.
export const CHUNK_M = 800;
const MIN_CHUNK_M = 200;

export class Chunker {
  constructor(saved) {
    this.chunks = [...(saved?.chunks ?? [])];
    this.start = saved?.start ?? null; // { gps, sums } where the open chunk began
    this.prev = null;
    this.gait = null;
  }

  // gps: GpsTrack.snapshot(); sums: the link's readSums(). Call every tick.
  update(gps, sums) {
    if (!this.start) this.start = { gps, sums };
    const gait = this.prev && gaitBetween(this.prev, sums);
    const d = gps.distance - this.start.gps.distance;
    if (d >= CHUNK_M || (gait && this.gait && gait !== this.gait && d >= MIN_CHUNK_M)) this.#close(gps, sums);
    if (gait) this.gait = gait;
    this.prev = sums;
  }

  // Closes the last chunk if it's long enough to be worth using.
  finish(gps, sums) {
    if (this.start && gps.distance - this.start.gps.distance >= MIN_CHUNK_M) this.#close(gps, sums);
    return this.chunks;
  }

  toJSON() {
    return { chunks: this.chunks, start: this.start };
  }

  #close(gps, sums) {
    const s = this.start;
    const fixes = gps.fixes - s.gps.fixes;
    this.chunks.push({
      moments: diffMoments(sums.moments, s.sums.moments),
      distance: gps.distance - s.gps.distance,
      seconds: (sums.elapsedMs - s.sums.elapsedMs) / 1000,
      gpsGapMs: gps.gapMs - s.gps.gapMs,
      sensorGapMs: sums.gapMs - s.sums.gapMs,
      accuracy: fixes > 0 ? (gps.accuracySum - s.gps.accuracySum) / fixes : Infinity,
    });
    this.start = { gps, sums };
  }
}

// Which gait the session counted between two reads, if it moved at all.
function gaitBetween(a, b) {
  if (b.moments.run.dt > a.moments.run.dt) return 'run';
  if (b.moments.walk.dt > a.moments.walk.dt) return 'walk';
  return null;
}

// A chunk is trusted when the step data never dropped out and GPS was
// reasonably sharp with at most brief losses.
export function usableChunk(c) {
  const steps = c.moments.walk.n + c.moments.run.n;
  return steps > 0 && c.sensorGapMs === 0 && c.gpsGapMs <= c.seconds * 100 && c.accuracy <= 20;
}

// Voice milestones passed going from distance d0 to d1: each whole unit, the
// halfway point and the target.
export function milestones(d0, d1, unitM, targetM) {
  const out = [];
  for (let k = Math.floor(d0 / unitM) + 1; k * unitM <= d1; k++) out.push({ kind: 'split', k, at: k * unitM });
  if (targetM > 0) {
    if (d0 < targetM / 2 && d1 >= targetM / 2) out.push({ kind: 'half', at: targetM / 2 });
    if (d0 < targetM && d1 >= targetM) out.push({ kind: 'target', at: targetM });
  }
  return out.sort((a, b) => a.at - b.at);
}

// What to say for the milestones just passed, e.g. "Mile 2. Split 8 minutes
// 41 seconds. Average pace 8 minutes 50 seconds per mile."
export function announcement(events, timeline, units) {
  const u = UNITS[units];
  const parts = [];
  let last = null;
  for (const e of events) {
    const t = crossingTime(timeline, e.at);
    if (e.kind === 'split') {
      const split = t - crossingTime(timeline, e.at - u.meters);
      parts.push(`${capital(u.word)} ${e.k}. Split ${spokenDuration(split)}.`);
    } else if (e.kind === 'half' && last?.kind === 'split' && e.at - last.at < 1) {
      // Right on a split, the split already said where you are.
      parts.push('Halfway.');
    } else {
      const label = e.kind === 'half' ? 'Halfway' : 'Target reached';
      parts.push(`${label}. ${spokenDistance(e.at, units)} in ${spokenDuration(t)}.`);
    }
    last = { ...e, t };
  }
  if (!last) return '';
  parts.push(`Average pace ${spokenDuration(last.t / (last.at / u.meters))} per ${u.word}.`);
  return parts.join(' ');
}

// Elapsed seconds at which the timeline first reaches distance d.
export function crossingTime(timeline, d) {
  if (!(d > 0) || !timeline.length) return 0;
  if (timeline[0].d >= d) return timeline[0].t;
  for (let i = 1; i < timeline.length; i++) {
    const a = timeline[i - 1];
    const b = timeline[i];
    if (b.d >= d && b.d > a.d) return a.t + ((d - a.d) / (b.d - a.d)) * (b.t - a.t);
  }
  return timeline[timeline.length - 1].t;
}

const capital = (s) => s[0].toUpperCase() + s.slice(1);

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
