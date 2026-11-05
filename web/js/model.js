// Treadmill speed model.
//
// For each gait (walk / run), step length in meters is linear in cadence and
// wrist intensity:
//
//   stepLength = a0 + a1·(cadence − c0)/30 + a2·(intensity − i0)
//
// The watch accumulates per-gait moments over a session — Σn, Σn·c, Σn·I,
// where n is the steps in each 1 s tick — so the distance covered over any
// span is a dot product of the 6 coefficients with 6 features. Every
// calibration observation (a whole run with the treadmill's distance, or a
// steady segment at a known treadmill speed) is therefore one linear equation,
// and fitting is a 6×6 ridge solve pulled toward a height-based prior. With no
// observations the prior alone gives a generic estimate; each observation
// tightens the coefficients it actually informs.

export const GAITS = ['walk', 'run'];

// Reference cadence (spm) and intensity (g) each gait's a0 is defined at.
export const REF = {
  walk: { c0: 115, i0: 0.25 },
  run: { c0: 165, i0: 0.9 },
};

// Observations lose half their weight every HALF_LIFE_DAYS, so the model
// follows changes in fitness, shoes or form.
const HALF_LIFE_DAYS = 180;
const MIN_STEP_M = 0.2;
const MAX_STEP_M = 2.5;

// Typical error of the uncalibrated (prior-only) model, for display.
export const UNCALIBRATED_ERROR = 0.12;

export function emptyMoments() {
  const zero = () => ({ dt: 0, n: 0, nc: 0, ni: 0, ncc: 0 });
  return { walk: zero(), run: zero() };
}

export function diffMoments(a, b) {
  const out = {};
  for (const g of GAITS) {
    out[g] = {};
    for (const k of Object.keys(a[g])) out[g][k] = a[g][k] - b[g][k];
  }
  return out;
}

export function features(m) {
  const f = [];
  for (const g of GAITS) {
    const { c0, i0 } = REF[g];
    const x = m[g];
    f.push(x.n, (x.nc - c0 * x.n) / 30, x.ni - i0 * x.n);
  }
  return f;
}

// Average cadence and active time of a span, for charts and summaries.
export function summarize(m) {
  const n = m.walk.n + m.run.n;
  const dt = m.walk.dt + m.run.dt;
  return {
    steps: n,
    seconds: dt,
    cadence: n > 0 ? (m.walk.nc + m.run.nc) / n : 0,
    intensity: n > 0 ? (m.walk.ni + m.run.ni) / n : 0,
    runShare: n > 0 ? m.run.n / n : 0,
  };
}

// Generic step-length model scaled by height. Means follow common
// height-ratio rules (walking step ≈ 0.415·h; an easy running step at
// 165 spm ≈ 0.6·h); the SDs are wide enough for calibration to move them.
export function prior(heightM) {
  const h = heightM > 1 && heightM < 2.5 ? heightM : 1.75;
  return {
    mean: [0.415 * h, 0.05 * h, 0, 0.6 * h, 0.2 * h, 0],
    sd: [0.06 * h, 0.04 * h, 0.3, 0.07 * h, 0.1 * h, 0.4],
  };
}

export function predict(beta, f) {
  let d = 0;
  for (let k = 0; k < 6; k++) d += beta[k] * f[k];
  return d;
}

export function stepLength(beta, gait, cadence, intensity) {
  const k = gait === 'run' ? 3 : 0;
  const { c0, i0 } = REF[gait];
  const L = beta[k] + (beta[k + 1] * (cadence - c0)) / 30 + beta[k + 2] * (intensity - i0);
  return Math.min(MAX_STEP_M, Math.max(MIN_STEP_M, L));
}

// Meters per second.
export function speed(beta, gait, cadence, intensity) {
  if (!(cadence > 30)) return 0;
  return (cadence / 60) * stepLength(beta, gait, cadence, intensity);
}

// observations: [{ id, t, moments, distance, sigma, include }]
// Returns the fitted coefficients plus a leave-one-out error estimate.
export function fit(observations, pri, now = Date.now()) {
  const used = observations
    .filter((o) => o.include !== false && o.distance > 0)
    .map((o) => ({ ...o, f: features(o.moments) }));
  const beta = solveMap(used, pri, now);
  return { beta, count: used.length, error: looError(used, pri, now) };
}

// How far off each observation would have been had the model been fitted
// without it. Honest with small data sets, where in-sample residuals flatter.
function looError(used, pri, now) {
  if (used.length < 2) return null;
  const byId = {};
  let ss = 0;
  for (const o of used) {
    const b = solveMap(used.filter((x) => x !== o), pri, now);
    const e = predict(b, o.f) / o.distance - 1;
    byId[o.id] = e;
    ss += e * e;
  }
  return { rms: Math.sqrt(ss / used.length), byId };
}

function weight(o, now) {
  const ageDays = Math.max(0, (now - o.t) / 86400000);
  const sigma = (o.sigma ?? 0.01) * o.distance * Math.pow(2, ageDays / HALF_LIFE_DAYS);
  return 1 / (sigma * sigma);
}

// MAP estimate under Gaussian noise and prior:
//   (Σ w·fᵀf + P) β = Σ w·D·f + P·μ,   P = diag(1/sd²)
function solveMap(used, pri, now) {
  const n = 6;
  const A = Array.from({ length: n }, () => new Array(n).fill(0));
  const b = new Array(n).fill(0);
  for (let k = 0; k < n; k++) {
    const p = 1 / (pri.sd[k] * pri.sd[k]);
    A[k][k] += p;
    b[k] += pri.mean[k] * p;
  }
  for (const o of used) {
    const w = weight(o, now);
    for (let i = 0; i < n; i++) {
      if (!o.f[i]) continue;
      b[i] += w * o.distance * o.f[i];
      for (let j = 0; j < n; j++) A[i][j] += w * o.f[i] * o.f[j];
    }
  }
  return solve(A, b);
}

// Gaussian elimination with partial pivoting.
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const k = M[r][c] / M[c][c];
      for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let j = r + 1; j < n; j++) s -= M[r][j] * x[j];
    x[r] = s / M[r][r];
  }
  return x;
}
