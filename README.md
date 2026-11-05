# Run Club

A run tracker that runs as an installable web app (PWA) on your phone and
**calibrates its step counting against your treadmill and against GPS**.
Each run is *Indoor* or *Outdoor*. Indoors it measures distance from the
phone's accelerometer, with no GPS. You can type the treadmill's distance
after a run (or laps × the track length), or hold a known treadmill speed for
a minute or two, and the app uses that to correct how it turns your steps
into distance. Outdoors GPS measures the distance while the accelerometer
records alongside, so every outdoor run also calibrates your next indoor run.

## How it works

1. **Steps.** The phone's accelerometer is sampled about 60 times a second.
   Every second, the app takes the last 8 seconds of motion, finds the
   strongest repeating rhythm (autocorrelation), and turns it into a cadence
   in steps per minute. It also measures how hard you're moving (the
   "intensity", in g). Both use only the size of the acceleration, so which
   way the phone faces doesn't matter.
   **Where it rides** is detected from two rhythm ratios. Motion once per
   stride against once per step separates a limb (thigh, arm) from the waist.
   How differently alternate steps land picks out a front pocket, whose leg
   lands every other step. The thresholds come from how each spot moves
   (simulated in `links.js`, `carrySample`), not from recordings.
2. **Distance.** Step length is modeled separately for walking and running:

   ```
   step length = a0 + a1·(cadence − ref)/30 + a2·(intensity − ref)
   ```

   Distance is steps × step length. Before any calibration, the six
   coefficients come from your height.
3. **Calibration.** Distance is linear in those six coefficients, so every
   measurement becomes one equation. This includes a whole indoor run with
   the distance you typed in, and a steady segment at a known treadmill
   speed.
   The app re-solves for the coefficients after each new measurement,
   staying close to the height-based guess wherever the data says little.
   Older measurements slowly lose weight (half-life 180 days), so the model
   follows changes in fitness or shoes. The "typical error" on the Calibrate
   screen is leave-one-out: how far off each measurement would have been if
   it hadn't been used.

4. **Outdoors.** GPS fixes go through a Kalman filter, and distance only
   counts once the filtered position has moved 12 m, because summing raw
   fixes adds the GPS jitter as extra distance (5–10% at running pace). The
   run is cut into stretches of about half a mile, and also at every switch
   between walking and running. Each stretch with steady GPS and no gaps in
   step data becomes a calibration measurement, weighted a little below a
   treadmill reading. The typical error counts a whole outdoor run as one
   measurement, left out together.

On the built-in simulator, a run at speeds the calibration never saw went
from 7.5% short (uncalibrated) to 1% short after four calibration segments.
One simulated outdoor run took a treadmill run from 8% short to about 1%.
Real-world accuracy depends on your phone and how steadily it rides. Watch
the "typical error" figure after a few runs. Strides on a treadmill can
differ a little from strides on the road, so an occasional treadmill
measurement keeps outdoor calibration honest.

## Using it

- **Before you start,** pick *Indoor* or *Outdoor* and spin the target
  distance (0.0 for an open run). Outdoors, wait for the GPS dot to go green.
  Indoors GPS stays off.
- **Voice updates** at every mile (or km) give that mile's split and your
  average pace. You also hear one at halfway and when you reach the target.
- **The motion sensor starts on its own** on Android. An iPhone needs one
  tap on **Enable motion sensor** (or Start) to allow it; the button only
  shows when no motion data is arriving.
- **Carry the phone on your body:** front pocket, armband or waistband, facing
  any way. On the treadmill console it feels belt vibration, not your steps.
  The app works out which of the three it's in during the first minute of a
  run, and each spot keeps its own calibration. The finish screen shows what
  it detected; change it there if it's wrong. (Calibrate → Phone placement
  can fix it to one spot instead.)
- **Don't lock the phone itself during a run.** Browsers stop sending motion
  and GPS data to a page once the screen is off, and no web app can change
  that. Instead the app keeps the screen awake and locks itself after 8
  seconds without a touch: a black screen (almost free on an OLED display)
  with a dim distance and time, which ignores pocket taps until you hold the
  ring to unlock. If the screen can't be kept on (Battery Saver can refuse),
  it says so. Any time with no data is flagged, and that run is left out of
  calibration by default.
- **Export data** (Calibrate tab) opens the share sheet, so a backup can go
  straight to Drive or into an email.
- **Calibrate:**
  - *Fastest, on a treadmill:* during an indoor run, tap **Calibrate at this
    speed**, type the treadmill speed, hold it 1–2 minutes and tap **Save
    segment**. Do an easy, a moderate and a fast pace, plus a walk.
  - *Every indoor run:* on the finish screen, type the treadmill's distance,
    or laps × the track length. It's optional; leave it blank if nothing
    measured the run. A run that's more than 20% off is assumed bad (rails,
    phone moved) and left out unless you tick it back in.
  - *Outdoors:* nothing to type.
