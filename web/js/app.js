import * as store from './store.js';
import { fit, prior, predict, features, diffMoments, summarize, speed, REF, UNCALIBRATED_ERROR } from './model.js';
import { RunSession, Chunker, rescale, splits, milestones, announcement, usableChunk } from './run.js';
import { CMD } from './sensor.js';
import { PhoneLink, SimLink } from './links.js';
import { PhoneGps, SimGps, GpsTrack } from './gps.js';
import * as club from './club.js';
import { BUILD } from './version.js';
import * as fmt from './format.js';
import { UNITS } from './format.js';

const params = new URLSearchParams(location.search);
// ?sim or ?sim=20 swaps the phone's accelerometer (and GPS) for a simulated
// runner.
const SIM = params.has('sim') ? Number(params.get('sim')) || 1 : 0;

const PLACEMENTS = { pocket: 'Front pocket', armband: 'Armband', waist: 'Waistband' };
const MIN_SEGMENT_S = 60;
// How long to wait for motion data before offering the Enable button.
const SENSOR_GRACE_MS = 2000;
// GPS stretches are noisier than a treadmill's readout, so they count for less.
const GPS_SIGMA = 0.02;
// A GPS stretch this far from the current model is assumed bad (a GPS jump,
// the phone moved) and isn't used.
const MAX_GPS_ERR = 0.25;
const WHEEL_ITEM = 40;
const MAX_TARGET = 50;
// The club everyone joins: a Google Sheet running leaderboard/Code.gs (see
// README → Leaderboard). Built in so joining is just a name and a tap; the
// trade-off is that anyone who reads this file could post runs to it.
const CLUB_URL = 'https://script.google.com/macros/s/AKfycbwO95odoboU39sY4eSCQl4ero0OtO3UtPVw7SvytQiGc93JHVrH38z-DEs2bGOK32_8/exec';
// The simulator joins the local stand-in instead, so simulated runs never
// reach the real club.
const DEV_CLUB_URL = 'http://localhost:5175/exec';
const defaultClub = () => (SIM ? DEV_CLUB_URL : CLUB_URL);
// How long the Club tab trusts the board it last fetched.
const CLUB_STALE_MS = 60000;

const S = {
  // Saved as-is; targetM is meters, 0 for an open run.
  settings: {
    units: 'mi',
    heightM: 1.75,
    placement: 'pocket',
    voice: true,
    segmentSpeed: '',
    mode: 'indoor',
    targetM: 3 * UNITS.mi.meters,
    // Club: member is a random id for this phone, so a name can change.
    name: '',
    member: '',
    clubUrl: '',
    clubShare: true,
  },
  runs: [],
  observations: [],
  model: null,
  link: null,
  gps: null,
  live: null,
  screen: 'home',
  runId: null,
  active: null,
  finish: null,
  locked: false,
  club: { data: null, at: 0, tried: 0, loading: false, error: null },
  clubInvite: null, // a club link from an invite, waiting for Join
};

// In the simulator, devtools can reach the state, e.g. to fast-forward with
// treadline.link._tick().
if (SIM) window.treadline = S;

const $app = document.getElementById('app');
const source = () => (SIM ? 'sim' : S.settings.placement);
const unit = () => UNITS[S.settings.units];
const $ = (id) => document.getElementById(id);

// ---------- boot ----------

async function boot() {
  const [settings, runs, observations, unfinished] = await Promise.all([
    store.getKv('settings'),
    store.all('runs'),
    store.all('observations'),
    store.getKv('activeRun'),
  ]);
  Object.assign(S.settings, settings);
  // The previous version called indoor runs 'treadmill'.
  if (S.settings.mode !== 'outdoor') S.settings.mode = 'indoor';
  if (!S.settings.member) {
    S.settings.member = store.newId();
    saveSettings();
  }
  takeInvite();
  S.runs = runs.sort((a, b) => b.startedAt - a.startedAt);
  S.observations = observations;
  S.unfinished = unfinished;
  refit();
  render();
  store.persist();
  flushClub();
  // Android sends motion data without asking, so listen straight away. Newer
  // Chrome has the same permission call as iOS, but doesn't need it; the
  // Enable button only appears if no data arrives (iOS, or access blocked).
  if (SIM) enableSensor();
  else if (PhoneLink.supported()) link().listen();
  S.sensorGrace = performance.now() + SENSOR_GRACE_MS;
  setTimeout(() => S.screen === 'home' && updateCheck(), SENSOR_GRACE_MS + 100);
  if ('serviceWorker' in navigator && !SIM) navigator.serviceWorker.register('sw.js').catch(() => {});
}

function refit() {
  const obs = S.observations
    .filter((o) => o.source === source())
    .map((o) => (o.kind === 'gps' ? { ...o, group: o.runId } : o));
  S.model = fit(obs, prior(S.settings.heightM));
  S.active?.rs.setBeta(S.model.beta);
}

function saveSettings() {
  store.setKv('settings', S.settings);
}

// ---------- sensor ----------

function link() {
  if (!S.link) {
    S.link = SIM ? new SimLink(SIM) : new PhoneLink();
    S.link.addEventListener('live', (e) => onLive(e.detail));
    S.link.addEventListener('status', () => S.screen === 'home' && render());
  }
  return S.link;
}

async function enableSensor() {
  if (!SIM && !PhoneLink.supported()) return toast('This browser has no motion sensor access');
  try {
    await link().pick();
  } catch (e) {
    toast(e.message);
  }
}

function onLive(p) {
  S.live = p;
  const a = S.active;
  if (a && p.sessionId === a.sessionId) {
    a.rs.onLive(p);
    if (a.chunker) S.link.readSums().then((sums) => a.chunker.update(a.track.snapshot(), sums));
    announce(a);
  }
  if (S.screen === 'live') updateLive();
  else if (S.screen === 'home') updateCheck();
}

// Whether to offer the Enable button: no motion data, and the grace period
// for it to start arriving is over.
const sensorStuck = () => !SIM && !S.link?.receiving && performance.now() > (S.sensorGrace ?? 0);

function signal(p) {
  if (!p || !S.link?.connected || S.link.receiving === false) return { cls: 'off', text: 'Sensor off' };
  if (p.cadence === 0 && p.intensity < 0.04) return { cls: 'idle', text: 'Still' };
  if (p.quality >= 0.5) return { cls: 'ok', text: 'Strong rhythm' };
  if (p.quality >= 0.3) return { cls: 'ok', text: 'Rhythm OK' };
  return { cls: 'weak', text: 'Weak signal' };
}

// ---------- GPS ----------

function gps() {
  if (!S.gps) {
    S.gps = SIM ? new SimGps(link()) : new PhoneGps();
    S.gps.addEventListener('fix', (e) => {
      const a = S.active;
      if (a?.track && !a.paused) a.track.add(e.detail);
      if (S.screen === 'home') updateCheck();
    });
    S.gps.addEventListener('status', () => S.screen === 'home' && updateCheck());
  }
  return S.gps;
}

// GPS runs during outdoor runs and on the start screen in outdoor mode (so
// it has a fix by the time you start), and is off otherwise to save battery.
function syncGps() {
  const want = S.active?.track || (S.screen === 'home' && S.settings.mode === 'outdoor');
  if (!want) S.gps?.stop();
  else if (SIM || PhoneGps.supported()) {
    if (gps().status !== 'denied') gps().start();
  }
}

function gpsSignal() {
  const g = S.gps;
  if (!SIM && !PhoneGps.supported()) return { cls: 'weak', text: 'No GPS in this browser' };
  if (!g || g.status === 'off') return { cls: 'off', text: 'GPS off' };
  if (g.status === 'denied') return { cls: 'weak', text: 'Location blocked' };
  if (g.status === 'error') return { cls: 'weak', text: 'GPS unavailable' };
  if (!g.last) return { cls: 'idle', text: 'Finding GPS…' };
  if (performance.now() - g.lastAt > 10000) return { cls: 'weak', text: 'GPS signal lost' };
  const acc = Math.round(g.last.accuracy);
  return acc <= 15 ? { cls: 'ok', text: `GPS ±${acc} m` } : { cls: 'weak', text: `GPS weak ±${acc} m` };
}

// ---------- run lifecycle ----------

