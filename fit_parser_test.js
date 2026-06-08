'use strict';
const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------------------------------------------------------------------
// ZIP reader — extracts the first .fit file from a ZIP buffer
// Uses the central directory so sizes are correct even when the local header
// has zeros (general-purpose bit 3 = data-descriptor mode).
// ---------------------------------------------------------------------------
function unzipFirst(buf) {
  // Find End of Central Directory record (signature 0x06054b50), scanning
  // backwards from the end of the file.
  const EOCD_SIG = 0x06054b50;
  const CD_SIG   = 0x02014b50;
  const LF_SIG   = 0x04034b50;
  let eocdPos = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocdPos = i; break; }
  }
  if (eocdPos < 0) throw new Error('ZIP: no end-of-central-directory record');

  const cdOffset = buf.readUInt32LE(eocdPos + 16);
  let cdPos = cdOffset;

  while (cdPos + 46 < buf.length) {
    if (buf.readUInt32LE(cdPos) !== CD_SIG) break;
    const method    = buf.readUInt16LE(cdPos + 10);
    const cmpSize   = buf.readUInt32LE(cdPos + 20);
    const fnLen     = buf.readUInt16LE(cdPos + 28);
    const extraLen  = buf.readUInt16LE(cdPos + 30);
    const cmtLen    = buf.readUInt16LE(cdPos + 32);
    const lfOffset  = buf.readUInt32LE(cdPos + 42);
    const fname     = buf.slice(cdPos + 46, cdPos + 46 + fnLen).toString('utf8');
    cdPos += 46 + fnLen + extraLen + cmtLen;

    if (!fname.toLowerCase().endsWith('.fit')) continue;

    // Navigate to the local file header to find the actual data offset
    const lfFnLen    = buf.readUInt16LE(lfOffset + 26);
    const lfExtraLen = buf.readUInt16LE(lfOffset + 28);
    const dataStart  = lfOffset + 30 + lfFnLen + lfExtraLen;

    const compressed = buf.slice(dataStart, dataStart + cmpSize);
    if (method === 0) return compressed;             // stored
    if (method === 8) return zlib.inflateRawSync(compressed);
    throw new Error(`Unsupported ZIP compression method: ${method}`);
  }
  throw new Error('No .fit file found in ZIP');
}

// ---------------------------------------------------------------------------
// FIT binary parser
// ---------------------------------------------------------------------------
const SEMI = 180 / 2147483648;
const FIT_EPOCH = 631065600; // seconds between 1989-12-31 and 1970-01-01

// base type → {size, signed, float}
const BASE_TYPES = {
  0x00: { sz: 1 }, 0x01: { sz: 1, signed: true }, 0x02: { sz: 1 },
  0x83: { sz: 2, signed: true }, 0x84: { sz: 2 },
  0x85: { sz: 4, signed: true }, 0x86: { sz: 4 },
  0x88: { sz: 4, float: true },  0x89: { sz: 8, float: true },
  0x8a: { sz: 1 }, 0x8b: { sz: 2 }, 0x8c: { sz: 4 },
  0x07: { sz: 1 }, // string — actual count comes from field size
  0x8e: { sz: 8, signed: true }, 0x8f: { sz: 8 }, 0x90: { sz: 8 },
};

function readValue(buf, pos, baseType, size, bigEndian) {
  const be = bigEndian;
  const bt = BASE_TYPES[baseType] || { sz: size };
  if (bt.float) {
    return size === 4
      ? (be ? buf.readFloatBE(pos)  : buf.readFloatLE(pos))
      : (be ? buf.readDoubleBE(pos) : buf.readDoubleLE(pos));
  }
  if (size === 1) return bt.signed ? buf.readInt8(pos) : buf.readUInt8(pos);
  if (size === 2) return bt.signed
    ? (be ? buf.readInt16BE(pos)  : buf.readInt16LE(pos))
    : (be ? buf.readUInt16BE(pos) : buf.readUInt16LE(pos));
  if (size === 4) return bt.signed
    ? (be ? buf.readInt32BE(pos)  : buf.readInt32LE(pos))
    : (be ? buf.readUInt32BE(pos) : buf.readUInt32LE(pos));
  // string or multi-byte: return raw slice
  return buf.slice(pos, pos + size);
}

