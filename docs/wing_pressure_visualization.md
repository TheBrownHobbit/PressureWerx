# Wing Pressure FIT-File Visualization — Processing Spec

This document captures the data-cleaning and plotting decisions reached
in a long working session. It is intended to seed a fresh session
(and ultimately a drag-and-drop web app) without dragging the back-and-forth
history along.

The system records wing pressure data to a Garmin **FIT file** during
on-water activities (wing-foiling). A small Python pipeline reads the FIT,
cleans known artefacts, and produces two primary visualisations:
**pressure vs. time** and a **map plot** of the GPS track coloured by
pressure.

---

## 1. The FIT file and its custom fields

The FIT file's `record` messages contain standard fields (timestamp, GPS,
speed, altitude, cadence, distance) plus **developer fields** declared by
our firmware:

| Field name      | Units | Meaning                                  | Plot it? |
|-----------------|-------|------------------------------------------|----------|
| `pressure_le`   | PSI   | Leading-edge tube pressure               | **yes**  |
| `pressure_st`   | PSI   | Strut pressure                           | **yes**  |
| `pressure_ref`  | hPa   | Barometric reference (atmospheric)       | **no**   |

`pressure_ref` is an absolute-pressure reference for the activity (typically
~1013 hPa, i.e. sea-level standard atmosphere). We do not plot it.

### 1.1 The all-zero "no sensor" sentinel

Either sensor channel may be unpopulated for a whole activity if the
sensor was not paired / not present. When this happens, the firmware
still declares the field in the FIT file but writes `0.0` for every
record.

**Detection rule:** if `(field == 0.0).all()` across the activity,
treat the field as **not present** and skip it entirely (do not plot,
do not interpolate).

If only one of `pressure_le` / `pressure_st` is present, plot just that
one. If both are present, plot both — except on the map (see §3.2).

> **Caveat to keep in mind:** the 0.0 sentinel is ambiguous with a real
> reading of 0 PSI. It works for wing pressure because our valid range
> never approaches zero, but if firmware design evolves to a context
> where 0 PSI is plausible, this convention needs to change (use NaN,
> a negative sentinel, or a separate "sensor_present" status field).

### 1.2 Reading the FIT file

```python
from fitparse import FitFile
import numpy as np

fit = FitFile(path)
times, p_le, p_st, lats, lons = [], [], [], [], []
for msg in fit.get_messages('record'):
    t = ple = pst = la = lo = None
    for f in msg:
        if   f.name == 'timestamp':    t = f.value
        elif f.name == 'pressure_le':  ple = f.value
        elif f.name == 'pressure_st':  pst = f.value
        elif f.name == 'position_lat': la = f.value
        elif f.name == 'position_long': lo = f.value
    if t is not None:
        times.append(t); p_le.append(ple); p_st.append(pst)
        lats.append(la); lons.append(lo)

times = np.array(times)
p_le  = np.array([0.0 if v is None else v for v in p_le],  dtype=float)
p_st  = np.array([0.0 if v is None else v for v in p_st],  dtype=float)

# GPS arrives in "semicircles" – convert to degrees:
SEMI_TO_DEG = 180.0 / 2**31
lats = np.array([la * SEMI_TO_DEG if la is not None else np.nan for la in lats])
lons = np.array([lo * SEMI_TO_DEG if lo is not None else np.nan for lo in lons])

# Drop channels that are entirely zero (sensor not paired)
channels = {}
if not (p_le == 0.0).all(): channels['le'] = p_le
if not (p_st == 0.0).all(): channels['st'] = p_st
# channels is now a dict of present channels only
```

---

## 2. Pressure vs. Time

### 2.1 Cleaning: zeros are missing data, not zero pressure

Within a present channel, **individual zero values** are dropouts —
the sensor failed to report that sample. They appear scattered through
otherwise-valid traces, sometimes in short runs of a few samples,
occasionally in longer gaps.

**Treatment:** linear interpolation between the two adjacent valid points.

```python
import pandas as pd
def fill_zeros(p):
    """Replace 0.0 samples with linear interpolation between neighbours.
    Operates on a 1-D numpy float array; returns a new array of same length.
    """
    s = pd.Series(p.copy())
    s[s == 0.0] = np.nan
    return s.interpolate(method='linear', limit_direction='both').to_numpy()
```

