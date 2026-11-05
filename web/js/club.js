// The club leaderboard. A club is a Google Sheet behind a small Apps Script
// web app (leaderboard/Code.gs): the app posts each saved run to it, and
// reads back this week's runs and the club's all-time total. Nobody signs
// in; the club's link is the only key.
//
// Requests are plain text with no custom headers, so the browser sends them
// without a CORS preflight, which Apps Script can't answer.

export function isClubUrl(url) {
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' && u.hostname === 'script.google.com' && u.pathname.endsWith('/exec')) || isLocal(url);
  } catch {
    return false;
  }
}

// The stand-in from leaderboard/dev-server.mjs.
export function isLocal(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

export async function post(url, ops) {
  const res = await fetch(url, { method: 'POST', body: JSON.stringify({ ops }) });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'The club didn’t accept that');
}

export async function load(url, since) {
  const res = await fetch(`${url}?since=${since}`);
  if (!res.ok) throw new Error(`The club answered ${res.status}`);
  return res.json();
}

// Monday 00:00, local time, of the week containing `now`.
export function weekStart(now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

// One row per member, most distance first.
export function standings(runs) {
  const by = new Map();
  for (const r of runs) {
    const m = by.get(r.member) ?? { member: r.member, name: r.name, meters: 0, runs: 0, latest: -Infinity };
    m.meters += r.meters;
    m.runs += 1;
    if (r.started > m.latest) {
      m.latest = r.started;
      m.name = r.name;
    }
    by.set(r.member, m);
  }
  return [...by.values()].sort((a, b) => b.meters - a.meters);
}

// The app's own address with the club link in the fragment, which never
// reaches a server.
export function inviteLink(appUrl, clubUrl) {
  return `${appUrl}#club=${encodeURIComponent(clubUrl)}`;
}

export function clubFromHash(hash) {
  const m = /[#&]club=([^&]+)/.exec(hash);
  if (!m) return null;
  try {
    const url = decodeURIComponent(m[1]);
    return isClubUrl(url) ? url : null;
  } catch {
    return null;
  }
}