function parseFit(buf) {
  if (buf.slice(8, 12).toString('ascii') !== '.FIT')
    throw new Error('Not a FIT file');

  const headerSize = buf[0];
  const endOfData  = headerSize + buf.readUInt32LE(4); // exclusive

  const localDefs    = {};  // localType → def object
  const devFields    = {};  // devDataIndex → { fieldDefNum → {name,units,baseType,size} }
  let   lastTs       = 0;
  const records      = [];
  let   pos          = headerSize;

  while (pos < endOfData - 2) { // -2 for trailing CRC
    const hdr = buf[pos++];

    // ---- Compressed timestamp header (bit 7 set) ----
    if (hdr & 0x80) {
      const localType  = (hdr >> 5) & 0x03;
      const timeOffset = hdr & 0x1F;
      const candidate  = (lastTs & 0xFFFFFFE0) | timeOffset;
      lastTs = candidate >= lastTs ? candidate : candidate + 32;
      const def = localDefs[localType];
      if (!def) { /* skip */ continue; }
      const rec = readRecord(buf, pos, def, devFields, lastTs, true);
      pos += rec._bytes;
      if (def.globalNum === 20) { delete rec._bytes; records.push(rec); }
      continue;
    }

    const isDef     = (hdr >> 6) & 1;
    const hasDev    = isDef && !!((hdr >> 5) & 1);
    const localType = hdr & 0x0F;

    // ---- Definition message ----
    if (isDef) {
      pos++;                              // reserved
      const bigEndian = buf[pos++] === 1;
      const globalNum = bigEndian
        ? buf.readUInt16BE(pos) : buf.readUInt16LE(pos);
      pos += 2;
      const nFields = buf[pos++];
      const fields = [];
      for (let i = 0; i < nFields; i++) {
        fields.push({ defNum: buf[pos], size: buf[pos+1], baseType: buf[pos+2] });
        pos += 3;
      }
      const devFieldDefs = [];
      if (hasDev) {
        const nDev = buf[pos++];
        for (let i = 0; i < nDev; i++) {
          devFieldDefs.push({ defNum: buf[pos], size: buf[pos+1], devDataIdx: buf[pos+2] });
          pos += 3;
        }
      }
      localDefs[localType] = { globalNum, bigEndian, fields, devFieldDefs };
      continue;
    }

    // ---- Data message ----
    const def = localDefs[localType];
    if (!def) {
      // No definition — can't parse, skip 0 bytes (would stall). Log and abort.
      console.error(`No definition for local type ${localType} at pos ${pos}`);
      break;
    }

    const rec = readRecord(buf, pos, def, devFields, lastTs, false);
    pos += rec._bytes;

    if (def.globalNum === 207) {
      // developer_data_id — just need devDataIndex; handled implicitly
    } else if (def.globalNum === 206) {
      // field_description — map devDataIndex+fieldDefNum → field metadata
      handleFieldDescription(rec, devFields, def);
    } else if (def.globalNum === 20) {
      if (rec.timestamp != null) lastTs = rec.timestamp;
      delete rec._bytes;
      records.push(rec);
    } else {
      if (rec.timestamp != null) lastTs = rec.timestamp;
    }
  }

  return { records, devFields };
}

function readRecord(buf, pos, def, devFields, lastTs, fromCompressed) {
  const { bigEndian, fields, devFieldDefs, globalNum } = def;
  const be = bigEndian;
  const rec = { _bytes: 0 };
  let bytesRead = 0;

  for (const f of fields) {
    const val = readValue(buf, pos + bytesRead, f.baseType, f.size, be);
    bytesRead += f.size;

    if (globalNum === 20) {
      if (f.defNum === 253)      rec.timestamp    = val;
      else if (f.defNum === 0)   rec.raw_lat      = val;
      else if (f.defNum === 1)   rec.raw_lon      = val;
    } else if (globalNum === 206) {
      // Store raw field values keyed by defNum for handleFieldDescription
      rec[`f${f.defNum}`] = val;
    }
  }

  for (const df of (devFieldDefs || [])) {
    const val = readValue(buf, pos + bytesRead, 0x88 /* float32 default */, df.size, be);
    bytesRead += df.size;

    if (globalNum === 20) {
      const dfi = devFields[df.devDataIdx];
      if (dfi) {
        const meta = dfi[df.defNum];
        if (meta) {
          const name = meta.name;
          if (name === 'pressure_le' || name === 'pressure_st' ||
              name === 'pressure_ref' || name === 'pressure_psi') {
            rec[name] = val;
          }
        }
      }
    }
  }

  // Convert GPS
  if (rec.raw_lat != null) {
    const INV = 0x7FFFFFFF;
    rec.lat = (rec.raw_lat === INV || rec.raw_lat === -1) ? null : rec.raw_lat * SEMI;
    rec.lon = (rec.raw_lon === INV || rec.raw_lon === -1) ? null : rec.raw_lon * SEMI;
    delete rec.raw_lat; delete rec.raw_lon;
  }

  if (fromCompressed) rec.timestamp = lastTs;

  rec._bytes = bytesRead;
  return rec;
}

