# PressureWerx Web Viewer — CSV Ingest Handoff

## Context

This document is a handoff brief for a Claude instance working in the PressureWerx
web repository. It describes a new feature to be added to the existing web viewer.

**What the web viewer already does:**
The site has a drag-and-drop FIT file viewer. A user drops a `.fit` file (or a `.zip`
containing one) onto the page and the viewer renders an interactive chart of the
workout data. The FIT path is working and should not be changed.

**What we want to add:**
Extend the drop zone to also accept `.csv` files. When a CSV is dropped, auto-detect
which of three PressureWerx formats it is (by filename prefix), parse it, and render
an interactive chart that mirrors the FIT viewer experience: pressure vs. time as the
primary display, with a compact GPS map for context where data is available.

The three CSV types come from three different recording paths in the PressureWerx
iOS/watchOS app — but they share a unified leading-column schema and can be handled
with a common rendering layer once parsed.

---

## File Identification — Detect by Filename Prefix

| Filename prefix | Source | Sensors |
|----------------|--------|---------|
| `WingLog_` | iPhone wing session | LE + Strut (2 sensors max) |
| `WatchLog_` | Apple Watch direct session | LE + Strut (2 sensors max) |
| `MultiLog_` | iPhone multi-sensor bench log | Up to 6 sensors (dynamic) |

Full filename patterns:
- `WingLog_<WingName>_<YYYY-MM-DD>.csv` (e.g. `WingLog_My_Wing_2026-06-29.csv`)
- `WingLog_<WingName>_<YYYY-MM-DD>_v2.csv` (versioned if same day was already exported)
- `WatchLog_<YYYY-MM-DD_HHmmss>.csv` (e.g. `WatchLog_2026-06-29_143201.csv`)
- `MultiLog_<TestName>_<YYYY-MM-DD_HHmmssSSS>.csv` (e.g. `MultiLog_PumpTest_2026-06-29_143201123.csv`)

---

## Unified Leading Columns — All Three File Types

Every PressureWerx CSV starts with these seven columns in this exact order:

```
Index, Timestamp, Latitude, Longitude, Speed_knots, Distance_nm, ReferencePressure_hPa
```

| Column | Type | Notes |
|--------|------|-------|
| `Index` | integer | Row counter starting at 1; resets each session. Use as x-axis for charts. |
| `Timestamp` | ISO 8601 string | e.g. `2026-06-29T14:32:01Z`. Always UTC with Z suffix. |
| `Latitude` | float string | Decimal degrees, 6 dp. Empty string `""` if no GPS fix. |
| `Longitude` | float string | Decimal degrees, 6 dp. Empty string `""` if no GPS fix. |
| `Speed_knots` | float string | Knots, 2 dp. Empty string if no GPS fix. |
| `Distance_nm` | float string | Cumulative session distance in nautical miles, 2 dp. |
| `ReferencePressure_hPa` | float string | Barometric reference used to compute gauge pressure, 2 dp. |

All values are strings in the CSV. Parse numerics carefully; treat empty string as
`null`/missing, not zero. GPS columns are frequently empty for MultiLog bench sessions.

---

## WingLog — iPhone Wing Session

**Trailing columns (after the 7 leading):**

```
<UUID4>_LE_GaugePressure_PSI, <UUID4>_LE_TempC,
<UUID4>_Strut_GaugePressure_PSI, <UUID4>_Strut_TempC
```

The `<UUID4>` prefix is a 4-character hex identifier for the physical sensor (last 4
chars of the Bluetooth UUID, uppercased — e.g. `50DA`). It is the same for every row
in a given file but may differ between files if a sensor is replaced.

**Detecting LE vs Strut columns:** match by suffix:
- `_LE_GaugePressure_PSI` — leading edge gauge pressure in PSI
- `_LE_TempC` — leading edge temperature in °C
- `_Strut_GaugePressure_PSI` — strut gauge pressure in PSI
- `_Strut_TempC` — strut temperature in °C

**Values:** Gauge PSI, 2 dp (e.g. `9.82`). Temperature °C, 2 dp (e.g. `24.30`).
Empty string if sensor absent or not transmitting that row.

**Full header example (10 columns):**
```
Index,Timestamp,Latitude,Longitude,Speed_knots,Distance_nm,ReferencePressure_hPa,50DA_LE_GaugePressure_PSI,50DA_LE_TempC,A1B2_Strut_GaugePressure_PSI,A1B2_Strut_TempC
```

**Legacy format detection:** Some older WingLog files use a different schema (17
columns, first column is `Timestamp` not `Index`, contains `LE_AdjustedPressure` in
hPa rather than PSI). Detect legacy files by checking if `headers[0] === "Timestamp"`
AND `headers` contains `"LE_AdjustedPressure"`. For legacy files: convert
`LE_AdjustedPressure` (hPa) → PSI by multiplying by `0.0145038`. The web viewer can
treat legacy files as read-only display with a note; no need to match column names.

---

## WatchLog — Apple Watch Direct Session

Schema is **identical** to WingLog — same 7 leading columns, same UUID4-prefixed
sensor columns, same suffix pattern for LE/Strut detection.

