# Treadline

A treadmill run tracker that runs as an installable web app (PWA) on your
phone and **calibrates itself against your treadmill**. You type the
treadmill's distance after each run, or hold a known speed for a minute or
two, and the app uses that to correct how it turns your steps into distance.

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
   measurement becomes one equation. This includes a whole run with the
   treadmill's distance, and a steady segment at a known treadmill speed.
   The app re-solves for the coefficients after each new measurement,
   staying close to the height-based guess wherever the data says little.
   Older measurements slowly lose weight (half-life 180 days), so the model
   follows changes in fitness or shoes. The "typical error" on the Calibrate
   screen is leave-one-out: how far off each measurement would have been if
   it hadn't been used.

On the built-in simulator, a run at speeds the calibration never saw went
from 7.5% short (uncalibrated) to 1% short after four calibration segments.
Real-world accuracy depends on your phone and how steadily it rides. Watch
the "typical error" figure after a few runs.

## Using it

- **Carry the phone on your body:** front pocket, armband or waistband. On the
  treadmill console it feels belt vibration, not your steps. Pick the
  placement on the Calibrate tab; each one is calibrated separately.
- **Keep the app open with the screen on.** Browsers stop sending motion data
  to pages in the background. The app keeps the screen awake during a run,
  and **Lock screen** stops pocket taps (hold to unlock). Any time with no
  data is flagged, and that run is left out of calibration by default.
- **Calibrate:**
  - *Fastest:* during a run, tap **Calibrate at this speed**, type the
    treadmill speed, hold it 1–2 minutes and tap **Save segment**. Do an
    easy, a moderate and a fast pace, plus a walk.
  - *Every run:* type the treadmill's distance on the finish screen.
    A run that's more than 20% off is assumed bad (rails, phone moved) and
    left out unless you tick it back in.
- **Back up** with *Export data* on the Calibrate tab. Everything is stored
  only on the phone, in the browser's storage for this app.
- Splits are announced by voice (turn it off on the Calibrate tab).

## Run it locally

```bash
cd web
python -m http.server 5174
```

Open <http://localhost:5174/?sim=20> for a simulated runner at 20× speed
(3 min walk, then 6, 7 and 6.5 mph). Simulator data is kept apart from
real calibration.

Tests (Node 20+):

```bash
cd web
node --test tests/*.test.mjs
```

## Getting it on your phone

Motion sensors and installing as an app both need HTTPS (or `localhost`).

**Option A — host it (recommended).** Any static HTTPS host works, for
example GitHub Pages: push the `web/` folder to a repository, enable Pages,
open the URL in Chrome on the phone, then *⋮ → Add to Home screen /
Install app*.

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
| `web/js/run.js` | Live distance, splits |
| `web/js/app.js` | Screens and run flow |
| `web/js/store.js` | IndexedDB storage |
| `web/sw.js` | Offline caching |

## Pixel Watch (later)

A web page can't read a paired watch's sensors, so watch support needs a
small Wear OS app. It would compute cadence and intensity on the watch and
send them over Bluetooth (Web Bluetooth in Chrome). A sensor source only
has to emit the same once-per-second reading and running totals that
`links.js` produces, so the model, calibration and screens stay as they are.
A JDK 17 and the Android SDK are already installed on this PC for that.