async function startRun() {
  saveTarget();
  const outdoor = S.settings.mode === 'outdoor';
  if (outdoor) {
    if (!SIM && !PhoneGps.supported()) return toast('This browser has no location access');
    gps().start();
    if (S.gps.status === 'denied') return toast(S.gps.message);
  }
  const l = link();
  // This tap is the chance to ask for motion access if the browser wants
  // that (iOS); on Android data is already flowing.
  if (SIM ? !l.connected : !l.receiving) await enableSensor();
  if (!l.connected) return;
  if (outdoor && !S.gps.last) toast('No GPS fix yet. Distance starts counting once it locks on.');
  await l.control(CMD.START);
  const sums = await l.readSums();
  const track = outdoor ? new GpsTrack() : null;
  const rs = new RunSession(S.model.beta, null, track);
  rs.onSums(sums);
  const target = S.settings.targetM >= 0.05 * unit().meters ? S.settings.targetM : 0;
  S.active = {
    id: store.newId(),
    startedAt: Date.now(),
    sessionId: sums.sessionId,
    source: source(),
    mode: outdoor ? 'outdoor' : 'indoor',
    target,
    track,
    chunker: outdoor ? new Chunker() : null,
    rs,
    lastSums: sums,
    paused: false,
    segment: null,
    segmentForm: false,
    spokenTo: 0,
  };
  S.active.timers = [setInterval(syncSums, 3000), setInterval(saveActive, 10000)];
  S.locked = false;
  wakeLock(true);
  speak(`${outdoor ? 'Outdoor' : 'Indoor'} run started.${target ? ` Target ${fmt.spokenDistance(target, S.settings.units)}.` : ''}`);
  go('live');
}

async function syncSums() {
  const a = S.active;
  if (!a) return;
  const sums = await S.link.readSums();
  if (sums.sessionId !== a.sessionId) return;
  a.rs.onSums(sums);
  a.lastSums = sums;
}

// Enough to finish the run later if the page is closed or reloaded mid-run.
function saveActive() {
  const a = S.active;
  if (!a) return;
  store.setKv('activeRun', runState(a, a.lastSums));
}

function runState(a, sums) {
  return {
    id: a.id,
    startedAt: a.startedAt,
    source: a.source,
    mode: a.mode,
    target: a.target,
    sums,
    timeline: a.rs.timeline,
    gps: a.track?.snapshot(),
    chunker: a.chunker?.toJSON(),
  };
}

async function togglePause() {
  const a = S.active;
  a.paused = !a.paused;
  if (a.paused) a.segment = null;
  if (a.track) a.paused ? a.track.pause() : a.track.resume();
  await S.link.control(a.paused ? CMD.PAUSE : CMD.RESUME);
  speak(a.paused ? 'Paused' : 'Resumed');
  renderLive();
}

async function finishRun() {
  const a = S.active;
  await S.link.control(CMD.PAUSE);
  const sums = await S.link.readSums();
  await S.link.control(CMD.STOP);
  a.track?.pause();
  a.timers.forEach(clearInterval);
  S.active = null;
  wakeLock(false);
  openFinish(runState(a, sums));
}

function openFinish(saved) {
  const beta = S.model.beta;
  const estimate = predict(beta, features(saved.sums.moments));
  let outdoor = null;
  if (saved.mode === 'outdoor') {
    const chunks = new Chunker(saved.chunker).finish(saved.gps, saved.sums);
    const good = chunks.filter(
      (c) => usableChunk(c) && Math.abs(predict(beta, features(c.moments)) / c.distance - 1) <= MAX_GPS_ERR,
    );
    // Without a GPS fix there's nothing better than the accelerometer.
    const gpsOk = saved.gps.fixes > 1 && saved.gps.distance > 0;
    outdoor = { good, gpsOk, distance: gpsOk ? saved.gps.distance : estimate };
  }
  S.finish = { ...saved, estimate, outdoor, simTruth: S.link?.treadmillMeters };
  store.setKv('activeRun', saved);
  go('finish');
}

async function saveRun() {
  const f = S.finish;
  const o = f.outdoor;
  const typed = o ? NaN : parseFloat($('measured').value);
  const measured = typed > 0 ? typed * unit().meters : null;
  const distance = o ? o.distance : (measured ?? f.estimate);
  const sum = summarize(f.sums.moments);
  const run = {
    id: f.id,
    startedAt: f.startedAt,
    source: f.source,
    mode: o ? 'outdoor' : 'indoor',
    target: f.target ?? 0,
    seconds: f.sums.elapsedMs / 1000,
    gapSeconds: f.sums.gapMs / 1000,
    distance,
    estimate: f.estimate,
    // A distance typed in from a treadmill or track. The name predates
    // indoor runs that aren't on a treadmill.
    treadmill: !!measured,
    gps: o?.gpsOk ? { accuracy: f.gps.accuracySum / f.gps.fixes, gapSeconds: f.gps.gapMs / 1000 } : null,
    steps: f.sums.steps,
    cadence: sum.cadence,
    moments: f.sums.moments,
    timeline: o ? f.timeline : rescale(f.timeline, distance),
  };
  await store.put('runs', run);
  S.runs.unshift(run);
  const base = { runId: f.id, source: f.source, t: f.startedAt, include: $('useCal').checked };
  const obs = measured
    ? [{ ...base, id: `run-${f.id}`, kind: 'run', moments: f.sums.moments, distance: measured, seconds: run.seconds, sigma: 0.01 }]
    : (o?.good ?? []).map((c, k) => ({
        ...base,
        id: `gps-${f.id}-${k}`,
        kind: 'gps',
        moments: c.moments,
        distance: c.distance,
        seconds: c.seconds,
        sigma: GPS_SIGMA,
      }));
  for (const x of obs) {
    await store.put('observations', x);
    S.observations.push(x);
  }
  if (obs.length) refit();
  if (S.settings.clubShare) sendToClub([{ type: 'run', run: clubRun(run) }]);
  await store.deleteKv('activeRun');
  S.finish = null;
  S.unfinished = null;
  S.runId = run.id;
  go('run');
}

async function discardRun() {
  if (!confirm('Discard this run?')) return;
  await store.deleteKv('activeRun');
  S.finish = null;
  S.unfinished = null;
  go('home');
}

// ---------- calibration segments ----------

async function startSegment() {
  const v = parseFloat($('segSpeed').value);
  if (!(v > 0)) return toast('Enter the treadmill speed');
  S.settings.segmentSpeed = String(v);
  saveSettings();
  const start = await S.link.readSums();
  S.active.segment = { speed: v, mps: v / unit().speedFactor, start };
  S.active.segmentForm = false;
  speak('Segment started. Hold steady.');
  renderSegment();
}

async function endSegment() {
  const a = S.active;
  const seg = a.segment;
  a.segment = null;
  const end = await S.link.readSums();
  const seconds = (end.elapsedMs - seg.start.elapsedMs) / 1000;
  renderSegment();
  if (end.gapMs > seg.start.gapMs) return toast('Segment discarded: the sensor dropped out. Keep the screen on.');
  if (seconds < MIN_SEGMENT_S) return toast('Segment too short');
  const o = {
    id: `seg-${store.newId()}`,
    runId: a.id,
    kind: 'segment',
    source: a.source,
    t: Date.now(),
    moments: diffMoments(end.moments, seg.start.moments),
    distance: seg.mps * seconds,
    seconds,
    label: `${seg.speed} ${unit().speed}`,
    sigma: 0.015,
    include: true,
  };
  await store.put('observations', o);
  S.observations.push(o);
  refit();
  speak('Calibration saved');
  toast(`Saved ${o.label} segment — calibration updated`);
}

// ---------- voice + wake lock ----------

function speak(text) {
  if (!S.settings.voice || !('speechSynthesis' in window)) return;
  speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

// Each mile (or km), halfway and the target: the split and the average pace.
// spokenTo only moves forward, so a mid-run recalibration that lowers the
// distance doesn't repeat anything.
function announce(a) {
  const tl = a.rs.timeline;
  const d = tl[tl.length - 1]?.d ?? 0;
  if (d <= a.spokenTo) return;
  const events = milestones(a.spokenTo, d, unit().meters, a.target);
  a.spokenTo = d;
  if (events.length) speak(announcement(events, tl, S.settings.units));
}

let lock = null;
async function wakeLock(on) {
  try {
    if (on && !lock && navigator.wakeLock) {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => (lock = null));
    } else if (!on && lock) {
      await lock.release();
      lock = null;
    }
  } catch {}
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.active) wakeLock(true);
});