function handleFieldDescription(rec, devFields, def) {
  // f0=developer_data_index, f1=field_definition_number, f2=fit_base_type_id
  // f3=field_name (64-byte string Buffer), f4=units (16-byte string Buffer)
  const devIdx   = rec.f0;
  const fieldNum = rec.f1;
  const baseType = rec.f2;
  const nameRaw  = rec.f3;
  const unitsRaw = rec.f4;
  if (devIdx == null || fieldNum == null) return;

  const name  = nameRaw  instanceof Buffer ? nameRaw.toString('utf8').replace(/\0.*/, '')  : String(nameRaw  ?? '');
  const units = unitsRaw instanceof Buffer ? unitsRaw.toString('utf8').replace(/\0.*/, '') : String(unitsRaw ?? '');

  if (!devFields[devIdx]) devFields[devIdx] = {};
  // Compute size from baseType for dev field reads (always float32 for pressure = 4 bytes)
  const bt = BASE_TYPES[baseType] || { sz: 4 };
  devFields[devIdx][fieldNum] = { name, units, baseType, size: bt.sz };
}

// ---------------------------------------------------------------------------
// Validation report
// ---------------------------------------------------------------------------
function validate(records) {
  const n = records.length;
  if (n === 0) { console.log('No records parsed!'); return; }

  const first = records[0];
  const last  = records[n - 1];

  const t0 = first.timestamp;
  const t1 = last.timestamp;
  const duration = t1 - t0;

  const toDate = ts => new Date((ts + FIT_EPOCH) * 1000).toISOString();

  // Pressure stats
  function stats(key) {
    const vals = records.map(r => r[key]).filter(v => v != null && v > 0);
    if (!vals.length) return null;
    return {
      count: vals.length,
      min: Math.min(...vals),
      max: Math.max(...vals),
      mean: vals.reduce((a, b) => a + b, 0) / vals.length,
    };
  }

  const le  = stats('pressure_le');
  const st  = stats('pressure_st');
  const ref = stats('pressure_ref');

  const lats = records.map(r => r.lat).filter(v => v != null);
  const lons = records.map(r => r.lon).filter(v => v != null);
  const latMin = Math.min(...lats), latMax = Math.max(...lats);
  const lonMin = Math.min(...lons), lonMax = Math.max(...lons);

  console.log('\n=== FIT Parser Validation ===');
  console.log(`Records parsed:       ${n}`);
  console.log(`Start time (UTC):     ${toDate(t0)}`);
  console.log(`End time (UTC):       ${toDate(t1)}`);
  console.log(`Duration (computed):  ${duration} s   [expected: 7875.0]`);
  console.log('');

  function fmtStat(label, s, expMin, expMax) {
    if (!s) { console.log(`${label}  -- not present`); return; }
    console.log(`${label}  count: ${s.count}  min: ${s.min.toFixed(4)}  max: ${s.max.toFixed(4)}  mean: ${s.mean.toFixed(4)}  [expected min~${expMin}, max~${expMax}]`);
  }
  fmtStat('pressure_le ', le,  8.19, 9.23);
  fmtStat('pressure_st ', st,  '?',  '?');
  fmtStat('pressure_ref', ref, '~1013 hPa', '');
  console.log('');
  console.log(`GPS lat range:  [${latMin.toFixed(5)}, ${latMax.toFixed(5)}]   [expected near -36.85]`);
  console.log(`GPS lon range:  [${lonMin.toFixed(5)}, ${lonMax.toFixed(5)}]   [expected near 174.85]`);

  console.log('\n--- First 3 records ---');
  records.slice(0, 3).forEach((r, i) => {
    const ts = toDate(r.timestamp);
    console.log(`  [${i}] ${ts}  lat=${r.lat?.toFixed(6)}  lon=${r.lon?.toFixed(6)}  le=${r.pressure_le?.toFixed(4)}  st=${r.pressure_st?.toFixed(4)}`);
  });

  console.log('\n--- Last 3 records ---');
  records.slice(-3).forEach((r, i) => {
    const ts = toDate(r.timestamp);
    console.log(`  [${n - 3 + i}] ${ts}  lat=${r.lat?.toFixed(6)}  lon=${r.lon?.toFixed(6)}  le=${r.pressure_le?.toFixed(4)}  st=${r.pressure_st?.toFixed(4)}`);
  });

  // PASS/FAIL checks
  const checks = [
    ['duration within 1% of 7875.0',   Math.abs(duration - 7875) / 7875 < 0.01],
    ['pressure_le present',             le != null],
    ['pressure_le min in [8.0, 8.4]',   le && le.min >= 8.0 && le.min <= 8.4],
    ['pressure_le max in [9.0, 9.5]',   le && le.max >= 9.0 && le.max <= 9.5],
    ['GPS lat in [-37, -36]',           latMin >= -37 && latMax <= -36],
    ['GPS lon in [174, 175]',           lonMin >= 174 && lonMax <= 175],
    ['record count > 7000',             n > 7000],
  ];

  console.log('\nPASS / FAIL checks:');
  let allPass = true;
  for (const [label, result] of checks) {
    const tag = result ? '[PASS]' : '[FAIL]';
    if (!result) allPass = false;
    console.log(`  ${tag} ${label}`);
  }
  console.log(allPass ? '\nAll checks passed.' : '\nSome checks FAILED.');
}