`limit_direction='both'` handles the edge case where the first or last
sample is zero — `pandas` would otherwise leave them as NaN.

We keep a parallel boolean mask of which samples were interpolated so
the plot can render them visually distinctly (faint grey) from the
real measurements (red).

### 2.2 Smoothing: Savitzky-Golay (window=21, order=3)

After zero-filling, smooth with a **Savitzky-Golay** filter. SG fits a
low-order polynomial to a sliding window — unlike a moving average it
preserves the *shape* of features (peaks, sudden steps) while flattening
random noise.

```python
from scipy.signal import savgol_filter
smoothed = savgol_filter(filled, window_length=21, polyorder=3)
```

Settled parameters: **window_length=21, polyorder=3**. We compared
moving-average(15), SG(21, 3), and median(5)+SG(21, 3) — for wing
pressure the differences are small because the dominant "noise" is
sensor quantisation rather than random noise, so any of the three
work. SG was chosen for its shape preservation.

If a future dataset shows isolated single-sample spikes (e.g. ±0.5 PSI
single-frame outliers), pre-filter with `scipy.signal.medfilt(filled,
kernel_size=5)` before the SG step.

### 2.3 Plot construction

A standard pressure-vs-time figure shows:

1. **Raw measured samples** in faint red (`alpha=0.4`, `linewidth=0.7`) —
   visible behind the smoothed line so the user can see what was actually
   measured.
2. **Interpolated (gap-filled) samples** in light grey at the same weight,
   only drawn where the original was zero plus the two adjacent points
   (so the grey segments visually connect to the red).
3. **Smoothed signal** as the primary line — `tab:blue` for `pressure_le`,
   a contrasting colour (`tab:red` or `tab:orange`) for `pressure_st`
   if both are present.

Y-axis is zoomed to the actual non-zero data range, rounded outward to
the nearest 0.5 PSI:

```python
nz = pressures[pressures != 0.0]
p_lo = np.floor(nz.min() * 2) / 2
p_hi = np.ceil(nz.max() * 2) / 2
if p_hi - p_lo < 1.0:
    p_hi = p_lo + 1.0   # minimum 1 PSI span so it's readable
```

X-axis uses minute ticks; spacing adapts to activity duration:

```python
duration_min = (times[-1] - times[0]).total_seconds() / 60
if duration_min <= 30:   major, minor = 5,  1
elif duration_min <= 90: major, minor = 10, 2
else:                    major, minor = 15, 5
```

If both channels are present, plot both on the same y-axis with separate
legend entries. Don't separate into subplots — the comparison between
the two channels at a glance is the point.

---

## 3. The Interactive HTML — what we built

The primary deliverable is a **self-contained interactive HTML page**
generated server-side from the FIT file, using **Leaflet** for the map
and inline JavaScript for sliders, time graph, and live recolouring.

The canonical reference file is `pressure_map_interactive_v04.html`.
The Python generator is `interactive_map_v4.py`. Both are in the
session outputs.

### 3.1 Layout (top-to-bottom)

The page fills the browser viewport (`html, body { height: 100% }`,
`overflow: hidden` on body) using a vertical flexbox so that the slider
controls are **always visible**, never scrolled off-screen.

From top to bottom:

1. **Header strip** — PressureWerx logo on the left (embedded as a
   base64 PNG so the HTML is fully self-contained), activity metadata
   chips on the right: Date, Time, Duration, Distance (haversine sum
   from GPS), Mean pressure.
2. **Pressure-vs-time graph** (`<svg id="timegraph">`) — ~130 px tall,
   warm-grey background, every segment coloured by pressure using the
   same colour map and `vmin`/`vmax` clamping as the map below.
3. **Map** (`<div id="map">`) — Leaflet, grows to fill remaining space.
4. **Controls panel**:
   - "PRESSURE WINDOW" label + dual-handle gradient slider +
     blue/red PSI readouts
   - "TIME WINDOW" label + dual-handle grey slider +
     start / window-duration / end readouts
   - Button row: Reset color (→ p10/p90), Full data range, Tight,
     Medium, Full time

### 3.2 Tile providers (Leaflet)

- **Default:** Google Satellite (`mt1.google.com/vt?lyrs=s`).
- Layer control top-right also offers: Hybrid (Google), Satellite (Esri),
  Streets (OSM).