- **Club:** the Club tab has a weekly leaderboard with friends and the club's
  combined distance. See [Leaderboard](#leaderboard).
- **Back up** with *Export data* on the Calibrate tab. Your runs and
  calibration are stored only on the phone, in the browser's storage for this
  app. Uninstalling the app or clearing Chrome's data for the site can erase
  them.
- Splits are announced by voice (turn it off on the Calibrate tab).

## Leaderboard

The Club tab ranks everyone by distance this week. It also shows the whole
club's combined distance, this week and all time. **Joining takes a name and a
tap:** the club's link is built into the app (`CLUB_URL` in `web/js/app.js`),
so there's no link to paste and no account or login. To invite someone, send
them the app's address; *Invite friends* on the Club tab does that.

The club is a Google Sheet, with a small script that receives runs from the
app. The link is in this public repository, so anyone who reads the code
could post runs; delete a row in the sheet to take a run off the board.

**Setting up a club (about 5 minutes).** This is how the built-in club was
made; do it again to run a separate one, and point `CLUB_URL` at it:

1. Create a Google Sheet (<https://sheets.new>) and name it, say, *Run Club*.
2. In the sheet, choose **Extensions → Apps Script**. Delete the code that's
   there, paste in all of [`leaderboard/Code.gs`](leaderboard/Code.gs), and
   click **Save**.
3. Choose **Deploy → New deployment**, click the gear next to *Select type*
   and pick **Web app**. Set **Execute as: Me** and **Who has access:
   Anyone** (not "Anyone with Google account"), then **Deploy**.
4. Authorize it with your account. If Google warns that it hasn't verified
   the app, that's because it's your own script: **Advanced → Go to …
   (unsafe) → Allow**. The script can only see this one spreadsheet.
5. Copy the **Web app URL**. It ends in `/exec`.
6. Put it in `CLUB_URL` and push. Alternatively, an invite link of the form
   `https://theironchef.github.io/treadline/#club=<the URL, encoded>` lets
   people join a club that isn't built in.

Each run is a row in the sheet's *Runs* tab. Runs saved with no signal are
sent the next time the app is online. The simulator only ever joins the local
stand-in below, never the real club.

If `Code.gs` changes later, paste the new version in the same place, then
**Deploy → Manage deployments → ✎ Edit → Version: New version → Deploy**. The
link stays the same.

To try the Club tab locally, run `node leaderboard/dev-server.mjs`, a
stand-in that runs the real script on an in-memory sheet at
`http://localhost:5175/exec`. In the simulator (`?sim=20`), Join uses it.

## Run it locally

```bash
cd web
python -m http.server 5174
```

Open <http://localhost:5174/?sim=20> for a simulated runner at 20× speed
(3 min walk, then 6, 7 and 6.5 mph), phone in a front pocket; add
`&carry=armband` or `&carry=waist` to move it. Outdoor mode gets simulated GPS on a
loop. Simulator data is kept apart from real calibration. In the simulator,
`treadline.link._tick()` in the console advances it one second, which is
handy when the tab is in the background and its timers are throttled.

Tests (Node 20+):

```bash
cd web
node --test tests/*.test.mjs
```

## Getting it on your phone

Motion sensors and installing as an app both need HTTPS (or `localhost`).

**Option A — the hosted copy (recommended).** Open
<https://theironchef.github.io/treadline/> in Chrome on the phone, then
*⋮ → Install app* (or *Add to home screen → Install*); the start screen also
shows an Install button when Chrome offers one. If the menu has no such
option, the page is open inside another app's browser: choose *Open in
Chrome* first. Every push to `main` runs the tests and redeploys `web/`
(without `tests/`) through `.github/workflows/pages.yml`. An installed copy
checks for a new version when it starts and whenever it comes back to the
foreground (at most every 15 minutes), since Android usually resumes an
installed app rather than restarting it. When it finds one, it downloads the
whole thing in the background and shows a **Reload** bar. The bar never
appears mid-run; it waits until the run is saved. The Calibrate tab shows the
version (the last commit that changed `web/`) and has **Check for updates**.

**Option B — over USB, no hosting.** With USB debugging on the phone and
`adb` from the Android SDK platform-tools:

```bash
adb reverse tcp:5174 tcp:5174
```

Then open `http://localhost:5174` in Chrome on the phone and install it. The
app works offline after that. To get updates, plug in again and open it
twice: the first launch fetches the new version, the second shows it.

## Files

| Path | What |
| --- | --- |
| `web/js/sensor.js` | Cadence estimator and per-run accumulator |
| `web/js/model.js` | Step-length model and calibration fit |
| `web/js/placement.js` | Which spot the phone rides in, from how it moves |
| `web/js/links.js` | Phone accelerometer source, and the simulator |
| `web/js/gps.js` | GPS distance filter, phone and simulated GPS |
| `web/js/run.js` | Live distance, splits, GPS calibration stretches, voice updates |
| `web/js/club.js` | Club leaderboard: posting runs, standings, invite links |
| `web/js/app.js` | Screens and run flow |
| `leaderboard/Code.gs` | The Google Sheet script that stores a club's runs |
| `leaderboard/dev-server.mjs` | Local stand-in for the deployed script |
| `web/js/store.js` | IndexedDB storage |
| `web/sw.js` | Offline caching |
| `.github/workflows/pages.yml` | Test and deploy to GitHub Pages |

## Pixel Watch (later)

A web page can't read a paired watch's sensors, so watch support needs a
small Wear OS app. It would compute cadence and intensity on the watch and
send them over Bluetooth (Web Bluetooth in Chrome). A sensor source only
has to emit the same once-per-second reading and running totals that
`links.js` produces, so the model, calibration and screens stay as they are.
A JDK 17 and the Android SDK are already installed on this PC for that.