// ---------- updates ----------

// The service worker refreshes the app in the background and says when a
// new version is ready (see sw.js). A bar then offers a reload, but never
// during a run or on the finish screen: it waits until the run is saved.
//
// An installed app is usually resumed rather than restarted, and a resumed
// page asks the server for nothing, so the page also asks the worker for a
// full check at startup and whenever it comes back to the foreground.
const UPDATE_CHECK_MS = 15 * 60000;
let updateReady = false;
let lastCheck = 0;
let checkAsked = false; // Check for updates was tapped, so answer either way

if ('serviceWorker' in navigator && !SIM) {
  const hadWorker = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('message', (e) => {
    const type = e.data?.type;
    if (type === 'update-ready') showUpdateBar();
    else if (type === 'up-to-date' && checkAsked) toast(`You have the latest version (${BUILD}).`);
    else if (type === 'check-failed' && checkAsked) toast('Couldn’t check for updates. Are you online?');
    if (type) checkAsked = false;
  });
  // A new worker (after a change to the file list) takes over in place. The
  // very first install does too, and that isn't an update.
  navigator.serviceWorker.addEventListener('controllerchange', () => hadWorker && showUpdateBar());
  navigator.serviceWorker.startMessages?.();
  navigator.serviceWorker.ready.then(() => setTimeout(checkForUpdate, 3000));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !S.active) checkForUpdate();
  });
}

function checkForUpdate(asked = false) {
  const worker = navigator.serviceWorker?.controller;
  if (!worker) {
    if (asked) toast('Reload the app once, then check again.');
    return;
  }
  if (!asked && Date.now() - lastCheck < UPDATE_CHECK_MS) return;
  lastCheck = Date.now();
  checkAsked = asked === true;
  worker.postMessage({ type: 'check' });
}

function showUpdateBar() {
  updateReady = true;
  refreshUpdateBar();
}

function refreshUpdateBar() {
  if (!updateReady) return;
  let bar = $('updateBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'updateBar';
    bar.className = 'update-bar';
    bar.innerHTML = '<span>A new version of Run Club is ready.</span><button class="btn small">Reload</button>';
    bar.querySelector('button').addEventListener('click', () => location.reload());
    document.body.append(bar);
  }
  bar.hidden = !!S.active || S.screen === 'live' || S.screen === 'finish';
  document.body.classList.toggle('has-update', !bar.hidden);
}

// ---------- install ----------

// Chrome hands the page an install offer once the app qualifies. Keeping it
// lets the start screen show an Install button instead of leaving people to
// find it in the browser menu. Pages opened inside another app (a link
// tapped in a chat app) never get one, so the card explains that too.
let installOffer = null;
let justInstalled = false;
const installed = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installOffer = e;
  refreshInstallCard();
});

window.addEventListener('appinstalled', () => {
  installOffer = null;
  justInstalled = true;
  refreshInstallCard();
});

async function install() {
  const offer = installOffer;
  if (!offer) return;
  // An offer can only be used once.
  installOffer = null;
  offer.prompt();
  const { outcome } = await offer.userChoice;
  if (outcome === 'accepted') justInstalled = true;
  refreshInstallCard();
}

function installCard() {
  if (SIM || installed() || S.settings.installHidden) return '<div id="install"></div>';
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const how = justInstalled
    ? '<p class="hint"><b>Installed.</b> Open Run Club from your home screen or app drawer.</p>'
    : installOffer
    ? '<button class="btn small" data-act="install">Install app</button>'
    : ios
      ? '<p class="hint">In Safari, tap <b>Share</b>, then <b>Add to Home Screen</b>.</p>'
      : `<p class="hint">In Chrome, tap <b>⋮</b> (top right), then <b>Install app</b>, or <b>Add to home screen</b> and then <b>Install</b>.</p>
        <p class="hint">No such option? The page is probably open inside another app. Tap <b>⋮</b> and choose <b>Open in Chrome</b> first.</p>`;
  return `<section id="install" class="card install">
      <div class="install-head"><b>Install Run Club</b><button class="x" data-act="hideInstall" aria-label="Hide">×</button></div>
      <p class="hint">It gets a home screen icon, opens full screen and works offline.</p>
      ${how}
    </section>`;
}

// Swaps just the card, so an offer arriving mid-scroll doesn't reset the
// target wheel.
function refreshInstallCard() {
  const el = $('install');
  if (el) el.outerHTML = installCard();
}

// ---------- club ----------

// Simulated runs only ever go to the local stand-in club.
const clubOn = () => !!S.settings.clubUrl && (!SIM || club.isLocal(S.settings.clubUrl));
const clubName = () => S.settings.name.trim() || 'Runner';
const myRuns = () => S.runs.filter((r) => (r.source === 'sim') === !!SIM);

function clubRun(r) {
  return {
    id: r.id,
    member: S.settings.member,
    name: clubName(),
    started: r.startedAt,
    meters: Math.round(r.distance),
    seconds: Math.round(r.seconds),
    place: r.mode === 'outdoor' ? 'outdoor' : 'indoor',
  };
}

// Changes wait in an outbox until the club confirms them, so a run saved
// with no signal (a basement gym) goes out the next time there is one.
// Sending one twice does no harm: a run is replaced by its id.
async function queueForClub(ops) {
  if (!clubOn() || !ops.length) return;
  await store.setKv('clubOutbox', [...((await store.getKv('clubOutbox')) ?? []), ...ops]);
}

async function sendToClub(ops) {
  await queueForClub(ops);
  return flushClub();
}