- After init and on window resize, call
  `setTimeout(() => map.invalidateSize(), 100)` because Leaflet caches
  its map-div size and the flex layout sizes the div *after* Leaflet
  thinks it's ready.

### 3.3 Track rendering on the map

Drawn as one `L.polyline` per decimated segment (~3,800 segments for a
typical 2-hour activity at `DECIM = 2`). Each polyline carries its
own `_pressure` property and a tooltip showing the value on hover.
`weight: 2`, `opacity: 0.95` when in-window.

Out-of-time-window segments are rendered in a very light grey
(`#dcdcdc`), thinner (`1.5 px`) and at lower opacity (`0.55`). Same
treatment applies to the time graph above.

### 3.4 Which channel to plot on the map

The map plot uses **exactly one** pressure channel as its colour source:

1. If `pressure_le` is present → use `pressure_le`.
2. Else if `pressure_st` is present → use `pressure_st`.
3. Else (both all-zero) → no map plot, surface an error.

Rationale: leading-edge pressure is our primary signal, and a map
coloured by two values simultaneously is hard to read.

The pressure-vs-time graph (§3.6) can show both channels overlaid if
both are present.

### 3.5 Sliders

**Pressure Window (colour) — dual-handle:**

- Track range: `data_min - 0.3` to `data_max + 0.3` PSI (a small margin
  beyond the data so the user can clamp slightly).
- **Default thumb positions: 10th and 90th percentile of the loaded
  data.** This gives meaningful colour contrast immediately on load.
- Drag either thumb to set its end of the range; thumbs can't cross
  (enforced with a 0.01 PSI minimum gap).
- Out-of-range values **clamp** to the endpoint colour — essential for
  the use case of squeezing the pre-launch high-pressure tail to "deep
  red" so the on-water region uses the full gradient.

**Time Window (greyscale) — dual-handle:**

- Track range: 0 .. N_SEG (segment indices, not seconds).
- Default: full activity (thumbs at the extremes).
- Out-of-window segments grey out on both the map and the time graph.
- Two dashed vertical lines appear on the time graph at the current
  thumb positions, so you can see where the window edges sit in time.

Both sliders are custom (since HTML `<input type="range">` has only one
thumb). Built as two absolutely-positioned `<div>` thumbs on a shared
track, with mouse + touch event handlers. The drag-dispatch state
machine in `onDrag` handles all four thumbs (pressure-min, pressure-max,
time-start, time-end) through a single global mousemove/touchmove
listener:

```javascript
function startDrag(which) {
  return (e) => { e.preventDefault(); dragging = which; };
}
// dragging is one of: null, 'min', 'max', 'tStart', 'tEnd'
document.addEventListener('mousemove', onDrag);
function onDrag(e) {
  if (!dragging) return;
  // dispatch on `dragging` value to update the right slider
  // ...
  applyColors();   // single re-render path for everything
}
```

`applyColors()` is the only render function. It walks every polyline,
recolours by current `vmin/vmax`, greys out-of-window segments, and
calls `drawTimeGraph()` to redraw the inline SVG above.

### 3.6 Pressure-vs-time graph (inline SVG)

A small inline `<svg>` drawn from scratch on every `applyColors()`
call (no library — just `document.createElementNS`). For ~3,800
segments this is fast enough to feel instant on slider drag in a
modern browser.

Per-segment line, coloured the same way as the map. Y-axis: PSI ticks
at 0.5 PSI intervals, light grey gridlines, "PSI" label top-left.
X-axis: HH:MM ticks every 15 min (adapts to activity length).
Line weight 2.0 px for in-window, 1.2 px and `#dcdcdc` for out.

**Background colour:** `#ece9e3` (warm grey from brand palette).
A pure-white background eats the pastel-yellow mid-range of the
colour scale; warm grey solves it without going dark.

If both `pressure_le` and `pressure_st` are present, plot both lines
overlaid on the same Y-axis with the **same colour mapping** (so a
9.0 PSI strut reading and a 9.0 PSI LE reading get the same colour).
The map only shows one channel (§3.4) but the time graph can show
both.

### 3.7 The colour scale (RdYlBu reversed)

