/**
 * Run Club leaderboard. This script turns the Google Sheet it belongs to into
 * a small web API for the app. Runs are rows in the "Runs" tab, so you can
 * read, fix or delete any of them right in the sheet.
 *
 * Setup, once: in the sheet, Extensions → Apps Script, replace the code with
 * this file and save. Then Deploy → New deployment → Web app, with "Execute
 * as: Me" and "Who has access: Anyone". Paste the web app URL into the app's
 * Club tab. Nobody else needs a Google account.
 *
 *   GET  ?since=<ms>     → { runs: [runs started since then], total: { meters, runs, members } }
 *   POST { ops: [...] }  → { ok: true }, applying each op in order:
 *     { type: 'run', run: { id, member, name, started, meters, seconds, place } }  add or update
 *     { type: 'delete', id, member }                                               remove
 *     { type: 'rename', member, name }                                             rename on every run
 *
 * @OnlyCurrentDoc
 */

const SHEET = 'Runs';
const COLUMNS = ['id', 'member', 'name', 'started', 'meters', 'seconds', 'place', 'posted'];

function doGet(e) {
  const since = Number(e.parameter.since) || 0;
  const runs = readRuns();
  const members = new Set(runs.map((r) => r.member));
  return json({
    runs: runs.filter((r) => r.started >= since),
    total: { meters: runs.reduce((s, r) => s + r.meters, 0), runs: runs.length, members: members.size },
  });
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json({ ok: false, error: 'Not JSON' });
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = runsSheet();
    const before = sheet.getLastRow() - 1;
    const rows = before > 0 ? sheet.getRange(2, 1, before, COLUMNS.length).getValues() : [];
    for (const op of body.ops || []) apply(rows, op);
    if (rows.length) sheet.getRange(2, 1, rows.length, COLUMNS.length).setValues(rows);
    if (before > rows.length) sheet.getRange(rows.length + 2, 1, before - rows.length, COLUMNS.length).clearContent();
    return json({ ok: true });
  } finally {
    lock.releaseLock();
  }
}

function apply(rows, op) {
  if (op.type === 'run') {
    const run = cleanRun(op.run);
    if (!run) return;
    const row = [run.id, run.member, run.name, new Date(run.started), run.meters, run.seconds, run.place, new Date()];
    const i = rows.findIndex((r) => String(r[0]) === run.id);
    if (i >= 0) rows[i] = row;
    else rows.push(row);
  } else if (op.type === 'delete') {
    const i = rows.findIndex((r) => String(r[0]) === String(op.id) && String(r[1]) === String(op.member));
    if (i >= 0) rows.splice(i, 1);
  } else if (op.type === 'rename') {
    const name = cleanName(op.name);
    for (const r of rows) if (String(r[1]) === String(op.member)) r[2] = name;
  }
}

// Turns away anything that isn't a plausible run: over 100 km, over a day,
// or faster than 7 m/s (a 3:50 mile).
function cleanRun(run) {
  if (!run) return null;
  const meters = Number(run.meters);
  const seconds = Number(run.seconds);
  const started = Number(run.started);
  const plausible =
    run.id && run.member && meters > 0 && meters <= 100000 && seconds > 0 && seconds <= 86400 && meters / seconds <= 7 && started > 0;
  if (!plausible) return null;
  return {
    id: cleanId(run.id),
    member: cleanId(run.member),
    name: cleanName(run.name),
    started,
    meters: Math.round(meters),
    seconds: Math.round(seconds),
    place: run.place === 'outdoor' ? 'outdoor' : 'indoor',
  };
}

// A leading =, +, - or @ would make the sheet read text as a formula.
function cleanName(name) {
  return String(name || '').replace(/^[\s=+\-@]+/, '').trim().slice(0, 30) || 'Runner';
}

function cleanId(id) {
  return String(id).replace(/[^\w-]/g, '').replace(/^[-]+/, '').slice(0, 40);
}

function readRuns() {
  const sheet = runsSheet();
  const n = sheet.getLastRow() - 1;
  if (n < 1) return [];
  return sheet
    .getRange(2, 1, n, COLUMNS.length)
    .getValues()
    .filter((r) => r[0] !== '')
    .map((r) => ({
      id: String(r[0]),
      member: String(r[1]),
      name: String(r[2]),
      started: new Date(r[3]).getTime(),
      meters: Number(r[4]) || 0,
      seconds: Number(r[5]) || 0,
      place: String(r[6]),
    }));
}

function runsSheet() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = book.getSheetByName(SHEET);
  if (!sheet) {
    sheet = book.insertSheet(SHEET);
    sheet.getRange(1, 1, 1, COLUMNS.length).setValues([COLUMNS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function json(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}
