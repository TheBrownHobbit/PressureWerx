# Handover: Session Archive File Feature

**Target repo:** `pressure_map_interactive` (the data viewer web tool)
**Target file:** `pressure_map_interactive_v05.html` (single-file static HTML app)
**Deliverable:** A new "Export Archive CSV" button that produces an enriched CSV containing user-supplied metadata + auto-fetched weather + the existing session data, plus the ability to re-import that ARCH file, plus a small rev counter in the corner.

---

## 1. Context and constraints

The data viewer is a single self-contained HTML file hosted on GitHub Pages. It has no build step, no server, and no backend. **All work in this feature must remain 100% client-side.** The existing `Export CSV` button (id `exportCsv`, currently around line 1677) must not be touched — the archive feature is additive and reuses its output structure verbatim for the data section.

The tool already accepts FIT files, ZIP-wrapped FIT files, and CSVs (its own export format and legacy formats). See `parseCSVFile()` around line 993 for existing CSV detection logic; you'll extend it to recognize ARCH files.

---

## 2. What we're building — three pieces

1. **"Export Archive CSV" button** next to the existing Export CSV button, opening a modal for metadata + weather.
2. **ARCH file format:** marker row + metadata rows + blank line + existing CSV format.
3. **ARCH re-import support** in the existing parser + a rev counter in the bottom-right corner.

---

## 3. UI changes

### 3.1 New button
Add `<button id="exportArchCsv" type="button" style="display:none;">Export Archive CSV</button>` immediately after the existing `#exportCsv` button. Show/hide it under the same conditions as `#exportCsv` (unhide when a session is loaded). If the currently loaded session is an ARCH file, the button should be visible but **disabled** with a tooltip: `"Can't archive an archive — this file is already an ARCH file."`

### 3.2 Modal
Simple centered popup, dark theme matching the existing UI (`--panel: #111111`, `--border: #2a2a2a`, etc. — vars are already defined). Backdrop dimming, click-outside-to-cancel, ESC to cancel. Two visible sections plus action buttons:

