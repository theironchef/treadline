import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScript } from '../../leaderboard/fake-sheets.mjs';
import { standings, weekStart, inviteLink, clubFromHash, isClubUrl } from '../js/club.js';

const DAY = 86400000;
const run = (id, member, name, started, meters, seconds = meters / 3) => ({
  type: 'run',
  run: { id, member, name, started, meters, seconds, place: 'outdoor' },
});

test('the sheet script stores, updates, renames and deletes runs', () => {
  const s = loadScript();
  const now = Date.now();
  assert.deepEqual(s.post({ ops: [run('a1', 'ann', 'Ann', now - 9 * DAY, 5000), run('b1', 'bob', 'Bob', now, 8000)] }), { ok: true });
  assert.equal(s.rows()[0].join(), 'id,member,name,started,meters,seconds,place,posted');
  assert.equal(s.rows().length, 3);

  // The same id again updates rather than adds.
  s.post({ ops: [run('b1', 'bob', 'Bob', now, 8200)] });
  let got = s.get({ since: now - DAY });
  assert.equal(got.runs.length, 1);
  assert.equal(got.runs[0].meters, 8200);
  assert.deepEqual(got.total, { meters: 13200, runs: 2, members: 2 });

  s.post({ ops: [{ type: 'rename', member: 'bob', name: 'Robert' }] });
  assert.equal(s.get({ since: now - DAY }).runs[0].name, 'Robert');

  // Only the run's own member can delete it.
  s.post({ ops: [{ type: 'delete', id: 'a1', member: 'bob' }] });
  assert.equal(s.get({}).total.runs, 2);
  s.post({ ops: [{ type: 'delete', id: 'a1', member: 'ann' }] });
  got = s.get({});
  assert.deepEqual(got.total, { meters: 8200, runs: 1, members: 1 });
  assert.equal(s.rows().filter((r) => r[0] !== '').length, 2);
});

test('the sheet script turns away implausible runs and formula names', () => {
  const s = loadScript();
  const now = Date.now();
  s.post({
    ops: [
      run('x1', 'eve', 'Eve', now, 150000), // 150 km
      run('x2', 'eve', 'Eve', now, 5000, 500), // 10 m/s
      { type: 'run', run: { id: 'x3', member: 'eve', meters: 5000, seconds: 1500 } }, // no start time
      run('ok', 'eve', '=HYPERLINK("http://x")', now, 5000),
    ],
  });
  const got = s.get({});
  assert.equal(got.total.runs, 1);
  assert.equal(got.runs[0].name, 'HYPERLINK("http://x")');
  assert.deepEqual(s.post('not json'), { ok: false, error: 'Not JSON' });
});

test('standings add up each member and use their latest name', () => {
  const rows = standings([
    { member: 'a', name: 'Ann', started: 1, meters: 3000 },
    { member: 'b', name: 'Bob', started: 2, meters: 5000 },
    { member: 'a', name: 'Annie', started: 3, meters: 4000 },
  ]);
  assert.deepEqual(
    rows.map((r) => [r.name, r.meters, r.runs]),
    [
      ['Annie', 7000, 2],
      ['Bob', 5000, 1],
    ],
  );
});

test('weeks start on Monday', () => {
  const sunday = new Date(2026, 10, 8, 18, 30); // Sun 8 Nov 2026
  const monday = new Date(2026, 10, 9, 7, 0);
  assert.equal(new Date(weekStart(sunday)).toDateString(), new Date(2026, 10, 2).toDateString());
  assert.equal(weekStart(monday), new Date(2026, 10, 9).getTime());
});

test('invite links carry the club link and nothing else', () => {
  const club = 'https://script.google.com/macros/s/AKfy-cbx_123/exec';
  const link = inviteLink('https://theironchef.github.io/treadline/', club);
  assert.equal(clubFromHash(new URL(link).hash), club);
  assert.equal(clubFromHash('#club=' + encodeURIComponent('https://evil.example/exec')), null);
  assert.equal(clubFromHash('#club=%E0%A4%A'), null);
  assert.ok(isClubUrl('http://localhost:5175/exec'));
  assert.ok(!isClubUrl('http://script.google.com/macros/s/x/exec'));
});