let flushing = null;
function flushClub() {
  if (!clubOn() || flushing) return flushing;
  flushing = (async () => {
    try {
      for (;;) {
        const box = (await store.getKv('clubOutbox')) ?? [];
        if (!box.length) break;
        await club.post(S.settings.clubUrl, box);
        // Keep anything queued while that was in flight.
        await store.setKv('clubOutbox', ((await store.getKv('clubOutbox')) ?? []).slice(box.length));
      }
      S.club.error = null;
    } catch {
      S.club.error = 'Couldn’t reach the club. Your runs will go out when you’re back online.';
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

async function loadBoard() {
  if (!clubOn()) return;
  S.club.loading = true;
  S.club.tried = Date.now();
  try {
    await flushClub();
    S.club.data = await club.load(S.settings.clubUrl, club.weekStart());
    S.club.at = Date.now();
  } catch {
    S.club.error = 'Couldn’t reach the club. Check your connection and refresh.';
  } finally {
    S.club.loading = false;
    if (S.screen === 'club') render();
  }
}

// An invite link is the app's address with #club=<link>. Show it on the Club
// tab, and take it out of the address so it isn't reopened or bookmarked.
// Checked at startup and on hashchange: tapping an invite while the app is
// open only changes the fragment, without reloading the page.
function takeInvite() {
  const invited = club.clubFromHash(location.hash);
  if (!invited) return false;
  history.replaceState(null, '', location.pathname + location.search);
  if (invited !== S.settings.clubUrl) S.clubInvite = invited;
  // Mid-run the invite waits on the Club tab until the run is over.
  if (!S.active) S.screen = 'club';
  return true;
}

window.addEventListener('hashchange', () => {
  if (takeInvite() && !S.active) render();
});

async function joinClub(url) {
  S.settings.clubUrl = url;
  S.clubInvite = null;
  saveSettings();
  S.club = { data: null, at: 0, tried: 0, loading: false, error: null };
  await store.deleteKv('clubOutbox');
  // Runs you already have count too.
  if (S.settings.clubShare) await queueForClub(myRuns().map((r) => ({ type: 'run', run: clubRun(r) })));
  render();
}

function clubScreen() {
  if (S.clubInvite || !S.settings.clubUrl) return clubSetup();
  const u = unit();
  const units = S.settings.units;
  const c = S.club;
  const d = c.data;
  const rows = d ? club.standings(d.runs) : [];
  const week = rows.reduce((s, r) => s + r.meters, 0);
  const me = S.settings.member;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const board = rows
    .map(
      (r, i) => `<li class="${r.member === me ? 'me' : ''}">
        <span class="rank">${i + 1}</span>
        <span class="who">${fmt.escape(r.name)}${r.member === me ? '<small>you</small>' : ''}</span>
        <span class="dist"><b>${fmt.distance(r.meters, units)}</b> ${u.label}<small>${plural(r.runs, 'run')}</small></span>
      </li>`,
    )
    .join('');
  const waiting = c.loading || (!c.at && !c.error);
  const status = waiting ? 'Updating…' : c.at ? `Updated ${fmt.time(c.at)}` : 'Not updated yet';
  return `
    <header class="top"><h1>Club</h1></header>
    <section class="card club-total">
      <span class="label">Everyone, this week</span>
      <div class="hero small"><b>${d ? fmt.distance(week, units) : '–'}</b><span>${u.label}</span></div>
      <p class="hint">${d ? `All time: ${fmt.distance(d.total.meters, units)} ${u.label} by ${plural(d.total.members, 'runner')}, ${plural(d.total.runs, 'run')}` : '&nbsp;'}</p>
    </section>
    <h2>Leaderboard · this week</h2>
    ${board ? `<ol class="board">${board}</ol>` : `<p class="empty">${d ? 'No runs yet this week.' : waiting ? 'Loading…' : ''}</p>`}
    ${c.error ? `<p class="warn">${c.error}</p>` : ''}
    <p class="board-status">${status} · <button class="link" data-act="clubRefresh">Refresh</button></p>
    <section class="card settings">
      <label class="field">Your name on the board
        <input id="clubName" type="text" maxlength="30" autocomplete="nickname" value="${fmt.escape(S.settings.name)}" placeholder="Runner">
      </label>
      <label class="check-row"><input id="clubShare" type="checkbox" ${S.settings.clubShare ? 'checked' : ''}> Share my runs with the club</label>
      <div class="row club-actions">
        <button class="btn small" data-act="clubInvite">Invite friends</button>
        <button class="btn small ghost" data-act="clubLeave">Leave club</button>
      </div>
    </section>
    ${nav('club')}`;
}

// Joining the built-in club takes a name and a tap. An invite link to some
// other club (#club=…) still works, for a second club or the local stand-in.
function clubSetup() {
  const invite = S.clubInvite;
  const switching = invite && S.settings.clubUrl;
  return `
    <header class="top"><h1>Club</h1></header>
    <section class="card">
      <h3>${invite ? 'You’re invited to a club' : 'Join Run Club'}</h3>
      <p class="hint">${
        invite
          ? `Pick the name the leaderboard shows for you.${switching ? ' Joining moves you out of your current club.' : ''}`
          : 'Your runs count toward the weekly leaderboard and the whole club’s distance. No account needed; just pick the name everyone sees.'
      }</p>
      <label class="field">Your name on the board
        <input id="clubName" type="text" maxlength="30" autocomplete="nickname" value="${fmt.escape(S.settings.name)}" placeholder="Name">
      </label>
      <div class="row club-actions">
        <button class="btn" data-act="clubJoin">Join</button>
        ${invite ? '<button class="btn ghost" data-act="clubDecline">Not now</button>' : ''}
      </div>
    </section>
    ${nav('club')}`;
}

// ---------- rendering ----------

function go(screen, extra = {}) {
  Object.assign(S, extra, { screen });
  render();
  window.scrollTo(0, 0);
}

function render() {
  const screens = { home, live, finish, run: runDetail, calibrate, club: clubScreen };
  $app.innerHTML = screens[S.screen]();
  document.body.dataset.screen = S.screen;
  syncGps();
  if (S.screen === 'live') renderLive();
  if (S.screen === 'home') {
    mountWheels();
    updateCheck();
  }
  if (S.screen === 'club' && !S.club.loading && Date.now() - S.club.tried > CLUB_STALE_MS) loadBoard();
  refreshUpdateBar();
}

function nav(active) {
  const tab = (id, label) =>
    `<button class="tab ${active === id ? 'on' : ''}" data-act="go" data-to="${id}">${label}</button>`;
  return `<nav class="tabs">${tab('home', 'Run')}${tab('club', 'Club')}${tab('calibrate', 'Calibrate')}</nav>`;
}

function calibrationLine() {
  const m = S.model;
  if (!m.count) return `Not calibrated · estimates may be off ±${Math.round(UNCALIBRATED_ERROR * 100)}%`;
  const err = m.error ? ` · typical error ±${(m.error.rms * 100).toFixed(1)}%` : '';
  return `Calibrated from ${m.count} ${m.count === 1 ? 'measurement' : 'measurements'}${err}`;
}

function home() {
  const u = unit();
  const unfinished = S.unfinished
    ? `<div class="card banner">
        <div><b>Unfinished run</b><span>${fmt.date(S.unfinished.startedAt)} · ${fmt.clock(S.unfinished.sums.elapsedMs / 1000)}</span></div>
        <div class="row"><button class="btn small" data-act="resumeFinish">Finish it</button><button class="btn small ghost" data-act="dropUnfinished">Discard</button></div>
      </div>`
    : '';
  const runs = S.runs
    .filter((r) => r.source !== 'sim' || SIM)
    .slice(0, 30)
    .map(
      (r) => `<button class="run-row" data-act="openRun" data-id="${r.id}">
        <span class="run-date">${fmt.date(r.startedAt)}<small>${r.mode === 'outdoor' ? 'Outdoor' : 'Indoor'} · ${fmt.time(r.startedAt)}</small></span>
        <span class="run-dist">${fmt.distance(r.distance, S.settings.units)}<small>${u.label}</small></span>
        <span class="run-meta">${fmt.clock(r.seconds)}<small>${fmt.paceFromSeconds(r.seconds, r.distance, S.settings.units)} /${u.label}</small></span>
      </button>`,
    )
    .join('');
  const outdoor = S.settings.mode === 'outdoor';
  const modeBtn = (m, label) =>
    `<button role="radio" aria-checked="${S.settings.mode === m}" class="${S.settings.mode === m ? 'on' : ''}" data-act="mode" data-mode="${m}">${label}</button>`;
  const items = (n) => Array.from({ length: n }, (_, i) => `<div class="wheel-item" data-act="wheelPick" data-i="${i}">${i}</div>`).join('');
  return `
    <header class="top"><h1>Run Club</h1>${SIM ? '<span class="pill">Simulator</span>' : ''}</header>
    ${unfinished}
    ${installCard()}
    <div class="mode" role="radiogroup" aria-label="Where you're running">${modeBtn('indoor', 'Indoor')}${modeBtn('outdoor', 'Outdoor')}</div>
    <section class="card target">
      <div class="sensor-head"><span class="label">Target distance</span><span id="targetNote" class="label"></span></div>
      <div class="picker">
        <div class="wheel" id="wWhole" tabindex="0" role="spinbutton" aria-label="Whole ${u.word}s" aria-valuemin="0" aria-valuemax="${MAX_TARGET}">${items(MAX_TARGET + 1)}</div>
        <span class="picker-dot">.</span>
        <div class="wheel tenth" id="wTenth" tabindex="0" role="spinbutton" aria-label="Tenths" aria-valuemin="0" aria-valuemax="9">${items(10)}</div>
        <span class="picker-unit">${u.label}</span>
      </div>
    </section>
    <section class="card sensor">
      <div class="sensor-head">
        <span class="label">Steps · ${SIM ? 'Simulated runner' : PLACEMENTS[S.settings.placement]}</span>
        <span id="checkSig" class="sig"></span>
      </div>
      <div class="check"><b id="checkCad">–</b><span>steps / min</span></div>
      ${outdoor ? '<div class="sensor-head gps-row"><span class="label">Location</span><span id="gpsSig" class="sig"></span></div><p id="gpsHint" class="warn" hidden></p>' : ''}
      <p class="hint">${
        SIM
          ? 'A simulated runner follows a program: 3 min walk, then 6, 7 and 6.5 mph.'
          : outdoor
            ? 'GPS measures the distance. The accelerometer records too, and steady stretches calibrate it for indoor runs.'
            : 'Put the phone where it will ride during the run and walk around. The cadence here should match your steps.'
      }</p>
      <button class="btn small" id="enableSensor" data-act="enable" ${sensorStuck() ? '' : 'hidden'}>Enable motion sensor</button>
    </section>
    <button class="btn start" data-act="start">Start ${outdoor ? 'outdoor' : 'indoor'} run</button>
    <button class="cal-line" data-act="go" data-to="calibrate">${calibrationLine()} →</button>
    ${S.settings.clubUrl ? '' : '<button class="cal-line" data-act="go" data-to="club">Join the club leaderboard →</button>'}
    <h2>Runs</h2>
    <div class="runs">${runs || '<p class="empty">No runs yet.</p>'}</div>
    ${nav('home')}`;
}

function updateCheck() {
  const p = S.live;
  const sig = signal(p);
  if ($('checkCad')) $('checkCad').textContent = p && p.cadence > 0 ? Math.round(p.cadence) : '0';
  if ($('checkSig')) {
    $('checkSig').className = `sig ${sig.cls}`;
    $('checkSig').textContent = sig.text;
  }
  if ($('enableSensor')) $('enableSensor').hidden = !sensorStuck();
  if ($('gpsSig')) {
    const g = gpsSignal();
    $('gpsSig').className = `sig ${g.cls}`;
    $('gpsSig').textContent = g.text;
    $('gpsHint').hidden = S.gps?.status !== 'denied';
    $('gpsHint').textContent = S.gps?.message ?? '';
  }
}

// ---------- target wheel ----------

// Two scroll-snap wheels, whole units and tenths. The value is read from the
// scroll position, and saved once the wheel settles.
function mountWheels() {
  const tenths = Math.min(MAX_TARGET * 10 + 9, Math.round((S.settings.targetM / unit().meters) * 10));
  for (const [el, i] of [
    [$('wWhole'), Math.floor(tenths / 10)],
    [$('wTenth'), tenths % 10],
  ]) {
    el.scrollTop = i * WHEEL_ITEM;
    paintWheel(el);
    let settle = null;
    el.addEventListener(
      'scroll',
      () => {
        requestAnimationFrame(() => paintWheel(el));
        clearTimeout(settle);
        settle = setTimeout(saveTarget, 150);
      },
      { passive: true },
    );
    el.addEventListener('keydown', (e) => {
      const step = { ArrowUp: -1, ArrowDown: 1 }[e.key];
      if (!step) return;
      e.preventDefault();
      el.scrollBy({ top: step * WHEEL_ITEM, behavior: 'smooth' });
    });
  }
  updateTargetNote();
}

const wheelIndex = (el) => Math.round(el.scrollTop / WHEEL_ITEM);
const wheelTarget = () => wheelIndex($('wWhole')) + wheelIndex($('wTenth')) / 10;

// Tilts items away from the center, like a drum.
function paintWheel(el) {
  const mid = el.scrollTop / WHEEL_ITEM;
  [...el.children].forEach((item, i) => {
    const off = Math.max(-3, Math.min(3, i - mid));
    item.style.transform = `rotateX(${(-off * 22).toFixed(1)}deg)`;
    item.style.opacity = (1 - Math.abs(off) * 0.3).toFixed(2);
    item.classList.toggle('on', i === Math.round(mid));
  });
  el.setAttribute('aria-valuenow', Math.round(mid));
  updateTargetNote();
}

function updateTargetNote() {
  const el = $('targetNote');
  if (!el || !$('wTenth')) return;
  const v = wheelTarget();
  el.textContent = v > 0 ? `Halfway at ${Number((v / 2).toFixed(2))} ${unit().label}` : 'Open run';
}

function saveTarget() {
  if (!$('wWhole')) return;
  S.settings.targetM = wheelTarget() * unit().meters;
  saveSettings();
}

function live() {
  const u = unit();
  const a = S.active;
  return `
    <section class="live">
      <header class="live-top">
        <span class="sigs">${a?.track ? '<span id="gpsSig" class="sig"></span>' : ''}<span id="sig" class="sig"></span></span>
        <button class="btn small ghost" data-act="lock">Lock screen</button>
      </header>
      <div class="hero"><b id="dist">0.00</b><span>${u.label}</span></div>
      ${a?.target ? '<div class="goal"><div class="goal-bar"><i id="goalFill"></i><s></s></div><span id="goalText"></span></div>' : ''}
      <div class="stats">
        <div><b id="pace">–:––</b><span>Pace /${u.label}</span></div>
        <div><b id="time">0:00</b><span>Time</span></div>
        <div><b id="avg">–:––</b><span>Avg /${u.label}</span></div>
        <div><b id="spd">0.0</b><span>${u.speed}</span></div>
        <div><b id="cad">0</b><span>Cadence</span></div>
        <div><b id="steps">0</b><span>Steps</span></div>
      </div>
      <p id="gap" class="warn" hidden></p>
      <div id="seg"></div>
      <div id="controls" class="controls"></div>
      <div id="lockLayer" class="lock-layer" hidden>
        <div class="lock-ring" id="unlock"><span>Hold to unlock</span></div>
      </div>
    </section>`;
}

function renderLive() {
  const a = S.active;
  if (!a) return;
  $('controls').innerHTML = a.paused
    ? `<button class="btn big" data-act="pause">Resume</button><button class="btn big danger" data-act="finish">Finish</button>`
    : `<button class="btn big" data-act="pause">Pause</button>`;
  $('lockLayer').hidden = !S.locked;
  renderSegment();
  updateLive();
}

function renderSegment() {
  const a = S.active;
  const el = $('seg');
  if (!a || !el) return;
  const u = unit();
  if (a.paused || a.track) {
    el.innerHTML = '';
  } else if (a.segment) {
    el.innerHTML = `<div class="card seg active">
      <div><b>Calibrating at ${a.segment.speed} ${u.speed}</b><span id="segTime">0:00</span></div>
      <p class="hint">Stay at this speed and don't touch the rails.</p>
      <div class="row"><button class="btn small" id="segEnd" data-act="segEnd" disabled>Save segment</button><button class="btn small ghost" data-act="segCancel">Cancel</button></div>
    </div>`;
  } else if (a.segmentForm) {
    el.innerHTML = `<div class="card seg">
      <label>Treadmill speed (${u.speed})
        <input id="segSpeed" type="number" inputmode="decimal" step="0.1" min="0.5" value="${fmt.escape(S.settings.segmentSpeed)}">
      </label>
      <p class="hint">Get steady at this speed first. Hold it for at least a minute; two is better.</p>
      <div class="row"><button class="btn small" data-act="segStart">Start segment</button><button class="btn small ghost" data-act="segClose">Cancel</button></div>
    </div>`;
  } else {
    el.innerHTML = `<button class="btn ghost wide" data-act="segOpen">Calibrate at this speed</button>`;
  }
}

function updateLive() {
  const a = S.active;
  if (!a || !$('dist')) return;
  const units = S.settings.units;
  const p = S.live;
  const rs = a.rs;
  const elapsed = (p && p.sessionId === a.sessionId ? p.elapsedMs : a.lastSums.elapsedMs) / 1000;
  $('dist').textContent = fmt.distance(rs.shown, units);
  $('time').textContent = fmt.clock(elapsed);
  $('pace').textContent = a.paused ? '–:––' : fmt.pace(rs.currentSpeed, units);
  // Outdoors GPS bridges a gap, so the gap's time counts toward the average.
  $('avg').textContent = fmt.paceFromSeconds(elapsed - (a.track ? 0 : (p?.gapMs ?? 0) / 1000), rs.shown, units);
  $('spd').textContent = a.paused ? '0.0' : (rs.currentSpeed * unit().speedFactor).toFixed(1);
  $('cad').textContent = p ? Math.round(p.cadence) : 0;
  $('steps').textContent = p ? p.steps.toLocaleString() : 0;
  const sig = signal(p);
  $('sig').className = `sig ${a.paused ? 'idle' : sig.cls}`;
  $('sig').textContent = a.paused ? 'Paused' : sig.text;
  if ($('gpsSig')) {
    const g = gpsSignal();
    $('gpsSig').className = `sig ${g.cls}`;
    $('gpsSig').textContent = g.text;
  }
  if ($('goalFill')) {
    const left = a.target - rs.shown;
    $('goalFill').style.width = `${Math.min(100, (rs.shown / a.target) * 100).toFixed(1)}%`;
    $('goalText').textContent =
      left > 0 ? `${fmt.distance(left, units)} ${unit().label} to go of ${fmt.distance(a.target, units)}` : 'Target reached';
  }
  const gap = p?.gapMs ?? 0;
  $('gap').hidden = gap === 0;
  if (gap) {
    $('gap').textContent = `${fmt.clock(gap / 1000)} ${a.track ? 'without step data' : 'not tracked'}: the screen went off or the app was in the background. Keep this screen open while running.`;
  }
  if (a.segment && $('segTime')) {
    const s = (elapsed * 1000 - a.segment.start.elapsedMs) / 1000;
    $('segTime').textContent = fmt.clock(s);
    $('segEnd').disabled = s < MIN_SEGMENT_S;
  }
}

function finish() {
  return S.finish.outdoor ? finishOutdoor() : finishIndoor();
}

function finishOutdoor() {
  const f = S.finish;
  const o = f.outdoor;
  const u = unit();
  const units = S.settings.units;
  const gap = f.sums.gapMs / 1000;
  const sum = summarize(f.sums.moments);
  const err = f.estimate / o.distance - 1;
  const usedM = o.good.reduce((s, c) => s + c.distance, 0);
  const sim =
    f.simTruth > 0
      ? `<p class="hint">Simulator: the true distance was ${fmt.distance(f.simTruth, units)} ${u.label}, so GPS was ${(Math.abs(o.distance / f.simTruth - 1) * 100).toFixed(1)}% ${o.distance > f.simTruth ? 'long' : 'short'}.</p>`
      : '';
  const calibration = !o.gpsOk
    ? '<p class="warn">GPS never got a fix, so the distance is the accelerometer’s estimate and this run can’t calibrate anything.</p>'
    : `<p class="hint">On its own, the accelerometer measured ${fmt.distance(f.estimate, units)} ${u.label}: ${(Math.abs(err) * 100).toFixed(1)}% ${err > 0 ? 'long' : 'short'} of GPS.</p>
      ${
        o.good.length
          ? `<p class="hint">${fmt.distance(usedM, units)} ${u.label} had steady GPS and step data, in ${o.good.length} ${o.good.length === 1 ? 'stretch' : 'stretches'}. Those calibrate the accelerometer for indoor runs.</p>`
          : '<p class="warn">GPS or step data was too patchy to calibrate from this run.</p>'
      }`;
  return `
    <header class="top"><h1>Run complete</h1></header>
    <section class="card">
      <div class="stats">
        <div><b>${fmt.clock(f.sums.elapsedMs / 1000)}</b><span>Time</span></div>
        <div><b>${fmt.distance(o.distance, units)}</b><span>${o.gpsOk ? 'GPS' : 'Estimate'} (${u.label})</span></div>
        <div><b>${Math.round(sum.cadence)}</b><span>Avg cadence</span></div>
      </div>
    </section>
    ${gap > 0 ? `<p class="warn">${fmt.clock(gap)} of this run had no step data, so those stretches are left out of calibration.</p>` : ''}
    <section class="card">
      <h3>Accelerometer calibration</h3>
      ${calibration}
      ${sim}
      <label class="check-row"><input id="useCal" type="checkbox" ${o.good.length ? 'checked' : 'disabled'}> Use this run to calibrate</label>
    </section>
    <div class="row end">
      <button class="btn ghost" data-act="discard">Discard</button>
      <button class="btn" data-act="save">Save run</button>
    </div>`;
}

// Indoors the steps measured the run. A treadmill's readout, or laps times
// the track length, is optional; given one, the app learns from the
// difference.
function finishIndoor() {
  const f = S.finish;
  const u = unit();
  const units = S.settings.units;
  const gap = f.sums.gapMs / 1000;
  const sum = summarize(f.sums.moments);
  const hint =
    f.simTruth > 0
      ? `<button class="link" data-act="fillHint">Simulated treadmill shows ${fmt.distance(f.simTruth, units)} ${u.label}</button>`
      : '';
  return `
    <header class="top"><h1>Run complete</h1></header>
    <section class="card">
      <div class="stats">
        <div><b>${fmt.clock(f.sums.elapsedMs / 1000)}</b><span>Time</span></div>
        <div><b>${fmt.distance(f.estimate, units)}</b><span>Estimate (${u.label})</span></div>
        <div><b>${Math.round(sum.cadence)}</b><span>Avg cadence</span></div>
      </div>
    </section>
    ${gap > 0 ? `<p class="warn">${fmt.clock(gap)} of this run had no sensor data, so the estimate is short. It is left out of calibration unless you tick the box.</p>` : ''}
    <section class="card">
      <label class="field">Treadmill or track distance (optional)
        <span class="input-unit"><input id="measured" type="number" inputmode="decimal" step="0.01" min="0" placeholder="${fmt.distance(f.estimate, units)}"><span>${u.label}</span></span>
      </label>
      ${hint}
      <p id="compare" class="hint">${COMPARE_HINT}</p>
      <label class="check-row"><input id="useCal" type="checkbox" ${gap > 0 ? '' : 'checked'}> Use this run to calibrate</label>
    </section>
    <div class="row end">
      <button class="btn ghost" data-act="discard">Discard</button>
      <button class="btn" data-act="save">Save run</button>
    </div>`;
}

const COMPARE_HINT =
  'If a treadmill measured the run, enter what it shows. On a track, enter laps × the track length. The app learns from the difference.';

function updateCompare() {
  const f = S.finish;
  const typed = parseFloat($('measured').value);
  const el = $('compare');
  if (!(typed > 0)) {
    el.textContent = COMPARE_HINT;
    el.className = 'hint';
    return;
  }
  const err = f.estimate / (typed * unit().meters) - 1;
  const off = Math.abs(err) > 0.2;
  el.className = off ? 'warn' : 'hint';
  el.textContent = off
    ? `The estimate is ${(Math.abs(err) * 100).toFixed(1)}% ${err > 0 ? 'long' : 'short'}. That big a gap usually means the phone moved or you held the rails, so this run is left out of calibration.`
    : `The app's estimate was ${(Math.abs(err) * 100).toFixed(1)}% ${err > 0 ? 'long' : 'short'}.`;
  if (off) $('useCal').checked = false;
}

function runDetail() {
  const r = S.runs.find((x) => x.id === S.runId);
  if (!r) return home();
  const u = unit();
  const units = S.settings.units;
  const sp = splits(r.timeline, u.meters);
  const compare = r.gps
    ? `<p class="hint">Outdoor run measured by GPS (±${Math.round(r.gps.accuracy)} m). The accelerometer alone said ${fmt.distance(r.estimate, units)} ${u.label} (${fmt.percent(r.estimate / r.distance - 1)}).</p>`
    : r.mode === 'outdoor'
      ? '<p class="hint">Outdoor run without a GPS fix, so this is the accelerometer’s estimate.</p>'
      : r.treadmill
        ? `<p class="hint">App estimate ${fmt.distance(r.estimate, units)} ${u.label} (${fmt.percent(r.estimate / r.distance - 1)}) vs the ${fmt.distance(r.distance, units)} ${u.label} you entered.</p>`
        : '<p class="hint">Saved without a measured distance, so this is the app’s estimate.</p>';
  const rows = sp
    .map(
      (s) => `<tr><td>${s.fraction === 1 ? s.n : s.fraction.toFixed(2)}</td><td>${fmt.clock(s.seconds / s.fraction)}</td><td>${fmt.clock(s.seconds)}</td></tr>`,
    )
    .join('');
  return `
    <header class="top"><button class="back" data-act="go" data-to="home">‹</button><h1>${fmt.date(r.startedAt)}</h1></header>
    <div class="hero small"><b>${fmt.distance(r.distance, units)}</b><span>${u.label}</span></div>
    <section class="card">
      <div class="stats">
        <div><b>${fmt.clock(r.seconds)}</b><span>Time</span></div>
        <div><b>${fmt.paceFromSeconds(r.seconds, r.distance, units)}</b><span>Avg /${u.label}</span></div>
        <div><b>${Math.round(r.cadence)}</b><span>Cadence</span></div>
      </div>
      ${compare}
    </section>
    <section class="card"><h3>Speed (${u.speed})</h3>${speedChart(r.timeline)}</section>
    ${rows ? `<section class="card"><h3>Splits</h3><table class="splits"><thead><tr><th>${u.label}</th><th>Pace</th><th>Time</th></tr></thead><tbody>${rows}</tbody></table></section>` : ''}
    <button class="btn ghost danger wide" data-act="deleteRun" data-id="${r.id}">Delete run</button>`;
}

function speedChart(tl) {
  if (tl.length < 10) return '<p class="hint">Not enough data.</p>';
  const f = unit().speedFactor;
  const pts = [];
  const W = 30;
  for (let i = W; i < tl.length; i += 5) {
    const a = tl[i - W];
    const b = tl[i];
    if (b.t > a.t) pts.push([b.t, ((b.d - a.d) / (b.t - a.t)) * f]);
  }
  if (!pts.length) return '';
  const tMax = tl[tl.length - 1].t;
  const vMax = Math.ceil(Math.max(...pts.map((p) => p[1])) + 0.5);
  const x = (t) => (t / tMax) * 300;
  const y = (v) => 120 - (v / vMax) * 110;
  const line = pts.map((p) => `${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 300 130" class="chart" role="img" aria-label="Speed over time">
    <line x1="0" x2="300" y1="${y(vMax)}" y2="${y(vMax)}" class="grid"/>
    <line x1="0" x2="300" y1="${y(vMax / 2)}" y2="${y(vMax / 2)}" class="grid"/>
    <text x="2" y="${y(vMax) + 11}" class="axis">${vMax}</text>
    <text x="2" y="${y(vMax / 2) + 11}" class="axis">${(vMax / 2).toFixed(1)}</text>
    <polyline points="${line}" class="series"/>
    <text x="298" y="128" class="axis" text-anchor="end">${fmt.clock(tMax)}</text>
  </svg>`;
}

function calibrate() {
  const u = unit();
  const m = S.model;
  const obs = S.observations.filter((o) => o.source === source()).sort((a, b) => b.t - a.t);
  // An outdoor run's GPS stretches are listed (and switched on or off) as one.
  const groups = [];
  const byRun = new Map();
  for (const o of obs) {
    if (o.kind !== 'gps') groups.push([o]);
    else if (byRun.has(o.runId)) byRun.get(o.runId).push(o);
    else {
      byRun.set(o.runId, [o]);
      groups.push(byRun.get(o.runId));
    }
  }
  const list = groups
    .map((g) => {
      const o = g[0];
      const meters = g.reduce((s, x) => s + x.distance, 0);
      // Left-out errors are per group already; in-sample ones are summed.
      const loo = m.error?.byId[o.id];
      const err = loo ?? g.reduce((s, x) => s + predict(m.beta, features(x.moments)), 0) / meters - 1;
      const what =
        o.kind === 'segment'
          ? `Segment · ${fmt.escape(o.label)} · ${fmt.clock(o.seconds)}`
          : o.kind === 'gps'
            ? `Outdoor run · ${fmt.distance(meters, S.settings.units)} ${u.label} by GPS`
            : `Indoor run · ${fmt.distance(o.distance, S.settings.units)} ${u.label}`;
      const ids = g.map((x) => x.id).join(',');
      const on = o.include !== false;
      return `<div class="obs ${on ? '' : 'off'}">
        <label class="check-row"><input type="checkbox" data-act="toggleObs" data-ids="${ids}" ${on ? 'checked' : ''}>
          <span><b>${what}</b><small>${fmt.date(o.t)}${on ? ` · ${loo != null ? 'predicted' : 'fit'} ${fmt.percent(err)}` : ''}</small></span>
        </label>
        <button class="x" data-act="deleteObs" data-ids="${ids}" aria-label="Delete">×</button>
      </div>`;
    })
    .join('');
  const h = S.settings.heightM;
  const height =
    S.settings.units === 'mi'
      ? `<span class="row"><input id="hFt" type="number" inputmode="numeric" value="${Math.floor(h / 0.3048)}"> ft <input id="hIn" type="number" inputmode="numeric" value="${Math.round((h / 0.0254) % 12)}"> in</span>`
      : `<span class="row"><input id="hCm" type="number" inputmode="numeric" value="${Math.round(h * 100)}"> cm</span>`;
  return `
    <header class="top"><h1>Calibrate</h1></header>
    <section class="card">
      ${
        SIM
          ? '<p class="hint">Simulator calibration is kept separate from your real runs.</p>'
          : `<label class="field">Phone placement
        <select id="placement">${Object.entries(PLACEMENTS)
          .map(([k, v]) => `<option value="${k}" ${k === S.settings.placement ? 'selected' : ''}>${v}</option>`)
          .join('')}</select>
      </label>
      <p class="hint">Each placement learns separately, so carry the phone the same way each run.</p>`
      }
      <p class="status">${calibrationLine()}</p>
      ${calChart(obs)}
    </section>
    <section class="card">
      <h3>How to calibrate</h3>
      <ol class="steps">
        <li><b>Fastest, on a treadmill:</b> during an indoor run, tap <i>Calibrate at this speed</i>, type the treadmill speed and hold it for 1–2 minutes. Do this at an easy, a moderate and a fast speed, plus a walk.</li>
        <li><b>Every indoor run:</b> when you finish, type the distance the treadmill shows, or laps × the track length. Each run makes the next one more accurate.</li>
        <li><b>Outdoors:</b> run in Outdoor mode with the phone carried the same way. GPS measures the distance, and every steady half mile or so calibrates the accelerometer automatically. Treadmill strides can differ a little from road strides, so an indoor measurement now and then keeps it honest.</li>
      </ol>
    </section>
    <h2>Measurements</h2>
    <div class="obs-list">${list || '<p class="empty">None yet.</p>'}</div>
    <section class="card settings">
      <h3>Settings</h3>
      <label class="field">Units
        <select id="units"><option value="mi" ${S.settings.units === 'mi' ? 'selected' : ''}>Miles</option><option value="km" ${S.settings.units === 'km' ? 'selected' : ''}>Kilometers</option></select>
      </label>
      <label class="field">Height ${height}</label>
      <p class="hint">Height sets the starting guess before any calibration.</p>
      <label class="check-row"><input id="voice" type="checkbox" ${S.settings.voice ? 'checked' : ''}> Voice updates each ${u.word} and at halfway</label>
      <div class="row">
        <button class="btn small ghost" data-act="export">Export data</button>
        <label class="btn small ghost">Import<input id="import" type="file" accept="application/json" hidden></label>
      </div>
      <p class="hint">Version ${BUILD} · <button class="link" data-act="checkUpdate">Check for updates</button></p>
    </section>
    ${nav('calibrate')}`;
}

// Speed vs cadence: the fitted model, the uncalibrated prior, and each
// measurement's average.
function calChart(obs) {
  const f = unit().speedFactor;
  const pri = prior(S.settings.heightM).mean;
  const runObs = obs.filter((o) => o.include !== false && o.moments.run.n > 0);
  const iRun = runObs.length
    ? runObs.reduce((s, o) => s + o.moments.run.ni, 0) / runObs.reduce((s, o) => s + o.moments.run.n, 0)
    : REF.run.i0;
  const cMin = 100;
  const cMax = 200;
  const vMax = S.settings.units === 'mi' ? 12 : 20;
  const x = (c) => ((c - cMin) / (cMax - cMin)) * 300;
  const y = (v) => 150 - (v / vMax) * 140;
  const curve = (beta, gait, c0, c1, i) => {
    const pts = [];
    for (let c = c0; c <= c1; c += 2) pts.push(`${x(c).toFixed(1)},${y(speed(beta, gait, c, i) * f).toFixed(1)}`);
    return pts.join(' ');
  };
  const dots = obs
    .filter((o) => o.include !== false)
    .map((o) => {
      const s = summarize(o.moments);
      if (!(s.seconds > 0) || s.cadence < cMin || s.cadence > cMax) return '';
      return `<circle cx="${x(s.cadence).toFixed(1)}" cy="${y((o.distance / s.seconds) * f).toFixed(1)}" r="4" class="${o.kind === 'segment' ? 'dot seg' : 'dot'}"/>`;
    })
    .join('');
  const grid = [0.25, 0.5, 0.75]
    .map((k) => `<line x1="0" x2="300" y1="${y(vMax * k)}" y2="${y(vMax * k)}" class="grid"/><text x="2" y="${y(vMax * k) - 3}" class="axis">${vMax * k}</text>`)
    .join('');
  return `<svg viewBox="0 0 300 170" class="chart" role="img" aria-label="Speed versus cadence">
    ${grid}
    <polyline points="${curve(pri, 'walk', 100, 138, REF.walk.i0)}" class="series prior"/>
    <polyline points="${curve(pri, 'run', 140, 200, iRun)}" class="series prior"/>
    <polyline points="${curve(S.model.beta, 'walk', 100, 138, REF.walk.i0)}" class="series"/>
    <polyline points="${curve(S.model.beta, 'run', 140, 200, iRun)}" class="series"/>
    ${dots}
    <text x="0" y="166" class="axis">${cMin} spm</text><text x="300" y="166" class="axis" text-anchor="end">${cMax} spm</text>
  </svg>
  <p class="legend"><span><i class="key"></i>Your model</span><span><i class="key prior"></i>Starting guess</span><span><i class="key dot"></i>Measured (${unit().speed})</span></p>`;
}

// ---------- events ----------

const actions = {
  go: (el) => go(el.dataset.to),
  enable: () => enableSensor(),
  start: () => startRun(),
  pause: () => togglePause(),
  finish: () => finishRun(),
  save: () => saveRun(),
  discard: () => discardRun(),
  resumeFinish: () => openFinish(S.unfinished),
  dropUnfinished: async () => {
    await store.deleteKv('activeRun');
    S.unfinished = null;
    render();
  },
  fillHint: () => {
    $('measured').value = fmt.distance(S.finish.simTruth, S.settings.units);
    updateCompare();
  },
  mode: (el) => {
    saveTarget();
    S.settings.mode = el.dataset.mode;
    saveSettings();
    // A tap is the moment to ask for location permission, even if it was
    // refused before.
    if (S.settings.mode === 'outdoor' && (SIM || PhoneGps.supported())) gps().start();
    render();
  },
  wheelPick: (el) => el.closest('.wheel').scrollTo({ top: el.dataset.i * WHEEL_ITEM, behavior: 'smooth' }),
  openRun: (el) => go('run', { runId: el.dataset.id }),
  deleteRun: async (el) => {
    if (!confirm('Delete this run? Its calibration measurements are deleted too.')) return;
    const id = el.dataset.id;
    // Treadmill segments stand on their own, so they stay.
    const gone = S.observations.filter((o) => o.runId === id && o.kind !== 'segment');
    await store.remove('runs', id);
    for (const o of gone) await store.remove('observations', o.id);
    S.runs = S.runs.filter((r) => r.id !== id);
    S.observations = S.observations.filter((o) => !gone.includes(o));
    refit();
    sendToClub([{ type: 'delete', id, member: S.settings.member }]);
    go('home');
  },
  segOpen: () => {
    S.active.segmentForm = true;
    renderSegment();
    $('segSpeed').focus();
  },
  segClose: () => {
    S.active.segmentForm = false;
    renderSegment();
  },
  segStart: () => startSegment(),
  segEnd: () => endSegment(),
  segCancel: () => {
    S.active.segment = null;
    renderSegment();
  },
  lock: () => {
    S.locked = true;
    $('lockLayer').hidden = false;
  },
  deleteObs: async (el) => {
    if (!confirm('Delete this measurement?')) return;
    const ids = el.dataset.ids.split(',');
    for (const id of ids) await store.remove('observations', id);
    S.observations = S.observations.filter((o) => !ids.includes(o.id));
    refit();
    render();
  },
  export: () => exportData(),
  checkUpdate: () => checkForUpdate(true),
  install: () => install(),
  hideInstall: () => {
    S.settings.installHidden = true;
    saveSettings();
    refreshInstallCard();
  },
  clubJoin: () => {
    const name = $('clubName').value.trim();
    if (!name) return toast('Add the name the leaderboard should show');
    S.settings.name = name.slice(0, 30);
    joinClub(S.clubInvite ?? defaultClub());
  },
  clubDecline: () => {
    S.clubInvite = null;
    render();
  },
  clubRefresh: () => {
    S.club.loading = true;
    render();
    S.club.loading = false;
    loadBoard();
  },
  clubInvite: async () => {
    // The built-in club needs only the app's address.
    const app = location.origin + location.pathname;
    const link = S.settings.clubUrl === defaultClub() ? app : club.inviteLink(app, S.settings.clubUrl);
    try {
      if (navigator.share) await navigator.share({ title: 'Run Club', text: 'Join my Run Club leaderboard:', url: link });
      else {
        await navigator.clipboard.writeText(link);
        toast('Invite link copied. Send it to your friends.');
      }
    } catch (e) {
      // Closing the share sheet isn't an error.
      if (e?.name !== 'AbortError') prompt('Copy this invite link', link);
    }
  },
  clubLeave: async () => {
    if (!confirm('Leave this club? Your runs stay on its leaderboard.')) return;
    S.settings.clubUrl = '';
    saveSettings();
    await store.deleteKv('clubOutbox');
    S.club = { data: null, at: 0, tried: 0, loading: false, error: null };
    render();
  },
};

$app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.type === 'checkbox') return;
  actions[el.dataset.act]?.(el);
});

$app.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.dataset.act === 'toggleObs') {
    const ids = el.dataset.ids.split(',');
    for (const o of S.observations.filter((x) => ids.includes(x.id))) {
      o.include = el.checked;
      await store.put('observations', o);
    }
    refit();
    render();
  } else if (el.id === 'placement') {
    S.settings.placement = el.value;
    saveSettings();
    refit();
    render();
  } else if (el.id === 'units') {
    S.settings.units = el.value;
    S.settings.segmentSpeed = '';
    saveSettings();
    render();
  } else if (['hFt', 'hIn', 'hCm'].includes(el.id)) {
    const h = $('hCm') ? +$('hCm').value / 100 : +$('hFt').value * 0.3048 + +$('hIn').value * 0.0254;
    if (h > 1 && h < 2.5) {
      S.settings.heightM = h;
      saveSettings();
      refit();
      render();
    }
  } else if (el.id === 'voice') {
    S.settings.voice = el.checked;
    saveSettings();
  } else if (el.id === 'clubName') {
    S.settings.name = el.value.trim().slice(0, 30);
    saveSettings();
    if (clubOn() && !S.clubInvite) {
      sendToClub([{ type: 'rename', member: S.settings.member, name: clubName() }]).then(() => S.screen === 'club' && loadBoard());
    }
  } else if (el.id === 'clubShare') {
    S.settings.clubShare = el.checked;
    saveSettings();
    // Catch up on runs saved while sharing was off.
    if (el.checked) sendToClub(myRuns().map((r) => ({ type: 'run', run: clubRun(r) })));
  } else if (el.id === 'import') {
    importData(el.files[0]);
  }
});