// ---------------------------------------------------------------------------
// loadFit — accepts either a ZIP or a bare .fit file path
// ---------------------------------------------------------------------------
function loadFit(filepath) {
  const buf = fs.readFileSync(filepath);
  if (buf[0] === 0x50 && buf[1] === 0x4B) return unzipFirst(buf);   // ZIP magic PK
  if (buf.slice(8, 12).toString('ascii') !== '.FIT')
    throw new Error(`Not a valid FIT or ZIP file: ${filepath}`);
  return buf;
}

// ---------------------------------------------------------------------------
// Processing pipeline
// ---------------------------------------------------------------------------

// Savitzky-Golay coefficients: window=21, polyorder=3
// Formula: h[k] = 3*(3m²+3m-1-5k²) / ((2m-1)(2m+1)(2m+3)),  m=10
const SG_COEFFS = (() => {
  const m = 10, denom = (2*m-1) * (2*m+1) * (2*m+3);
  return Array.from({ length: 21 }, (_, i) => {
    const k = i - m;
    return 3 * (3*m*m + 3*m - 1 - 5*k*k) / denom;
  });
})();

// Identify which channels have real data (not all-zero).
function detectChannels(records) {
  const channels = {};
  for (const key of ['pressure_le', 'pressure_st', 'pressure_psi']) {
    const vals = records.map(r => r[key] ?? 0);
    if (vals.some(v => v !== 0)) channels[key] = vals;
  }
  return channels;
}

// Linear interpolation for isolated zero samples within a channel.
function fillZeros(arr) {
  const out = arr.slice();
  let i = 0;
  while (i < out.length) {
    if (out[i] !== 0) { i++; continue; }
    let j = i;
    while (j < out.length && out[j] === 0) j++;
    const left = i - 1, right = j;
    for (let k = i; k < j; k++) {
      if      (left  <  0)              out[k] = out[right];
      else if (right >= out.length)     out[k] = out[left];
      else out[k] = out[left] + (out[right] - out[left]) * (k - left) / (right - left);
    }
    i = j;
  }
  return out;
}

// Savitzky-Golay smoothing with nearest-edge padding.
function savgolSmooth(arr) {
  const m = 10, n = arr.length;
  const pad = new Float64Array(n + 2*m);
  for (let i = 0; i < m; i++)         pad[i]     = arr[0];
  for (let i = 0; i < n; i++)         pad[i + m] = arr[i];
  for (let i = 0; i < m; i++)         pad[n+m+i] = arr[n-1];
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < 21; j++) s += SG_COEFFS[j] * pad[i + j];
    out[i] = s;
  }
  return out;
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2
          + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Build segment array and compute per-segment timing.
// Filter to GPS-valid records first, then decimate — this matches the Python
// pipeline which only ever touches GPS-present records before applying DECIM.
function buildSegments(records, smoothed, tStart) {
  const DECIM = 2;
  const segments = [], segSeconds = [];

  // Pair each record with its smoothed pressure (by original index), then drop null-GPS.
  const gps = records
    .map((r, i) => ({ r, p: smoothed[i] }))
    .filter(({ r }) => r.lat != null);

  for (let i = 0; i + DECIM < gps.length; i += DECIM) {
    const a = gps[i], b = gps[i + DECIM];
    segments.push([
      +a.r.lat.toFixed(6), +a.r.lon.toFixed(6),
      +b.r.lat.toFixed(6), +b.r.lon.toFixed(6),
      +a.p.toFixed(4),
    ]);
    segSeconds.push(a.r.timestamp - tStart);
  }
  return { segments, segSeconds };
}

function percentile(sorted, p) {
  return sorted[Math.max(0, Math.floor(sorted.length * p) - 1)];
}