```javascript
const STOPS = [
  [0.00, [44, 123, 182]],   // deep blue
  [0.25, [171, 217, 233]],  // light blue
  [0.50, [255, 255, 191]],  // pale yellow
  [0.75, [253, 174, 97]],   // orange
  [1.00, [215, 25, 28]]     // deep red
];
function colorFor(p, vmin, vmax) {
  let t = (p - vmin) / (vmax - vmin);
  t = Math.max(0, Math.min(1, t));   // clamp out-of-range
  // ...interpolate between adjacent STOPS, return rgb(...)
}
```

### 3.8 GPS coordinate handling

FIT stores GPS in "semicircles" — `value * 180 / 2^31` gives degrees.
Leaflet wants degrees (`[lat, lon]`). Drop any samples where the GPS
fix is missing (`lat is None`) before drawing the track.

### 3.9 Decimation

Raw FIT records at 1 Hz produce thousands of GPS points (~7,600 for
a 2-hour activity). Drawing every one as a separate polyline yields a
2.5 MB HTML and sluggish recolouring on slider drag.

We decimate by taking every Nth sample (`DECIM = 2` halves it, file
~265 KB, render feels instant). Visual quality is excellent — adjacent
GPS samples are very close together at typical activity speeds.

> We considered binning consecutive same-colour segments into single
> polylines for a static map, but **don't** do this in the interactive
> version: slider drags continually change colour bins, so binning by
> colour would require re-binning every drag — defeating the purpose.

### 3.10 Branding and polish (v04)

- **Brand palette** pulled from the PressureWerx logo:
  - `--brand-ink: #222426` (charcoal — text, slider borders)
  - `--brand-red: #c44536` (brick red — currently used only on the
    high-end slider thumb border; reserved as an accent for future
    deliberate use)
  - `--brand-bg: #f5f3f0` (warm off-white — page background)
  - `--warm-grey: #ece9e3` (time-graph background)
- **Tabular figures** (`font-variant-numeric: tabular-nums`) on all
  numeric readouts so values don't jiggle on drag.
- **Soft shadows + rounded corners** on the main container.
- **Touch-friendly slider thumbs** (`@media (pointer: coarse)` bumps
  size from 22 px to 28 px).
- **Hover/active states** on buttons and slider thumbs with subtle
  scale + shadow transitions (60–80 ms easing).
- **Keyboard shortcuts:**
  - `R` — reset pressure window to defaults (p10/p90)
  - `T` — reset time window to full
  - `F` — pressure window to full data range


## 4. (Optional) Synchronised animation

Built once during the session as a sanity-check of the correlation
between map position and pressure trace. **Not a routine deliverable** —
do not generate by default. Documented here only for reference if a
future session asks for it again.

Approach:
- Two matplotlib subplots: map (left) + pressure vs. time (right).
- Each frame reveals one more chunk of the GPS track on the map
  (`LineCollection.set_color` with a per-segment alpha array) and
  extends the time-series line.
- Frame indices precomputed for **120× real-time** at **24 fps**
  (~5 samples advanced per frame for a 1 Hz data stream).
- Render each frame to a PNG (`fig.savefig`), then encode with `ffmpeg`
  to H.264 MP4.
- Frame dimensions **must be even** (libx264 requirement). Use
  `figsize=(14, 7)` at `dpi=90` (= 1260 × 630, both even), and add
  a defensive `ffmpeg -vf 'pad=ceil(iw/2)*2:ceil(ih/2)*2'` filter.
- A 131-min activity produced a 0.9 MB, 64-second MP4 in about 5 min
  of render time.

The matplotlib `FuncAnimation` + `FFMpegWriter` pipe-based approach
also works in principle but tends to fail at finalisation when the
process is interrupted (the `moov` atom never gets written). The
frame-by-frame PNG-then-ffmpeg approach is more robust for long
animations.

---

## 5. Putting it together — file layout for the web-app port

For the next session's drag-and-drop web app, the natural module split is:

```
fit_loader.py     # FIT-file parsing, channel detection, zero-sentinel handling
clean.py          # zero-fill + Savitzky-Golay smoothing
plot_time.py      # pressure-vs-time PNG/SVG generation
plot_map.py       # interactive HTML map generation (templating Leaflet HTML)
app.py            # Flask/FastAPI route accepting .fit or .zip upload
templates/        # the Leaflet HTML template, with payload injected as JSON
```

The interactive map HTML in particular is a *template* with a
`__PAYLOAD__` placeholder that gets replaced with `json.dumps(payload)`
server-side. Payload structure:

```python
payload = {
    "segments": [[lat1, lon1, lat2, lon2, pressure], ...],
    "seg_seconds": [float, ...],   # seconds-from-start per segment
    "duration_s": float,
    "t_start_str": "HH:MM:SS",
    "t_end_str":   "HH:MM:SS",
    "data_min": float, "data_max": float,
    "default_min": float,   # 10th percentile, initial slider position
    "default_max": float,   # 90th percentile, initial slider position
    "center": [lat, lon],
    "bbox":   [[lat_min, lon_min], [lat_max, lon_max]],
    "start":  [lat, lon],
    "end":    [lat, lon],
}
```

Top-level template variables (substituted into the HTML alongside the
JSON `__PAYLOAD__`):

- `__SLIDER_MIN__`, `__SLIDER_MAX__` — slider track bounds
  (`data_min - 0.3` to `data_max + 0.3` PSI)
- `__DATA_MIN__`, `__DATA_MAX__` — for the "data range" caption
- `__LOGO__` — base64 data URL of the PressureWerx logo
- `__ACTIVITY_DATE__`, `__ACTIVITY_CLOCK__`, `__DURATION_STR__`,
  `__TOTAL_KM__`, `__MEAN_PRESSURE__` — header metadata strip

---

## 6. Dependencies

```
fitparse        # FIT-file parsing
numpy
pandas          # Series.interpolate for linear gap-filling
scipy           # signal.savgol_filter, signal.medfilt
matplotlib      # static time-series and map PNGs
                # (Leaflet handles the interactive map in-browser)
```

For the optional animation only: `ffmpeg` (system binary, not pip).
Not needed for routine work.

---

## 7. Quick reference — defaults at v04

| Setting                            | Value                                  |
|------------------------------------|----------------------------------------|
| Zero-handling                       | Linear interpolation                  |
| Smoothing                           | Savitzky-Golay, window=21, polyorder=3 |
| Median pre-filter                   | Off by default; add if spikes         |
| Time-axis ticks (≤90 min)           | 10 min major, 2 min minor             |
| Y-axis (time graph)                 | Floor/ceil of data ÷ 0.5, min 1 PSI span |
| Map tile default                    | Google Satellite                      |
| Polyline weight (map, in-window)    | 2 px, opacity 0.95                    |
| Polyline weight (map, out-window)   | 1.5 px, opacity 0.55, colour `#dcdcdc` |
| Time-graph line weight (in-window)  | 2.0 px                                |
| Time-graph line weight (out-window) | 1.2 px                                |
| Time-graph background               | `#ece9e3` (warm grey)                 |
| GPS decimation                      | every 2nd sample (`DECIM = 2`)        |
| Pressure-slider track range         | `data_min - 0.3` to `data_max + 0.3` PSI |
| Pressure-slider default position    | 10th / 90th percentile of data        |
| Time-slider default position        | full activity (0 .. N_SEG)            |
| Colour map                          | RdYlBu_r (blue=low, red=high)         |
| Out-of-pressure-range behaviour     | Clamp to endpoint colour              |
| Out-of-time-window behaviour        | Grey (`#dcdcdc`) on both panels       |
| Brand background                    | `#f5f3f0` (warm off-white)            |
| Keyboard shortcuts                  | `R` defaults, `T` full time, `F` full data |

---

## 8. Roadmap from v04

These were lined up but not built in the v04 session:

**v05 — Drag-and-drop upload.** Currently the HTML is generated
server-side from a fixed FIT path. Next is a real upload zone:
dotted-border drop area accepting `.fit` or `.zip` (a zip with a
single .fit inside, like Garmin Connect's download format). The
parsing + rendering pipeline already exists; v05 is mostly wiring
input → pipeline → HTML.

**v06 — On-brand styling.** Pull the rest of the visual language
from the PressureWerx website (typography, button styles, link
colours, etc.) to match.

**v07 — Refinement.** Whatever has accumulated by then.

A few things from the easy-wins list that *did* get included in
v04: brand colours pulled from the logo, header strip with logo +
metadata, tabular figures, soft shadows, touch-friendly thumbs,
keyboard shortcuts, hover/active transitions.

Things that did **not** make v04 and are worth considering later:
share-this-view URL (encode slider positions in URL hash), a map
colour-bar legend in the corner, light/dark mode, responsive
narrow-screen layout, toast-style error notifications, and a real
component library / build setup if the codebase grows.
