# Mobile Refinement & Polish Handoff

This document hands off the next phase of work on `pressure_map_interactive_v05.html`.
It covers what was built in the v05 session, what is currently known to need attention,
and concrete recommendations for the mobile/responsive and polish pass.

---

## What Was Built in the v05 Session

Starting from `pressure_map_interactive_v04.html` (a Python-generated, static visualization
with a hardcoded JSON payload), v05 became a fully self-contained, client-side drag-and-drop
tool. Every step was validated end-to-end before moving on.

**Steps completed:**

| Step | What happened |
|---|---|
| 4 | FIT binary parser written in Node.js (validated against `23157999972.zip`). Uses `DataView` in the browser. Handles compressed-timestamp headers, developer field declarations (mesg 206/207), GPS semicircle conversion, and FIT invalid-value sentinels. |
| 5 | Processing pipeline: all-zero channel detection, linear interpolation for dropout zeros, Savitzky-Golay smoothing (window=21, poly=3, coefficients computed analytically), GPS-first decimation (DECIM=2), segment building, haversine distance, p10/p90 percentiles. |
| 6 | Pipeline output verified segment-by-segment against the v04 embedded DATA. Root cause of a GPS mismatch found and fixed: decimation must happen on GPS-valid records only, matching the Python pipeline's behaviour. 3,826/3,826 GPS exact matches, pressure p99 diff < 0.007 PSI. |
| 7 | Landing UI built: dark radial-gradient background, PressureWerx gauge SVG + wordmark, Barlow Condensed tagline, dashed drop zone with drag-over highlight, "Load example session" link. |
| 8 | Upload → parse → render wired. `renderVisualization(DATA)` populates all metadata chips, initialises Leaflet, draws polylines, wires dual-handle pressure and time sliders, draws the inline SVG timegraph, connects preset buttons and keyboard shortcuts (R/T/F). "Load different file" cleanly destroys the map and event listeners and returns to landing. |
| 9 | Example data embedded as base64 ZIP (~158 KB). Option A chosen (runs through the real parser pipeline) so the example button exercises the same code path as a user drop. Works with `file://` protocol — no server required. |
| 10 | Full end-to-end Playwright test: landing, load-example, slider drag, time drag, keyboard shortcuts, preset buttons, load-different-file, raw .fit drop, wrong-file error, re-entry safety, file:// protocol. All pass. |

**Additional work done post-v05:**

- **Dark brand theme** applied to the vis panel: `#0a0a0a` page background, `#111` container,
  `#000` timegraph (user confirmed yellow RdYlBu mid-range reads clearly on black),
  Barlow font throughout, red `#E8291C` pressure gauge needle, grey time-window range bar.
- **Legacy FIT format** (`pressure_psi` single field) supported by extending `detectChannels`
  and the primary-key selection to fall back from `pressure_le` → `pressure_st` → `pressure_psi`.
  Validated against `examples/22483130534.zip` (4h 15m session, 7,237 segments, 7.44–9.47 PSI).
- **Third example file** (`examples/22966719708_ACTIVITY.fit`) diagnosed and validated: bare `.fit`
  (no ZIP wrapper), `pressure_psi` format, 1h 37m, 2,931 segments, 8.21–9.07 PSI. The file was
  actually working — it had been tested before `pressure_psi` support was added. Test script now
  handles both bare `.fit` and `.zip` inputs via a `loadFit()` helper.
- **GPS-absent guard** added to `processRecords` in both files: if `withGps.length === 0`, throws
  `'No GPS data found in file — cannot build map track'` instead of a cryptic `TypeError`.
  Handles indoor sessions or devices without a GPS lock.
- **Date field fixed**: the vis header previously showed `Date —`. FIT timestamps are absolute
  UTC (seconds since 1989-12-31), so `t_date_str` is now computed via `toDateStr(tStart)` and
  returned from `processRecords`. Format: `"Sun, 07 Jun 2026"`. Both `pressure_map_interactive_v05.html`
  and `fit_parser_test.js` updated.

**Final deliverable:**

- `pressure_map_interactive_v05.html` — fully self-contained (no build tools, no server)
- `fit_parser_test.js` — Node.js validation harness; run with `node fit_parser_test.js`

---

## Quick Win to Do First

### Add the favicon

`index.html` already has the PressureWerx icon in the browser tab. Copy its `<link rel="icon">`
tag into v05's `<head>` (it's a self-contained base64 PNG, no external file needed):

```html
<!-- Copy this line from index.html line 4 and paste it into v05 <head> -->
<link rel="icon" type="image/png" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2j...">
```

---

## Known Mobile Issues

The v04/v05 visualization layout was designed desktop-first. The spec noted these explicitly
as "v07 work" but they are documented here with enough detail to act on.

### 1. Fixed-height layout breaks on portrait phones

The vis panel uses `height: 100vh; overflow: hidden` with a flex-column layout:
- Header strip (~46px)
- Timegraph (fixed 130px)
- Map (fills remaining space with `flex: 1 1 auto`)
- Controls strip (~120px)

On a 667px-tall iPhone SE in portrait, the map gets roughly 300px — barely usable.
On phones with browser chrome (address bar + bottom bar), it can collapse to ~220px.