$app.addEventListener('input', (e) => {
  if (e.target.id === 'measured') updateCompare();
});

// Hold-to-unlock, so a pocketed phone can't pause or end the run by accident.
let unlockTimer = null;
$app.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('#unlock')) return;
  $('unlock').classList.add('holding');
  unlockTimer = setTimeout(() => {
    S.locked = false;
    $('lockLayer').hidden = true;
    $('unlock').classList.remove('holding');
  }, 1200);
});
const cancelUnlock = () => {
  clearTimeout(unlockTimer);
  $('unlock')?.classList.remove('holding');
};
$app.addEventListener('pointerup', cancelUnlock);
$app.addEventListener('pointercancel', cancelUnlock);
$app.addEventListener('pointerleave', cancelUnlock);

function toast(text) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  document.body.append(el);
  setTimeout(() => el.remove(), 3500);
}

// ---------- backup ----------

function exportData() {
  // 'treadline' is the export format's id from before the rename; keep it so
  // old and new backups import either way.
  const data = { app: 'treadline', version: 1, settings: S.settings, runs: S.runs, observations: S.observations };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `run-club-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importData(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'treadline') throw new Error('Not a Run Club export');
    for (const r of data.runs ?? []) await store.put('runs', r);
    for (const o of data.observations ?? []) await store.put('observations', o);
    S.runs = (await store.all('runs')).sort((a, b) => b.startedAt - a.startedAt);
    S.observations = await store.all('observations');
    refit();
    render();
    toast(`Imported ${data.runs?.length ?? 0} runs and ${data.observations?.length ?? 0} measurements`);
  } catch (e) {
    toast(`Import failed: ${e.message}`);
  }
}

boot();
