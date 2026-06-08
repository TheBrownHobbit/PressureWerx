# v05 Handoff — Drag-and-Drop FIT File Upload

This document is the build plan for v05 of the PressureWerx wing pressure
visualization tool. It is intended for Claude Code to execute against the
`PressureWerxWeb` repo.

## Context

- **`docs/wing_pressure_visualization.md`** — the full processing spec
  (data cleaning, smoothing, colour mapping, layout, all v04 decisions).
  Read this first. It is the canonical reference for every data-processing
  and rendering decision.
- **`pressure_map_interactive_v04.html`** — the current working visualization.
  All rendering code (map, time graph, sliders, controls, keyboard shortcuts)
  lives here and should be carried forward into v05.
- **`examples/23157999972.zip`** — a Garmin Connect export containing a
  single `.fit` file. This is the test dataset and the example data that
  ships with the tool.
- **`index.html`** — the PressureWerx marketing site. Use this as the
  **brand reference** for the upload/landing screen styling (not for the
  visualization panel, which keeps its v04 warm-light treatment).

## What v05 Delivers

A single self-contained HTML file (`pressure_map_interactive_v05.html`)
that replaces the v04 file. The key change: instead of embedding a
pre-computed JSON payload, the user drops a `.fit` or `.zip` file into
the browser and all parsing + processing happens client-side.

## Architecture

### Two-state UI

1. **Landing state** — displayed on load, no data yet.
2. **Visualization state** — displayed after a file is successfully loaded.

A "Load different file" action in the header returns to landing state.

### Landing State (dark brand theme)

Match the `index.html` brand language:

- **Background:** `#0a0a0a` (or the radial gradient from the site's cover)
- **Font:** Barlow (via Google Fonts, already in the site's `<link>`)
  - Barlow Condensed for labels/eyebrows
  - Barlow 300/400/700 for body/headings
- **Accent:** `#E8291C` (PressureWerx red)
- **Logo:** the SVG gauge icon from `index.html` (the `<svg>` in the
  `.logo-lockup`) plus the "PressureWerx" wordmark

Layout (centered, vertically):

```
[Logo + PressureWerx wordmark]
[Red divider line]
[Tagline: "Wing Pressure Analysis"]

[  Drop zone  ]
  Dashed border, ~300×180px (responsive)
  Icon: upload/cloud-upload SVG
  Text: "Drop a .fit or .zip file here"
  Subtext: "or click to browse"
  (The entire zone is a clickable label wrapping a hidden file input)

[Load example session]  ← subtle text link below the drop zone
```

- Drop zone border: dashed, `#2a2a2a`, brightens on drag-over
- Drop zone accepts `.fit` and `.zip` files only
- "Load example session" loads the bundled example data

### File Processing Pipeline (all client-side JS)

**1. File intake:**
- If `.zip`: decompress with JSZip (CDN: `https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js`), find the first `.fit` file inside
- If `.fit`: use directly
- Show a brief processing indicator during parse

**2. FIT binary parsing:**
Write a focused inline FIT parser. The FIT protocol is documented by Garmin.
Key structures:

- 14-byte file header (or 12-byte legacy)
- Data records: 1-byte record header → definition messages or data messages
- Definition messages declare field layout for a local message type
- Data messages carry field values per the most recent definition
- Developer fields are declared via `developer_data_id` (mesg 207) and
  `field_description` (mesg 206) messages, then appear in data messages
  with the developer-field bit set

Fields to extract from `record` messages (mesg 20):

| Field                | Global ID | Type    | Notes                              |
|----------------------|-----------|---------|------------------------------------|
| `timestamp`          | 253       | uint32  | Seconds since 1989-12-31 00:00:00  |
| `position_lat`       | 0         | sint32  | Semicircles                        |
| `position_long`      | 1         | sint32  | Semicircles                        |

Developer fields (identified by field name in field_description messages):

| Field name      | Units | Notes                    |
|-----------------|-------|--------------------------|
| `pressure_le`   | PSI   | Leading-edge pressure    |
| `pressure_st`   | PSI   | Strut pressure           |
| `pressure_ref`  | hPa   | Barometric reference     |

The parser does NOT need to handle every FIT message type — only enough
to reach the `record` messages and extract the above fields. Skip/ignore
all other message types.

**FIT timestamp epoch:** 1989-12-31T00:00:00Z (631065600 seconds before
Unix epoch). Convert to JS Date: `new Date((fitTimestamp + 631065600) * 1000)`.

**GPS semicircles → degrees:** `value * (180 / 2^31)`

**3. Data cleaning** (per the handoff spec §2):
- Detect all-zero channels (sensor not present) — skip entirely
- Replace individual zero samples with linear interpolation
- Apply Savitzky-Golay smoothing: window=21, polyorder=3
  (implement the SG convolution coefficients inline — it's a fixed
  set of 21 coefficients for cubic polynomial fit)

**4. Segment construction:**
- Decimate: take every 2nd sample (`DECIM = 2`)
- Build segments: `[lat1, lon1, lat2, lon2, pressure]` for each
  consecutive pair of decimated points
- Compute `seg_seconds`: seconds-from-start for each segment
- Drop segments where GPS is missing

**5. Metadata computation:**
- Duration (seconds), start/end times (HH:MM:SS)
- Total distance (haversine sum from GPS pairs)
- Mean pressure (of the primary channel)
- Data min/max, default slider positions (p10/p90 percentiles)
- Center point, bounding box, start/end markers

**6. Build the DATA object** matching the v04 payload structure exactly:
```javascript
{
  segments, seg_seconds, duration_s,
  t_start_str, t_end_str,
  data_min, data_max, default_min, default_max,
  center, bbox, start, end
}
```

### Visualization State (warm light theme)

Transition from landing to visualization by hiding the landing div and
showing the visualization container. All v04 rendering code applies:

- Header strip with logo + metadata chips (dynamically populated)
- Pressure-vs-time SVG graph
- Leaflet map with coloured polylines
- Pressure window slider (dual-handle, gradient)
- Time window slider (dual-handle, grey)
- Preset buttons — **dynamically generated** from data range, not hardcoded
  - "Reset color" → p10/p90
  - "Full data range" → data_min/data_max
  - "Full time" → 0..N_SEG
- Keyboard shortcuts: R, T, F
- Add a "Load different file" button/link in the header

Keep the v04 warm palette for the visualization panel:
- `--brand-bg: #f5f3f0`, `--warm-grey: #ece9e3`, `--panel: #ffffff`
- The v04 CSS and rendering code should be preserved as-is

### Example Data

The example FIT file (`examples/23157999972.zip`) needs to be loadable
without the user having a file. Two options (choose the simpler one):

**Option A:** Embed the FIT binary as a base64 string in the HTML.
On "Load example session" click, decode and feed it through the same
parsing pipeline.

**Option B:** Embed the pre-computed DATA JSON (from v04) as a fallback.
On "Load example session" click, skip parsing and go straight to rendering
with the embedded payload.

Option B is simpler and smaller. Option A is more honest (tests the parser).
Recommend Option A if the file size stays under ~500KB base64.

### Mobile Responsiveness (v07 prep)

Not the primary goal of v05, but lay the groundwork:

- Use `viewport` meta tag
- Landing page should be fully responsive (flexbox, no fixed widths)
- Visualization panel: the v04 layout has known mobile issues — note them
  but don't fix in v05. The v07 pass will address responsive map sizing,
  stacked controls, and touch-friendly sliders.

### External Dependencies (CDN)

- Leaflet 1.9.4 (CSS + JS) — already used in v04
- JSZip 3.10.1 — for ZIP decompression
- Google Fonts: Barlow + Barlow Condensed — for landing screen

No other external dependencies. No build tools. Single HTML file.

## Build Order

1. Read `docs/wing_pressure_visualization.md` thoroughly
2. Read `pressure_map_interactive_v04.html` to understand all rendering code
3. Unzip and inspect the example FIT file to understand the binary structure
4. Build the FIT parser, test it against the example file
5. Build the processing pipeline (zero-fill, smoothing, segments)
6. Verify the computed DATA matches the v04 embedded DATA
7. Build the landing UI
8. Wire upload → parse → render
9. Embed example data
10. Test end-to-end

## Acceptance Criteria

- Drop the example ZIP → visualization renders identically to v04
- Drop a raw `.fit` file → same result
- "Load example session" → same result
- "Load different file" → returns to landing
- Landing page matches PressureWerx brand (dark theme, Barlow, red accent)
- No console errors
- File size under 600KB (excluding embedded example data)