### 2. Meta strip wraps or overflows

The header meta chips `Date · Time · Duration · Distance · Mean` are inline with `gap: 18px`.
On screens narrower than ~700px they push into the logo or wrap messily.

### 3. Controls strip is cramped on narrow screens

The pressure slider, time slider, and button row all need to work in ~320–375px width.
The PSI readout labels (`Blue = 8.29 PSI` / `Red = 8.74 PSI`) and button row are already
tight; they will overlap on smaller phones.

### 4. Timegraph Y-axis labels clip

The Y-axis tick labels sit at `x=TG_PAD_L-4` (34px from left). On narrow displays the SVG
scales but `preserveAspectRatio="none"` distorts the text; labels can become unreadably thin.

### 5. Leaflet controls placement

The Leaflet zoom control (top-left) and layer switcher (top-right) sit inside the map, which
is fine on desktop. On mobile the layer switcher overlaps the track on small viewports.

---

## Recommended Mobile/Responsive Plan

### A. Landing page (already mostly fine)

The landing page uses flexbox and `clamp()` font sizes — it scales well. Minor tweaks:

- The drop zone (`min-height: 180px`) gets a bit tall on landscape phones;
  `min-height: clamp(120px, 25vw, 180px)` would help.
- On iOS, `<input type="file">` inside a `<label>` works but the file picker defaults to
  Photos. Add `accept=".fit,.zip"` (already present) and test that Garmin Connect exports
  appear in the Files picker.

### B. Visualization panel — two-breakpoint layout

**Breakpoint 1: ≤ 768px (tablets portrait, large phones landscape)**

- Reduce timegraph height: `flex: 0 0 90px`
- Meta strip: keep horizontal but show only Time + Duration + Mean (hide Date and Distance,
  or move them to a second line that only shows on hover/tap)
- Increase font-size floor in `clamp()` for slider labels

**Breakpoint 2: ≤ 480px (phones portrait)**

- **Stack controls below map** but allow the panel to scroll vertically:
  change `#vis { overflow: hidden }` → `overflow-y: auto` at this breakpoint
- Timegraph: `flex: 0 0 70px`
- Meta strip: two-line layout or horizontal scroll (`overflow-x: auto; white-space: nowrap`)
- Button row: wrap with `flex-wrap: wrap; gap: 6px`
- Slider thumb size: already bumped to 28px via `@media (pointer: coarse)` — keep this
- "Load different file": change from `text-decoration: underline` text to a small button
  with explicit `min-height: 44px` tap target

### C. Timegraph SVG — make labels responsive

The timegraph is drawn as a fixed 900×130 SVG with `preserveAspectRatio="none"`. To keep
labels readable:

Option A (simpler): keep the viewBox but switch to `preserveAspectRatio="xMidYMid meet"` and
let the SVG add letterbox padding. Adjust `TG_PAD_L` in the JS to leave enough room.

Option B (proper): make `TG_W` dynamic — read `tgSvg.getBoundingClientRect().width` inside
`drawTimeGraph()` and pass that as the effective width instead of the hardcoded 900.

### D. Map height floor

Add a CSS rule so the map never collapses below a useful size:

```css
#vis #map { min-height: clamp(200px, 40vh, 9999px); }
```

### E. Keyboard shortcuts — supplement with visible buttons on touch

On touch devices the R/T/F shortcuts are invisible affordances. Either:
- Add small icon-buttons in the controls strip (e.g., a reset icon next to each slider)
- Or add a floating "Reset all" button that appears when any slider is non-default

---

## PC Enhancements Worth Considering

- **Full-screen button** — a small ⛶ icon in the header that calls `document.documentElement.requestFullscreen()`. Especially useful for demo/presentation use.
- **Keyboard shortcut hint** — a `?` icon that shows a small overlay: `R` reset colour · `T` reset time · `F` full range.
- **URL hash state** — encode current slider positions in `window.location.hash` so a specific
  view can be shared. Decode on load and apply before the first `applyColors()` call.
- **Wider timegraph at large viewports** — at >1400px the container hits its `max-width: 1120px`
  cap; consider increasing to 1280–1400px so the map and graph use more screen real estate.

---

## File Reference

| File | Role |
|---|---|
| `pressure_map_interactive_v05.html` | Current deliverable — all v05 code lives here |
| `fit_parser_test.js` | Node.js validation harness — run with `node fit_parser_test.js` |
| `examples/23157999972.zip` | Current-format FIT (2h 11m, `pressure_le` + `pressure_st`) — used as embedded example |
| `examples/22483130534.zip` | Legacy-format FIT (4h 15m, `pressure_psi` only) |
| `examples/22966719708_ACTIVITY.fit` | Bare `.fit` (no ZIP), `pressure_psi` format, 1h 37m |
| `docs/v05_handoff.md` | Original v05 build spec — authoritative reference for data pipeline decisions |
| `docs/wing_pressure_visualization.md` | Full processing spec — smoothing params, colour scale, layout decisions |
| `index.html` | Marketing site — brand reference for colours, fonts, logo |