**Section A: Session metadata** (all fields optional, all leave-blank OK)
- `Leading Edge Sensor ID` — text input, max 200 chars
- `Strut Sensor ID` — text input, max 200 chars
- `Sensor Position Comment` — textarea, max 200 chars
- `Weather Observations` — textarea, max 500 chars (user's own notes, separate from fetched data)

**Section B: Weather (auto-fetch)**
- A "Fetch weather for this session" button
- Display area for the 10 fetched weather values (read-only, populated after fetch)
- Loading spinner during fetch
- Error message area if fetch fails ("Weather lookup unavailable — you can still export.")
- If the loaded session has **no GPS** (no lat/lon in any record), disable this whole section with a note: `"No GPS in session — weather lookup requires location."`

**Actions:** `Cancel` button, `Export Archive CSV` button. The export button is always enabled — nothing in the modal is required.

### 3.3 Rev counter
Fixed-position `<div>` in the bottom-right corner. Very small font (10-11px), low opacity (~0.35), muted grey color, no border, no background. Content: `v{APP_VERSION}`. Should be visually noise-free but readable if you look for it. Add near the top of the `<script>` block:

```js
const APP_VERSION = '0.6';  // bump manually per revision
```

And render it into the corner div on page load.

---

## 4. Weather integration — Open-Meteo

### 4.1 API choice and rationale
Use [Open-Meteo](https://open-meteo.com/) — free, no API key required, CORS-enabled (works from a static HTML file), global coverage. Two endpoints to branch between:

- **Historical Weather API** (`https://archive-api.open-meteo.com/v1/archive`) — for sessions older than ~5 days
- **Forecast API** (`https://api.open-meteo.com/v1/forecast`) with `past_days` parameter — for sessions within the last ~5 days (the archive lags)

### 4.2 Endpoint selection logic
```js
const sessionDate = /* Date of first record with GPS */;
const daysAgo = (Date.now() - sessionDate.getTime()) / (1000 * 60 * 60 * 24);
const useForecast = daysAgo < 6;  // small buffer
```

### 4.3 Field list (confirmed field names — verify against live docs during implementation)
Fetch these hourly variables:

| Open-Meteo variable | Meaning | Units |
|---|---|---|
| `temperature_2m` | Air temperature at 2m | °C |
| `dewpoint_2m` | Dewpoint at 2m | °C |
| `relative_humidity_2m` | Relative humidity | % |
| `pressure_msl` | Sea-level barometric pressure | hPa |
| `cloud_cover` | Total cloud cover | % |
| `precipitation` | Precipitation in that hour | mm |
| `wind_speed_10m` | Wind speed at 10m | knots |
| `wind_direction_10m` | Wind direction at 10m | degrees |
| `wind_gusts_10m` | Peak gust at 10m | knots |
| `weather_code` | WMO weather condition code | integer |

**Units:** pass `&temperature_unit=celsius&wind_speed_unit=kn&precipitation_unit=mm` in the query. (Pressure and cloud cover have no unit toggle — hPa and % are the defaults.)

**Weather code translation:** WMO codes need to be mapped to human-readable strings for the CSV. Include a small lookup table in the code: `0 = Clear`, `1-3 = Partly cloudy`, `45/48 = Fog`, `51/53/55 = Drizzle`, `61/63/65 = Rain`, `71/73/75 = Snow`, `80-82 = Rain showers`, `95 = Thunderstorm`, `96/99 = Thunderstorm with hail`. Full WMO list is in the Open-Meteo docs — worth a quick fetch during implementation to confirm current code definitions.

### 4.4 Example query
```
https://archive-api.open-meteo.com/v1/archive
  ?latitude=-36.8485
  &longitude=174.7633
  &start_date=2024-09-15
  &end_date=2024-09-15
  &hourly=temperature_2m,dewpoint_2m,relative_humidity_2m,pressure_msl,cloud_cover,precipitation,wind_speed_10m,wind_direction_10m,wind_gusts_10m,weather_code
  &temperature_unit=celsius
  &wind_speed_unit=kn
  &precipitation_unit=mm
  &timezone=UTC
```

Pick the hourly value whose timestamp is closest to the session's first-record timestamp. Use the first record with GPS as the location anchor.

### 4.5 Error handling
- Timeout: 10 seconds. If fetch times out, show the error message in the modal and disable the weather fields (still allow export without weather).
- Network failure / non-200 response: same treatment.
- No GPS in session: don't offer the fetch button at all; show the "No GPS" note.
- **Never block the export.** Weather is best-effort enrichment.

### 4.6 Sanity check during implementation
Open-Meteo occasionally adds fields. Before wiring the variable names above into the code, do one live fetch against the docs page or a test call to confirm the field spellings are still current. This prevents a silent "field not found → empty column" failure.

---

## 5. ARCH file format specification

### 5.1 Structure
```
PressureWerx Archive,v1
Leading Edge Sensor ID,<value or empty>
Strut Sensor ID,<value or empty>
Sensor Position Comment,<value or empty>
Weather Observations,<value or empty>
Weather Temperature C,<value or empty>
Weather Dewpoint C,<value or empty>
Weather Relative Humidity %,<value or empty>
Weather Pressure MSL hPa,<value or empty>
Weather Cloud Cover %,<value or empty>
Weather Precipitation mm,<value or empty>
Weather Wind Speed kn,<value or empty>
Weather Wind Direction deg,<value or empty>
Weather Wind Gusts kn,<value or empty>
Weather Code,<value or empty>
Weather Condition,<human-readable string or empty>
Weather Source,Open-Meteo
Weather Fetched At,<ISO 8601 UTC timestamp>
Archive Created At,<ISO 8601 UTC timestamp>
Archive App Version,<APP_VERSION>

index,timestamp_utc,lat,lon,pressure_le_psi,pressure_ds_psi,le_age,st_age
1,2024-09-15T14:22:03Z,-36.8485,174.7633,12.4,,,
2,2024-09-15T14:22:04Z,-36.8485,174.7633,12.5,,,
... (etc — identical to current Export CSV output)
```

### 5.2 Key format rules
- **First row is the marker.** Always `PressureWerx Archive,v1`. This is how re-import detects an ARCH file (filename-independent per your decision).
- **Metadata rows:** field name in column A, value in column B. One row per field. All fields present even when empty (empty column B). This makes the format stable across versions.
- **CSV-escape values in column B** that contain commas, quotes, or newlines — wrap in `"..."` and double any internal `"`. The metadata textareas allow characters that break naive CSV parsing.
- **Blank row** separates the metadata block from the data block.
- **Data block** is exactly the output of the current Export CSV button — same header row, same column set, same content. Do not duplicate the export logic; refactor the existing export into a shared function that both buttons call.

### 5.3 Extension
`.csv` — the file is still valid CSV, just with a metadata preamble. Standard spreadsheet tools will open it (they'll see the preamble as leading rows). This is intentional and worth preserving.

---

## 6. Filename rules

| Source | Filename pattern | Example |
|---|---|---|
| FIT (or ZIP-wrapped FIT) | `ARCH_<fit-base>_<YYYY-MM-DD>.csv` | `ARCH_231579999972_ACTIVITY_2024-09-15.csv` |
| CSV (any non-ARCH CSV) | `ARCH_<original-filename>` | `some_export.csv` → `ARCH_some_export.csv` |
| ARCH | **Blocked** — button disabled | — |

**Date source:** the session's first-record timestamp (converted from FIT epoch to UTC date), formatted as `YYYY-MM-DD`. Not the export date, not the current date.

**FIT base extraction:** strip `.fit` and `.zip` extensions from the source filename before prepending `ARCH_` and appending `_<date>`.

---

## 7. Re-import behavior

### 7.1 Detection
In `parseCSVFile()` (around line 993), before the existing "own export" detection, add ARCH detection:

```js
if (lines[0].startsWith('PressureWerx Archive,v')) {
  return parseArchCsv(text, filename);
}
```

### 7.2 Parsing
`parseArchCsv()` should:
1. Parse the marker row to extract the format version (`v1`). Store this so future versions can branch on it.
2. Read metadata rows into a `metadata` object until a blank line is encountered.
3. Everything after the blank line is standard CSV — feed it to the existing "own export" parsing path (the block starting `if (isOwnExport)` around line 1008). Refactor that block into a reusable function to avoid duplication.
4. Attach the parsed metadata to `_vis` (e.g. `_vis.archMetadata = {...}`) so it's available to UI code and the archive-of-archive block.
5. Set a flag `_vis.isArchive = true` so the export button can grey itself out.

### 7.3 UI feedback when ARCH is loaded
- The "Export Archive CSV" button greys out with the tooltip from section 3.1.
- Consider adding a small "Archive file loaded" indicator somewhere in the meta strip (optional — flag for later if it feels like scope creep).

---

## 8. Non-goals (explicitly out of scope)

- No changes to the existing `Export CSV` button, its output format, or its filename.
- No changes to FIT parsing.
- No new external dependencies. Open-Meteo is called with plain `fetch()`; no library needed.
- No server-side anything.
- No storage/persistence between sessions — the modal is filled fresh each time.
- No editing of metadata after export (if the user wants to change something, they re-export).

---

## 9. Acceptance tests

Before considering the feature done, verify all of these:

1. **Round-trip:** Load a FIT file → click "Export Archive CSV" → fill some fields → fetch weather → export. Then load the resulting ARCH file. Confirm: data displays correctly, metadata is stored on `_vis`, archive button is greyed with correct tooltip.

2. **All-empty archive:** Same but leave every field blank and skip weather fetch. Export should succeed with empty column-B values. Re-import should still work.

3. **No-GPS session:** Load a FIT with no GPS (or a CSV without lat/lon). Open modal. Confirm weather section is disabled with the "No GPS" note. Confirm export still works.

4. **Weather API down:** Simulate by blocking `archive-api.open-meteo.com` in devtools network tab. Click fetch. Confirm graceful error message and that export still works without weather values.

5. **Recent session:** Load a session from within the last 5 days. Confirm the code uses the forecast endpoint (not the archive endpoint) and returns real data.

6. **CSV-source archive:** Load a plain (non-ARCH) CSV export. Confirm ARCH export produces `ARCH_<original-name>.csv` (no date added).

7. **Archive-of-archive block:** With an ARCH file loaded, confirm the button is greyed out. Force-enable it in devtools and click — confirm the alert dialog fires.

8. **Rev counter:** Confirm it renders in the bottom-right corner, small and faint, showing the current `APP_VERSION`.

9. **Character limits:** Try to paste 500 chars into a 200-char field — confirm it's truncated or blocked.

10. **CSV escaping:** Enter `A comment, with a comma and a "quote"` in Sensor Position Comment. Export, then open the CSV in a spreadsheet — confirm it parses as one field.

---

## 10. Implementation notes

- Bump `APP_VERSION` to `'0.6'` in this change (or whatever the next number is when you commit).
- Keep the archive export function as a wrapper around a shared "get data CSV" function that the existing Export CSV button also uses. This ensures the data section stays byte-identical between the two exports.
- The modal HTML can live in the same file — no need for a separate template. Look at how `#processing` and `#landing` are structured for the pattern.
- The metadata field labels in the CSV (`Leading Edge Sensor ID`, etc.) are the canonical strings — don't change them without a format version bump, because the re-import parser matches on them.

---

## 11. Adjustable defaults (flag if you want different)

These were set as sensible defaults without explicit user decision — easy to change during implementation:

- **Character limits:** 200 chars for ID/comment fields, 500 for weather notes.
- **Units:** °C, hPa, knots, mm, degrees. (Knots for wind because of the aviation lean; change to km/h or m/s if preferred.)
- **Timeout:** 10 seconds for the weather API call.
- **Starting APP_VERSION:** `'0.6'` — adjust to match your actual current rev.
