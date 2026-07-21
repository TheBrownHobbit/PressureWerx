# CSV Export Button — Handoff for Claude Code

## File
`pressure_map_interactive_v05.html` (single-file app, all changes are in this one file)

## Goal
Add a button at the bottom of the visualization view that exports the loaded activity data as a CSV file download.

## Required CSV columns
| Column | Source | Notes |
|---|---|---|
| `index` | Row counter, 1-based | |
| `timestamp_utc` | `record.timestamp` | Convert from FIT epoch: `new Date((ts + FIT_EPOCH) * 1000).toISOString()` |
| `pressure_le_psi` | `record.pressure_le` | May be 0 for missing samples |
| `pressure_st_psi` | `record.pressure_st` | Only include column if `hasTwoSensors` is true |
| `lat` | `record.lat` | null when GPS not available for that sample |
| `lon` | `record.lon` | null when GPS not available for that sample |

## Changes (3 pieces)

### 1. Store raw records for later export
The `records` array is currently local to `handleFile()` (line ~1023). After `processRecords()` returns, stash the records so the export button can reach them.

**Where:** inside `handleFile`, after `processRecords(records)` is called (two places — the CSV branch ~line 1032 and the FIT branch ~line 1039), add:
```js
DATA._rawRecords = records;
```

Then inside `renderVisualization()` (~line 1082), store on the existing module-level `_vis` object:
```js
_vis.rawRecords = DATA._rawRecords;
_vis.hasTwoSensors = DATA.hasTwoSensors;
_vis.fileName = document.getElementById('metaFile').textContent;
```

### 2. Add button HTML
**Where:** after the closing `</div>` of `class="controls"` (~line 585), still inside the `<div class="container">`, add a new div at the bottom:

```html
<div style="padding:8px 10px; text-align:center;">
  <button id="exportCsv" type="button" style="display:none;">Export CSV</button>
</div>
```

The button starts hidden and is shown by `renderVisualization`. Style it to match the existing buttons (the existing button styles in the CSS will apply automatically since it's inside `#vis`).

### 3. Export logic
**Where:** inside `renderVisualization()`, after the existing button wiring (search for the `resetDefaults` / `resetData` / `resetTime` event listeners), add:

```js
// ── CSV export ──
const exportBtn = document.getElementById('exportCsv');
exportBtn.style.display = '';
exportBtn.onclick = () => {
  const recs = _vis.rawRecords;
  if (!recs || !recs.length) return;

  const has2 = _vis.hasTwoSensors;
  const hdr = ['index', 'timestamp_utc', 'pressure_le_psi'];
  if (has2) hdr.push('pressure_st_psi');
  hdr.push('lat', 'lon');

  const rows = [hdr.join(',')];
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    const ts = new Date((r.timestamp + FIT_EPOCH) * 1000).toISOString();
    const cols = [i + 1, ts, r.pressure_le ?? r.pressure_psi ?? ''];
    if (has2) cols.push(r.pressure_st ?? '');
    cols.push(r.lat ?? '', r.lon ?? '');
    rows.push(cols.join(','));
  }

  const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  // Derive filename from loaded file, swapping extension
  const base = (_vis.fileName || 'pressurewerx_export').replace(/\.(fit|zip|csv)$/i, '');
  a.download = base + '_export.csv';
  a.click();
  URL.revokeObjectURL(url);
};
```

## Key concepts (for learning context)
- **Blob + createObjectURL**: the standard browser-native pattern for client-side file downloads. Creates an in-memory URL pointing at the data — no server needed. `revokeObjectURL` frees the memory after the download starts.
- **FIT epoch**: FIT timestamps count seconds from 1989-12-31T00:00:00Z. Adding `FIT_EPOCH` (631065600) converts to Unix epoch seconds, then `* 1000` for JS milliseconds.

## What NOT to change
- Don't touch the FIT parser, processRecords, or any rendering logic.
- Don't add any external libraries — this is pure browser JS.
- The button placement is temporary (bottom of page); we'll move it later.