The only differences are in the filename pattern and source (Apple Watch GPS vs
iPhone GPS). Parse and display exactly the same way as WingLog.

**Full header example (10 columns):**
```
Index,Timestamp,Latitude,Longitude,Speed_knots,Distance_nm,ReferencePressure_hPa,50DA_LE_GaugePressure_PSI,50DA_LE_TempC,A1B2_Strut_GaugePressure_PSI,A1B2_Strut_TempC
```

WatchLog sessions are typically on-water and will usually have GPS data. Speed and
distance are meaningful for these files.

---

## MultiLog — Multi-Sensor Bench Log

Up to 6 sensors. Sensor columns are dynamic — the number and names vary by session.

**Trailing columns (after the 7 leading):**

```
<SensorName>_GaugePSI, <SensorName>_TempC,
<SensorName>_GaugePSI, <SensorName>_TempC,
...  (repeated for each sensor, up to 6 pairs)
```

`<SensorName>` is one of:
1. A user-assigned label (e.g. `MySensor_GaugePSI`)
2. The suffix after the last `-` in the Bluetooth device name (e.g. `50DA_GaugePSI`)
3. If two sensors share a display name, a counter suffix: `50DA_2_GaugePSI`

**Detecting sensor columns:** All sensor columns end in `_GaugePSI` or `_TempC`.
Extract sensor names dynamically from the header by stripping these suffixes. Column
order is always paired: `<name>_GaugePSI` immediately followed by `<name>_TempC`.

**Values:** Gauge PSI, 2 dp. Temperature °C, 2 dp. Empty string if sensor absent.

**Full header example (2 sensors, 11 columns):**
```
Index,Timestamp,Latitude,Longitude,Speed_knots,Distance_nm,ReferencePressure_hPa,50DA_GaugePSI,50DA_TempC,A1B2_GaugePSI,A1B2_TempC
```

**Note on GPS:** MultiLog sessions are typically bench tests (stationary). Latitude
and Longitude will often be a single repeated value or empty. Distance_nm will usually
be `0.00`. Render the map only if GPS data is non-empty; for bench sessions it will
show a single location pin.

**Legacy format detection:** Old MultiLog files (pre GPS schema) have `Timestamp` as
the first column (not `Index`) and only 3 leading columns:
`Timestamp, TestName, ReferencePressure_hPa`. Sensor columns start at index 3 (not 7).
Detect by: `headers[0] === "Timestamp"` AND `headers[1] === "TestName"`.

---

## Display Requirements

### Primary: Pressure vs. Time chart
- X-axis: `Timestamp` (parsed as Date). Label with time-of-day (HH:mm format is fine).
- Y-axis: Gauge pressure in PSI. Left side.
- One line per sensor.
- **Colour convention (match the iOS app exactly):**
  - For WingLog / WatchLog: LE = `#0080FF` (blue), Strut = `#FF8000` (orange)
  - For MultiLog: first sensor = blue, second = orange, then green, purple, red, teal
    (same order as iOS: `[.blue, .orange, .green, .purple, .red, .teal]`)
- Legend: sensor name or LE/Strut label, coloured to match line.

### Secondary: GPS track map
- Show only if at least one row has non-empty Latitude/Longitude.
- For moving sessions (WingLog, WatchLog): render a polyline track.
- For stationary sessions (most MultiLog): render a single marker.
- Compact — context only, not the hero element.

### Stats panel
- Per sensor: min, avg, max pressure (PSI, 2 dp)
- Per sensor: avg temperature (°C, 1 dp) if TempC column present
- Max speed (knots, 1 dp) if Speed_knots column has any non-zero values
- Total distance (nm, 2 dp) if Distance_nm > 0
- Sample count (row count)
- Session start time (first Timestamp value)

### Session identification
Display the session name derived from the filename:
- WingLog: strip `WingLog_` prefix and `_YYYY-MM-DD[_vN].csv` suffix → wing name
  (underscores back to spaces)
- WatchLog: strip `WatchLog_` prefix and `.csv` suffix → date/time string
- MultiLog: strip `MultiLog_` prefix and `_YYYY-MM-DD_HHmmssSSS.csv` suffix → test name

---

## Out of Scope for This Task

- Writing or modifying the existing FIT file path
- Any server-side processing — all parsing should be client-side
- Authentication or user accounts
- Storing uploaded files — parse in memory and discard

---

## Summary Checklist

- [ ] Extend drop zone to accept `.csv` in addition to `.fit` / `.zip`
- [ ] Detect format by filename prefix (`WingLog_`, `WatchLog_`, `MultiLog_`)
- [ ] Parse unified 7-column leading block
- [ ] Detect and parse sensor columns by suffix (LE/Strut) or `_GaugePSI`/`_TempC` pattern
- [ ] Handle legacy WingLog (17-col, hPa) and legacy MultiLog (3-col prefix) gracefully
- [ ] Render pressure vs. time chart with correct colours
- [ ] Render GPS map when coordinates present
- [ ] Show stats panel (min/avg/max pressure, avg temp, speed, distance, samples)
- [ ] Show session name derived from filename
- [ ] Leave FIT path unchanged
