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
   "intensity", in g).
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
- **Carry the phone on your body:** front pocket, armband or waistband. On the
  treadmill console it feels belt vibration, not your steps. Pick the
  placement on the Calibrate tab; each one is calibrated separately.
- **Keep the app open with the screen on.** Browsers stop sending motion and GPS data
  to pages in the background. The app keeps the screen awake during a run,
  and **Lock screen** stops pocket taps (hold to unlock). Any time with no
  data is flagged, and that run is left out of calibration by default.
- **Calibrate:**
  - *Fastest, on a treadmill:* during an indoor run, tap **Calibrate at this
    speed**, type the treadmill speed, hold it 1–2 minutes and tap **Save
    segment**. Do an easy, a moderate and a fast pace, plus a walk.
  - *Every indoor run:* on the finish screen, type the treadmill's distance,
    or laps × the track length. It's optional; leave it blank if nothing
    measured the run. A run that's more than 20% off is assumed bad (rails,
    phone moved) and left out unless you tick it back in.
  - *Outdoors:* nothing to type. Carry the phone the same way you do
    indoors, because each placement is calibrated separately.
- **Back up** with *Export data* on the Calibrate tab. Everything is stored
  only on the phone, in the browser's storage for this app.
- Splits are announced by voice (turn it off on the Calibrate tab).

## Run it locally

```bash
cd web
python -m http.server 5174
```

Open <http://localhost:5174/?sim=20> for a simulated runner at 20× speed
(3 min walk, then 6, 7 and 6.5 mph). Outdoor mode gets simulated GPS on a
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
*⋮ → Add to Home screen → Install*. Every push to `main` runs the tests and
redeploys `web/` (without `tests/`) through
`.github/workflows/pages.yml`. An installed copy picks up a deploy the
second time it's opened.

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
| `web/js/links.js` | Phone accelerometer source, and the simulator |
| `web/js/gps.js` | GPS distance filter, phone and simulated GPS |
| `web/js/run.js` | Live distance, splits, GPS calibration stretches, voice updates |
| `web/js/app.js` | Screens and run flow |
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