// Full pipeline: parse output → DATA object matching v04 payload structure.
function processRecords(records) {
  const channels = detectChannels(records);
  if (!Object.keys(channels).length) throw new Error('No pressure channels present');

  const primaryKey  = 'pressure_le' in channels ? 'pressure_le'
                    : 'pressure_st' in channels ? 'pressure_st'
                    : 'pressure_psi';
  const rawPressure = channels[primaryKey];
  const filled      = fillZeros(rawPressure);
  const smoothed    = savgolSmooth(filled);

  const tStart = records[0].timestamp;
  const tEnd   = records[records.length - 1].timestamp;

  const { segments, segSeconds } = buildSegments(records, smoothed, tStart);

  // Statistics from smoothed data (only values from present-channel records)
  const validIdx      = rawPressure.map((v, i) => v !== 0 ? i : -1).filter(i => i >= 0);
  const validSmoothed = validIdx.map(i => smoothed[i]);
  const sortedP       = validSmoothed.slice().sort((a, b) => a - b);
  const data_min      = sortedP[0];
  const data_max      = sortedP[sortedP.length - 1];
  const default_min   = percentile(sortedP, 0.10);
  const default_max   = percentile(sortedP, 0.90);
  const mean_pressure = validSmoothed.reduce((a, b) => a + b, 0) / validSmoothed.length;

  // GPS stats
  const withGps = records.filter(r => r.lat != null);
  if (withGps.length === 0)
    throw new Error('No GPS data found in file — cannot build map track');
  const lats    = withGps.map(r => r.lat);
  const lons    = withGps.map(r => r.lon);
  const latMin  = Math.min(...lats), latMax = Math.max(...lats);
  const lonMin  = Math.min(...lons), lonMax = Math.max(...lons);

  let totalDist = 0;
  for (let i = 1; i < withGps.length; i++)
    totalDist += haversine(withGps[i-1].lat, withGps[i-1].lon, withGps[i].lat, withGps[i].lon);

  const meanLat = lats.reduce((a, b) => a + b, 0) / lats.length;
  const meanLon = lons.reduce((a, b) => a + b, 0) / lons.length;

  const toHMS = ts => new Date((ts + FIT_EPOCH) * 1000).toISOString().slice(11, 19);

  return {
    segments,
    seg_seconds:   segSeconds,
    duration_s:    tEnd - tStart,
    t_start_str:   toHMS(tStart),
    t_end_str:     toHMS(tEnd),
    data_min,
    data_max,
    default_min,
    default_max,
    mean_pressure,
    total_dist_km: totalDist / 1000,
    center:  [meanLat, meanLon],
    bbox:    [[latMin, lonMin], [latMax, lonMax]],
    start:   [withGps[0].lat, withGps[0].lon],
    end:     [withGps[withGps.length - 1].lat, withGps[withGps.length - 1].lon],
    primaryKey,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const zipPath = path.join(__dirname, 'examples', '23157999972.zip');
console.log(`Reading ${zipPath}...`);
const zipBuf = fs.readFileSync(zipPath);

console.log('Extracting FIT file from ZIP...');
const fitBuf = unzipFirst(zipBuf);
console.log(`FIT file size: ${fitBuf.length} bytes`);

console.log('Parsing FIT binary...');
const { records, devFields } = parseFit(fitBuf);

console.log('\nDeveloper fields discovered:');
for (const [idx, fields] of Object.entries(devFields)) {
  for (const [fnum, meta] of Object.entries(fields)) {
    console.log(`  devDataIdx=${idx}  fieldDefNum=${fnum}  name="${meta.name}"  units="${meta.units}"  baseType=0x${meta.baseType.toString(16)}`);
  }
}

validate(records);

// ---------------------------------------------------------------------------
// Pipeline validation
// ---------------------------------------------------------------------------
console.log('\nRunning processing pipeline...');
const DATA = processRecords(records);

// Ground truth from v04 embedded DATA
const V04 = {
  data_min:    8.193475669955507,
  data_max:    9.22964712403576,
  default_min: 8.289107679938725,
  default_max: 8.737256693613887,
  duration_s:  7875.0,
  seg0:        [-36.850077, 174.844823, -36.850072, 174.844824, 9.2245],
};

console.log('\n=== Pipeline Output ===');
console.log(`Primary channel:    ${DATA.primaryKey}`);
console.log(`Segments:           ${DATA.segments.length}`);
console.log(`Duration:           ${DATA.duration_s} s          [v04: ${V04.duration_s}]`);
console.log(`Start / End:        ${DATA.t_start_str} / ${DATA.t_end_str}`);
console.log(`data_min:           ${DATA.data_min.toFixed(6)}   [v04: ${V04.data_min.toFixed(6)}]`);
console.log(`data_max:           ${DATA.data_max.toFixed(6)}   [v04: ${V04.data_max.toFixed(6)}]`);
console.log(`default_min (p10):  ${DATA.default_min.toFixed(6)}   [v04: ${V04.default_min.toFixed(6)}]`);
console.log(`default_max (p90):  ${DATA.default_max.toFixed(6)}   [v04: ${V04.default_max.toFixed(6)}]`);
console.log(`Mean pressure:      ${DATA.mean_pressure.toFixed(4)} PSI`);
console.log(`Total distance:     ${DATA.total_dist_km.toFixed(2)} km`);
console.log(`Center:             [${DATA.center[0].toFixed(5)}, ${DATA.center[1].toFixed(5)}]`);

console.log('\nFirst 3 segments:');
DATA.segments.slice(0, 3).forEach((s, i) =>
  console.log(`  [${i}] ${JSON.stringify(s)}`));
console.log('Last 3 segments:');
DATA.segments.slice(-3).forEach((s, i) =>
  console.log(`  [${DATA.segments.length - 3 + i}] ${JSON.stringify(s)}`));

const close = (a, b, tol = 0.02) => Math.abs(a - b) <= tol;

const pipeChecks = [
  ['segment count in [3700, 3900]',         DATA.segments.length >= 3700 && DATA.segments.length <= 3900],
  ['duration within 2s of v04',             Math.abs(DATA.duration_s - V04.duration_s) <= 2],
  ['data_min within 0.02 of v04',           close(DATA.data_min,    V04.data_min)],
  ['data_max within 0.02 of v04',           close(DATA.data_max,    V04.data_max)],
  ['default_min (p10) within 0.02 of v04',  close(DATA.default_min, V04.default_min)],
  ['default_max (p90) within 0.02 of v04',  close(DATA.default_max, V04.default_max)],
  ['first segment lat1 matches v04',        DATA.segments[0][0] === V04.seg0[0]],
  ['first segment lon1 matches v04',        DATA.segments[0][1] === V04.seg0[1]],
  ['first segment lat2 matches v04',        DATA.segments[0][2] === V04.seg0[2]],
  ['first segment lon2 matches v04',        DATA.segments[0][3] === V04.seg0[3]],
];

console.log('\nPipeline PASS / FAIL:');
let pipePass = true;
for (const [label, result] of pipeChecks) {
  if (!result) pipePass = false;
  console.log(`  ${result ? '[PASS]' : '[FAIL]'} ${label}`);
}
console.log(pipePass ? '\nAll pipeline checks passed.' : '\nSome pipeline checks FAILED.');

// ---------------------------------------------------------------------------
// Step 6: segment-by-segment comparison against v04 embedded DATA
// ---------------------------------------------------------------------------
console.log('\n=== Step 6: v04 Segment Comparison ===');

const v04Html = fs.readFileSync(path.join(__dirname, 'pressure_map_interactive_v04.html'), 'utf8');
const v04DataLine = v04Html.split('\n').find(l => l.startsWith('const DATA = '));
const V04D = JSON.parse(v04DataLine.slice('const DATA = '.length).replace(/;$/, ''));

console.log(`\nSegment counts: mine=${DATA.segments.length}  v04=${V04D.segments.length}  diff=${DATA.segments.length - V04D.segments.length}`);

// Sequential alignment: walk both arrays together, tracking an offset when
// GPS diverges. This handles the small count difference without a full search.
let mi = 0, vi = 0, offset = 0;
const gpsMismatches = [];
const pressureDiffs = [];
const worstPressure = [];  // top mismatches for inspection

while (mi < DATA.segments.length && vi < V04D.segments.length) {
  const ms = DATA.segments[mi], vs = V04D.segments[vi];

  // Check GPS match (4 coordinates, already rounded to 6dp in both)
  const gpsMatch = ms[0] === vs[0] && ms[1] === vs[1] && ms[2] === vs[2] && ms[3] === vs[3];

  if (!gpsMatch) {
    // Try skipping one ahead in v04 (v04 has an extra segment here)
    const next = V04D.segments[vi + 1];
    if (next && ms[0] === next[0] && ms[1] === next[1] && ms[2] === next[2] && ms[3] === next[3]) {
      gpsMismatches.push({ mi, vi, type: 'v04_extra', seg: vs });
      vi++;  // skip the extra v04 segment
      offset++;
      continue;
    }
    gpsMismatches.push({ mi, vi, type: 'gps_mismatch', mine: ms.slice(0,4), v04: vs.slice(0,4) });
    mi++; vi++;
    continue;
  }

  const pdiff = Math.abs(ms[4] - vs[4]);
  pressureDiffs.push(pdiff);
  if (pdiff > 0.005) worstPressure.push({ mi, vi, mine: ms[4], v04: vs[4], diff: pdiff });

  mi++; vi++;
}

// Sort worst cases by diff descending
worstPressure.sort((a, b) => b.diff - a.diff);

console.log(`\nGPS alignment:`);
console.log(`  Aligned (GPS exact match): ${pressureDiffs.length}`);
console.log(`  GPS mismatches / skips:    ${gpsMismatches.length}`);
if (gpsMismatches.length > 0) {
  gpsMismatches.slice(0, 5).forEach(m =>
    console.log(`    mi=${m.mi} vi=${m.vi} type=${m.type}${m.type==='v04_extra'?` extra=[${m.seg.slice(0,4)}]`:` mine=[${m.mine}] v04=[${m.v04}]`}`));
}

const sortedPD = pressureDiffs.slice().sort((a, b) => a - b);
const pct = p => sortedPD[Math.floor(sortedPD.length * p)] ?? 0;
console.log(`\nPressure diff distribution (PSI) across ${pressureDiffs.length} aligned segments:`);
console.log(`  median:  ${pct(0.50).toFixed(4)}`);
console.log(`  p90:     ${pct(0.90).toFixed(4)}`);
console.log(`  p95:     ${pct(0.95).toFixed(4)}`);
console.log(`  p99:     ${pct(0.99).toFixed(4)}`);
console.log(`  max:     ${sortedPD[sortedPD.length-1].toFixed(4)}`);
console.log(`  within 0.001 PSI: ${pressureDiffs.filter(d=>d<=0.001).length} (${(pressureDiffs.filter(d=>d<=0.001).length/pressureDiffs.length*100).toFixed(1)}%)`);
console.log(`  within 0.01 PSI:  ${pressureDiffs.filter(d=>d<=0.01).length}  (${(pressureDiffs.filter(d=>d<=0.01).length/pressureDiffs.length*100).toFixed(1)}%)`);

if (worstPressure.length > 0) {
  console.log(`\nTop 5 worst pressure mismatches:`);
  worstPressure.slice(0, 5).forEach(w =>
    console.log(`  seg ${w.mi}: mine=${w.mine} v04=${w.v04} diff=${w.diff.toFixed(4)}`));
}

// Metadata comparison
console.log('\nMetadata comparison:');
const metaCmp = [
  ['duration_s',   DATA.duration_s,   V04D.duration_s,   2],
  ['data_min',     DATA.data_min,     V04D.data_min,     0.001],
  ['data_max',     DATA.data_max,     V04D.data_max,     0.02],
  ['default_min',  DATA.default_min,  V04D.default_min,  0.005],
  ['default_max',  DATA.default_max,  V04D.default_max,  0.005],
  ['center[0]',    DATA.center[0],    V04D.center[0],    0.001],
  ['center[1]',    DATA.center[1],    V04D.center[1],    0.001],
  ['bbox[0][0]',   DATA.bbox[0][0],   V04D.bbox[0][0],   1e-5],
  ['bbox[0][1]',   DATA.bbox[0][1],   V04D.bbox[0][1],   1e-5],
  ['bbox[1][0]',   DATA.bbox[1][0],   V04D.bbox[1][0],   1e-5],
  ['bbox[1][1]',   DATA.bbox[1][1],   V04D.bbox[1][1],   1e-5],
];
let metaAllOk = true;
for (const [key, mine, v04val, tol] of metaCmp) {
  const diff = Math.abs(mine - v04val);
  const ok = diff <= tol;
  if (!ok) metaAllOk = false;
  console.log(`  ${ok?'[OK]  ':'[DIFF]'} ${key.padEnd(12)} mine=${mine.toFixed(8)}  v04=${v04val.toFixed(8)}  diff=${diff.toFixed(8)}`);
}

// Final verdict
const gpsOk       = gpsMismatches.filter(m => m.type === 'gps_mismatch').length === 0;
const pressureOk  = pct(0.99) <= 0.05;   // 99th percentile within 0.05 PSI
const segCountOk  = Math.abs(DATA.segments.length - V04D.segments.length) <= 4;

console.log('\n=== Step 6 Verdict ===');
console.log(`  ${segCountOk   ?'[OK]':'[FAIL]'} Segment count within 4 of v04 (diff=${DATA.segments.length - V04D.segments.length})`);
console.log(`  ${gpsOk        ?'[OK]':'[FAIL]'} No unexplained GPS mismatches`);
console.log(`  ${pressureOk   ?'[OK]':'[FAIL]'} Pressure p99 diff ≤ 0.05 PSI (actual: ${pct(0.99).toFixed(4)})`);
console.log(`  ${metaAllOk    ?'[OK]':'[FAIL]'} All metadata within tolerance`);
const allOk = segCountOk && gpsOk && pressureOk && metaAllOk;
console.log(allOk ? '\nStep 6 PASSED — pipeline output matches v04.' : '\nStep 6 FAILED — see diffs above.');

// ---------------------------------------------------------------------------
// Legacy-format validation: 22483130534.zip (single pressure_psi field)
// ---------------------------------------------------------------------------
console.log('\n=== Legacy format: 22483130534.zip ===');
const zip2Path = path.join(__dirname, 'examples', '22483130534.zip');
const zip2Buf  = fs.readFileSync(zip2Path);
const fit2Buf  = unzipFirst(zip2Buf);
console.log(`FIT file size: ${fit2Buf.length} bytes`);

const { records: rec2, devFields: dev2 } = parseFit(fit2Buf);

console.log('\nDeveloper fields:');
for (const [idx, fields] of Object.entries(dev2)) {
  for (const [fnum, meta] of Object.entries(fields)) {
    console.log(`  devDataIdx=${idx}  fieldDefNum=${fnum}  name="${meta.name}"  baseType=0x${meta.baseType.toString(16)}`);
  }
}

const ch2 = detectChannels(rec2);
console.log('\nChannels detected:', Object.keys(ch2).join(', ') || '(none)');

const legacyChecks = [];
legacyChecks.push(['records parsed > 0',                rec2.length > 0]);
legacyChecks.push(['pressure_psi channel present',      'pressure_psi' in ch2]);
legacyChecks.push(['pressure_psi not all-zero',         ch2.pressure_psi?.some(v => v !== 0) ?? false]);
legacyChecks.push(['pressure_le NOT present (old fmt)', !('pressure_le' in ch2)]);

let DATA2;
try {
  DATA2 = processRecords(rec2);
  legacyChecks.push(['pipeline runs without error',     true]);
  legacyChecks.push(['segments produced > 0',           DATA2.segments.length > 0]);
  legacyChecks.push(['primaryKey is pressure_psi',      DATA2.primaryKey === 'pressure_psi']);
  const lats2 = rec2.filter(r => r.lat != null).map(r => r.lat);
  const latOk = lats2.length > 0 && lats2.every(la => la > -90 && la < 90);
  legacyChecks.push(['GPS coordinates plausible',       latOk]);

  console.log(`\nPipeline output:`);
  console.log(`  primary channel:  ${DATA2.primaryKey}`);
  console.log(`  segments:         ${DATA2.segments.length}`);
  console.log(`  duration:         ${DATA2.duration_s} s`);
  console.log(`  data_min/max:     ${DATA2.data_min.toFixed(4)} / ${DATA2.data_max.toFixed(4)} PSI`);
  console.log(`  center:           [${DATA2.center[0].toFixed(5)}, ${DATA2.center[1].toFixed(5)}]`);
  console.log(`  first segment:    ${JSON.stringify(DATA2.segments[0])}`);
} catch (err) {
  legacyChecks.push(['pipeline runs without error', false]);
  console.error('Pipeline error:', err.message);
}

console.log('\nLegacy format checks:');
let legacyAllPass = true;
for (const [label, result] of legacyChecks) {
  if (!result) legacyAllPass = false;
  console.log(`  ${result ? '[PASS]' : '[FAIL]'} ${label}`);
}
console.log(legacyAllPass ? '\nLegacy format: all checks passed.' : '\nLegacy format: SOME CHECKS FAILED.');

// ---------------------------------------------------------------------------
// Third file: 22966719708_ACTIVITY.fit (bare .fit, diagnosis run)
// ---------------------------------------------------------------------------
console.log('\n=== Third file: 22966719708_ACTIVITY.fit ===');
const fit3Path = path.join(__dirname, 'examples', '22966719708_ACTIVITY.fit');
const fit3Buf  = loadFit(fit3Path);
console.log(`FIT file size: ${fit3Buf.length} bytes`);

const { records: rec3, devFields: dev3 } = parseFit(fit3Buf);
console.log(`Records parsed: ${rec3.length}`);

console.log('\nDeveloper fields:');
for (const [idx, fields] of Object.entries(dev3)) {
  for (const [fnum, meta] of Object.entries(fields)) {
    console.log(`  devDataIdx=${idx}  fieldDefNum=${fnum}  name="${meta.name}"  baseType=0x${meta.baseType.toString(16)}`);
  }
}

const ch3     = detectChannels(rec3);
const withGps3 = rec3.filter(r => r.lat != null);
console.log('\nChannels detected:', Object.keys(ch3).join(', ') || '(none)');
console.log(`Records with valid GPS: ${withGps3.length} / ${rec3.length}`);

// Sample pressure values to confirm they are non-zero
const psiSample = rec3.slice(0, 10).map(r => r.pressure_psi?.toFixed(4) ?? 'undef');
console.log('pressure_psi sample (first 10):', psiSample.join(', '));

// Attempt pipeline
const diag3 = [];
diag3.push(['records parsed > 0',            rec3.length > 0]);
diag3.push(['pressure_psi channel present',  'pressure_psi' in ch3]);
diag3.push(['pressure_psi not all-zero',      ch3.pressure_psi?.some(v => v !== 0) ?? false]);
diag3.push(['GPS records present',           withGps3.length > 0]);

let DATA3;
try {
  DATA3 = processRecords(rec3);
  diag3.push(['pipeline runs without error', true]);
  diag3.push(['segments produced > 0',       DATA3.segments.length > 0]);
  console.log('\nPipeline output:');
  console.log(`  primary channel: ${DATA3.primaryKey}`);
  console.log(`  segments:        ${DATA3.segments.length}`);
  console.log(`  duration:        ${DATA3.duration_s} s`);
  console.log(`  data_min/max:    ${DATA3.data_min?.toFixed(4)} / ${DATA3.data_max?.toFixed(4)} PSI`);
  console.log(`  center:          [${DATA3.center[0]?.toFixed(5)}, ${DATA3.center[1]?.toFixed(5)}]`);
} catch (err) {
  diag3.push(['pipeline runs without error', false]);
  console.log('\nPipeline ERROR:', err.message);
}

console.log('\nDiagnostic checks:');
let diag3AllPass = true;
for (const [label, result] of diag3) {
  if (!result) diag3AllPass = false;
  console.log(`  ${result ? '[PASS]' : '[FAIL]'} ${label}`);
}
console.log(diag3AllPass ? '\nThird file: all checks passed.' : '\nThird file: root cause identified above.');
