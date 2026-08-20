/**
 * Agilent ChemStation binary parser (pure JS, browser + node).
 *
 * Written from the published format descriptions in the rainbow documentation:
 *   - https://rainbow-api.readthedocs.io/en/latest/agilent/ch_other.html  (.ch, UV/CAD/ELSD: versions 30/130)
 *   - https://rainbow-api.readthedocs.io/en/latest/agilent/ch_fid.html    (.ch, FID-style double body: versions 179/181)
 *   - https://rainbow-api.readthedocs.io/en/latest/agilent/uv.html        (.uv, DAD spectra: versions 31/131)
 *   - https://rainbow-api.readthedocs.io/en/latest/agilent.html           (format/detector index)
 *
 * No code from the rainbow project (LGPL-3.0) was copied or ported. The pages
 * above document header offsets, endianness, the delta-encoded integer body and
 * the scaling factor; everything below is an independent implementation of that
 * written description.
 *
 * Offsets the docs do not cover were measured directly from sample files and are
 * marked "measured" in comments:
 *   - legacy versions 30/31 use a short header (0x400 / 0x200) with 1-byte-per-char
 *     strings instead of the 0x1800 / 0x1000 UTF-16 header of 130/131.
 *   - .uv keeps its scaling factor at 0xC0D (immediately before the units string
 *     at 0xC15 named in the docs), not at 0x127C which lies inside the data body.
 *   - OpenLab-written .uv files use segment label 70 with a float64 body instead of
 *     the label-67 delta-encoded body.
 */

const MS_PER_MIN = 60000;

/* ------------------------------------------------------------------ *
 * Low level readers
 * ------------------------------------------------------------------ */

/** Pascal string: 1 length byte, then `len` single-byte characters. */
function readStringAscii(dv, offset) {
  if (offset + 1 > dv.byteLength) return '';
  const len = dv.getUint8(offset);
  if (len === 0 || offset + 1 + len > dv.byteLength) return '';
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint8(offset + 1 + i));
  return s.trim();
}

/** Pascal string: 1 length byte, then `len` UTF-16LE characters (docs: "h\0e\0l\0l\0o\0"). */
function readStringUtf16(dv, offset) {
  if (offset + 1 > dv.byteLength) return '';
  const len = dv.getUint8(offset);
  if (len === 0 || offset + 1 + len * 2 > dv.byteLength) return '';
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint16(offset + 1 + i * 2, true));
  return s.trim();
}

function safeF64BE(dv, offset) {
  return offset + 8 <= dv.byteLength ? dv.getFloat64(offset, false) : 0;
}

/* ------------------------------------------------------------------ *
 * Layout tables
 * ------------------------------------------------------------------ */

// Versions written by legacy ChemStation: compact header, 1-byte chars.
// String offsets measured from sample files (brown.D/dad1A.ch, brown.D/dad1.uv).
const LEGACY_CH = {
  headerEnd: 0x400,
  str: readStringAscii,
  scale: 0x284,
  strings: {
    fileTypeName: 0x004,
    notebook: 0x094,
    date: 0x0b2,
    model: 0x0d0,
    instrument: 0x0da,
    method: 0x0e4,
    software: 0x142,
    unit: 0x244,
    signal: 0x254,
  },
};

const LEGACY_UV = {
  headerEnd: 0x200,
  str: readStringAscii,
  scale: 0x13e,
  strings: {
    fileTypeName: 0x004,
    notebook: 0x094,
    date: 0x0b2,
    model: 0x0d0,
    instrument: 0x0da,
    method: 0x0e4,
    unit: 0x146,
  },
};

// Versions written by newer ChemStation / OpenLab: 0x1800 (.ch) or 0x1000 (.uv)
// header, UTF-16 strings. Offsets from the rainbow format docs.
const MODERN_CH = {
  headerEnd: 0x1800,
  str: readStringUtf16,
  scale: 0x127c,
  strings: {
    fileTypeName: 0x15b,
    notebook: 0x35a,
    parentDir: 0x758,
    date: 0x957,
    model: 0x9bc,
    instrument: 0x9e5,
    method: 0xa0e,
    software: 0xc11,
    unit: 0x104c,
    signal: 0x1075,
  },
};

const MODERN_UV = {
  headerEnd: 0x1000,
  str: readStringUtf16,
  scale: 0xc0d, // measured; sits directly before the units string at 0xC15
  strings: {
    fileTypeName: 0x15b,
    notebook: 0x35a,
    parentDir: 0x758,
    date: 0x957,
    model: 0x9bc,
    instrument: 0x9e5,
    method: 0xa0e,
    unit: 0xc15,
    description: 0xc40,
    vialpos: 0xfd7,
  },
};

/** .ch versions whose data body is little-endian float64 rather than delta ints. */
const DOUBLE_BODY_CH = new Set(['179', '181']);
const DELTA_BODY_CH = new Set(['30', '130']);
const UV_VERSIONS = new Set(['31', '131']);

/* ------------------------------------------------------------------ *
 * Body decoders
 * ------------------------------------------------------------------ */

/**
 * Delta-encoded integer stream used by .ch (label 16 segments) and .uv
 * (values inside one retention-time segment).
 *
 * Per the docs: a signed short of -0x8000 escapes to a signed 32-bit absolute
 * value in the next 4 bytes; any other short is a delta accumulated onto the
 * running value.
 */
function readDeltaValues(dv, start, count, littleEndian, out, outStart, running) {
  let pos = start;
  let acc = running;
  for (let i = 0; i < count; i++) {
    const s = dv.getInt16(pos, littleEndian);
    pos += 2;
    if (s === -0x8000) {
      acc = dv.getInt32(pos, littleEndian);
      pos += 4;
    } else {
      acc += s;
    }
    out[outStart + i] = acc;
  }
  return { pos, acc };
}

/**
 * .ch data body: a run of segments, each "16, count" followed by `count`
 * big-endian delta-encoded values. The file ends with two null bytes, so a
 * segment label that is not 16 terminates the stream.
 */
function decodeChSegments(dv, start) {
  const values = [];
  let pos = start;
  let acc = 0;
  const scratch = [];
  while (pos + 2 <= dv.byteLength) {
    const label = dv.getUint8(pos);
    const count = dv.getUint8(pos + 1);
    if (label !== 16 || count === 0) break;
    pos += 2;
    // A full segment needs at most count*6 bytes; bail out if truncated.
    if (pos + count * 2 > dv.byteLength) break;
    scratch.length = count;
    const res = readDeltaValues(dv, pos, count, false, scratch, 0, acc);
    pos = res.pos;
    acc = res.acc;
    for (let i = 0; i < count; i++) values.push(scratch[i]);
  }
  return values;
}

/* ------------------------------------------------------------------ *
 * Format parsers
 * ------------------------------------------------------------------ */

function detectorFor(version, filename, signal) {
  const name = (filename || '').toUpperCase();
  if (name.includes('FID')) return 'FID';
  if (DOUBLE_BODY_CH.has(version) && !name.includes('DAD') && !name.includes('MWD')) return 'FID';
  if (name.includes('DAD') || name.includes('MWD') || name.includes('VWD')) return 'UV';
  if (name.includes('ADC') || name.includes('ELS')) return 'ELSD';
  if (/\d{3}/.test(signal || '')) return 'UV';
  return 'Signal';
}

/** Pull the monitored wavelength out of a ChemStation signal description. */
function wavelengthFromSignal(signal) {
  if (!signal) return null;
  const m = /Sig\s*=\s*(\d+(?:\.\d+)?)/i.exec(signal);
  return m ? m[1] : null;
}

function readMetadata(dv, layout, version) {
  const meta = { vendor: 'Agilent', version };
  for (const [key, off] of Object.entries(layout.strings)) {
    const v = layout.str(dv, off);
    if (v) meta[key] = v;
  }
  return meta;
}

function parseCh(dv, version, filename) {
  const layout = DOUBLE_BODY_CH.has(version) ? MODERN_CH
    : version === '130' ? MODERN_CH
      : LEGACY_CH;
  const meta = readMetadata(dv, layout, version);
  const scale = safeF64BE(dv, layout.scale) || 1;

  let values;
  let startMs;
  let endMs;

  if (DOUBLE_BODY_CH.has(version)) {
    // ch_fid.html: 0x116 value count (uint32 BE), 0x11A/0x11E first and last
    // retention time in ms (float32 BE), body = little-endian float64 values.
    // The stored count is unreliable in some OpenLab files, so derive it from
    // the body length and only fall back to the header field.
    const bodyBytes = dv.byteLength - layout.headerEnd;
    const derived = Math.floor(bodyBytes / 8);
    const stated = dv.getUint32(0x116, false);
    const count = derived > 0 ? derived : stated;
    startMs = dv.getFloat32(0x11a, false);
    endMs = dv.getFloat32(0x11e, false);
    values = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      values[i] = dv.getFloat64(layout.headerEnd + i * 8, true) * scale;
    }
  } else {
    // ch_other.html: 0x11A/0x11E first and last retention time in ms
    // (uint32 BE), body = delta-encoded big-endian integers in "16, count"
    // segments.
    startMs = dv.getUint32(0x11a, false);
    endMs = dv.getUint32(0x11e, false);
    // Retention times can be negative (pre-injection baseline), so read them
    // as signed when the unsigned value looks like a wrapped negative.
    if (startMs > 0x7fffffff) startMs = dv.getInt32(0x11a, false);
    if (endMs > 0x7fffffff) endMs = dv.getInt32(0x11e, false);
    const raw = decodeChSegments(dv, layout.headerEnd);
    values = new Float64Array(raw.length);
    for (let i = 0; i < raw.length; i++) values[i] = raw[i] * scale;
  }

  const n = values.length;
  const times = new Float64Array(n);
  const step = n > 1 ? (endMs - startMs) / (n - 1) : 0;
  for (let i = 0; i < n; i++) times[i] = (startMs + i * step) / MS_PER_MIN;

  const detector = detectorFor(version, filename, meta.signal);
  const wl = detector === 'UV' && !DOUBLE_BODY_CH.has(version)
    ? wavelengthFromSignal(meta.signal)
    : null;

  const signals = new Array(n);
  for (let i = 0; i < n; i++) signals[i] = [values[i]];

  return {
    format: 'Agilent .ch',
    version,
    detector,
    xlabel: 'Time (min)',
    ylabel: meta.unit || 'Intensity',
    ylabels: [wl !== null ? Number(wl) : (meta.signal || filename || 'Signal')],
    times: Array.from(times),
    signals,
    metadata: meta,
  };
}

function parseUv(dv, version, filename) {
  const layout = version === '31' ? LEGACY_UV : MODERN_UV;
  const meta = readMetadata(dv, layout, version);
  const scale = safeF64BE(dv, layout.scale) || 1;
  // uv.html: 0x116 holds the number of x-axis labels (uint32 BE).
  const nTimes = dv.getUint32(0x116, false);

  const times = new Float64Array(nTimes);
  const rows = new Array(nTimes);
  let wavelengths = null;
  let pos = layout.headerEnd;

  for (let i = 0; i < nTimes; i++) {
    if (pos + 22 > dv.byteLength) {
      times.fill(0, i);
      rows.length = i;
      break;
    }
    // Segment header (little-endian): label, byte length, retention time in ms,
    // then wavelength low/high/step stored as nm * 20, then 8 unknown bytes.
    const label = dv.getUint16(pos, true);
    const segLen = dv.getUint16(pos + 2, true);
    const timeMs = dv.getUint32(pos + 4, true);
    const lo = dv.getUint16(pos + 8, true);
    const hi = dv.getUint16(pos + 10, true);
    const step = dv.getUint16(pos + 12, true);
    const nWl = step > 0 ? Math.floor((hi - lo) / step) + 1 : 0;

    if (wavelengths === null) {
      wavelengths = new Array(nWl);
      for (let k = 0; k < nWl; k++) wavelengths[k] = (lo + k * step) / 20;
    }

    times[i] = timeMs / MS_PER_MIN;
    const row = new Float64Array(nWl);
    const body = pos + 22;

    if (label === 70) {
      // OpenLab variant (measured): the body is nWl little-endian float64s.
      for (let k = 0; k < nWl; k++) row[k] = dv.getFloat64(body + k * 8, true) * scale;
    } else {
      // Documented variant: delta-encoded little-endian integers.
      const raw = new Array(nWl);
      readDeltaValues(dv, body, nWl, true, raw, 0, 0);
      for (let k = 0; k < nWl; k++) row[k] = raw[k] * scale;
    }

    rows[i] = Array.from(row);
    pos += segLen > 0 ? segLen : 22;
  }

  return {
    format: 'Agilent .uv',
    version,
    detector: 'UV',
    xlabel: 'Time (min)',
    ylabel: meta.unit || 'mAU',
    ylabels: wavelengths || [],
    times: Array.from(times),
    signals: rows,
    metadata: meta,
  };
}

/* ------------------------------------------------------------------ *
 * Public entry point
 * ------------------------------------------------------------------ */

/**
 * Parse an Agilent ChemStation .ch or .uv file.
 *
 * @param {ArrayBuffer} arrayBuffer raw file contents
 * @param {string} [filename] used only for detector hints and error messages
 * @returns {{xlabel: string, ylabel: string, ylabels: Array, times: number[],
 *            signals: number[][], metadata: object, format: string,
 *            version: string, detector: string}}
 */
export function parse(arrayBuffer, filename = '') {
  const dv = new DataView(arrayBuffer);
  if (dv.byteLength < 0x200) throw new Error(`${filename || 'file'}: too small to be an Agilent data file`);

  // Every supported version starts with a pascal string holding the file type
  // number (ex: "30", "130", "131", "179").
  const version = readStringAscii(dv, 0);

  if (DELTA_BODY_CH.has(version) || DOUBLE_BODY_CH.has(version)) return parseCh(dv, version, filename);
  if (UV_VERSIONS.has(version)) return parseUv(dv, version, filename);

  throw new Error(
    `${filename || 'file'}: unsupported Agilent file type "${version}". ` +
    'Supported: .ch versions 30, 130, 179, 181 and .uv versions 31, 131.'
  );
}

/** Convenience: the version string without a full parse. */
export function peekVersion(arrayBuffer) {
  return readStringAscii(new DataView(arrayBuffer), 0);
}

/** Render a parsed result as the same CSV layout the demo exports. */
export function toCsv(result, channelIndex = null) {
  const cols = channelIndex === null
    ? result.ylabels.map((_, i) => i)
    : [channelIndex];
  const head = [result.xlabel, ...cols.map((i) => result.ylabels[i])].join(',');
  const lines = [head];
  for (let i = 0; i < result.times.length; i++) {
    lines.push([result.times[i], ...cols.map((c) => result.signals[i][c])].join(','));
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * Layout description
 *
 * Reports where each field the parser reads actually sits in the bytes,
 * and walks the first few encoded values through to plotted units. Added
 * for the "inside the file" panel on the landing page; `parse` and the
 * rest of this module do not depend on it and are unchanged.
 * ------------------------------------------------------------------ */

const FIELD_LABELS = {
  notebook: 'Sample name',
  parentDir: 'Operator',
  date: 'Acquisition date',
  method: 'Method',
  unit: 'Units',
  signal: 'Signal description',
  description: 'Signal description',
};

const FIELD_NOTES = {
  notebook: 'What the operator typed as the sample name.',
  parentDir: 'The user recorded with the run.',
  date: 'Free text, not a timestamp: the exact string the instrument wrote.',
  method: 'Name or path of the acquisition method.',
  unit: 'The y-axis label is taken straight from here.',
  signal: 'Carries the monitored wavelength, so the chart can label the trace.',
  description: 'What the detector was recording.',
};

/** Order the panel reads in; missing fields are skipped. */
const DESCRIBED_FIELDS = ['notebook', 'parentDir', 'date', 'method', 'unit', 'signal', 'description'];

/** Longest run of bytes a single string region reports, so one long method
 *  path cannot push every other field out of the view. */
const MAX_STRING_BYTES = 48;

function layoutFor(version) {
  if (DOUBLE_BODY_CH.has(version) || version === '130') return MODERN_CH;
  if (version === '30') return LEGACY_CH;
  if (version === '31') return LEGACY_UV;
  if (version === '131') return MODERN_UV;
  return null;
}

function hexOf(dv, offset, length) {
  const out = [];
  for (let i = 0; i < length && offset + i < dv.byteLength; i++) {
    out.push(dv.getUint8(offset + i).toString(16).padStart(2, '0').toUpperCase());
  }
  return out.join(' ');
}

function stringRegion(dv, layout, key, offset, measured) {
  const value = layout.str(dv, offset);
  if (!value) return null;
  const wide = layout.str === readStringUtf16;
  const chars = dv.getUint8(offset);
  const full = 1 + chars * (wide ? 2 : 1);
  return {
    id: key,
    label: FIELD_LABELS[key] || key,
    offset,
    length: Math.min(full, MAX_STRING_BYTES),
    fullLength: full,
    kind: 'string',
    encoding: wide
      ? 'Pascal string, UTF-16LE'
      : 'Pascal string, one byte per character',
    value,
    detail: `${chars} characters`,
    source: measured ? 'measured' : 'docs',
    note: FIELD_NOTES[key] || '',
  };
}

/** .ch bodies of "16, count" segments: big-endian deltas onto a running value. */
function walkChDelta(dv, start, scale, result, maxSteps) {
  const label = dv.getUint8(start);
  const count = dv.getUint8(start + 1);
  const steps = [];
  let pos = start + 2;
  let acc = 0;
  const n = Math.min(maxSteps, count);
  for (let i = 0; i < n; i++) {
    const at = pos;
    const short = dv.getInt16(pos, false);
    pos += 2;
    let kind = 'delta';
    if (short === -0x8000) {
      acc = dv.getInt32(pos, false);
      pos += 4;
      kind = 'absolute';
    } else {
      acc += short;
    }
    const value = acc * scale;
    steps.push({
      index: i,
      offset: at,
      bytes: hexOf(dv, at, kind === 'absolute' ? 6 : 2),
      kind,
      short,
      int: acc,
      value,
      time: result.times[i],
      plotted: result.signals[i] ? result.signals[i][0] : null,
    });
  }
  return {
    encoding: 'delta-encoded int16, big-endian',
    header: { offset: start, length: 2, bytes: hexOf(dv, start, 2), label, count },
    headerNote: `Segment label ${label}, then ${count} values.`,
    axis: 'time',
    steps,
    bytesUsed: pos - start,
  };
}

/** .ch versions 179 and 181: the body is plain little-endian float64. */
function walkChDouble(dv, start, scale, result, maxSteps) {
  const steps = [];
  const n = Math.min(maxSteps, result.times.length);
  for (let i = 0; i < n; i++) {
    const at = start + i * 8;
    const raw = dv.getFloat64(at, true);
    steps.push({
      index: i,
      offset: at,
      bytes: hexOf(dv, at, 8),
      kind: 'double',
      short: null,
      int: raw,
      value: raw * scale,
      time: result.times[i],
      plotted: result.signals[i] ? result.signals[i][0] : null,
    });
  }
  return {
    encoding: 'float64, little-endian',
    header: null,
    headerNote: 'No segment headers: the body is one double per point.',
    axis: 'time',
    steps,
    bytesUsed: n * 8,
  };
}

/** .uv: a 22-byte segment header per retention time, then one row of spectra. */
function walkUv(dv, start, scale, result, maxSteps) {
  const label = dv.getUint16(start, true);
  const segLen = dv.getUint16(start + 2, true);
  const body = start + 22;
  const steps = [];
  const n = Math.min(maxSteps, result.ylabels.length);
  let pos = body;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const at = pos;
    let kind;
    let short = null;
    if (label === 70) {
      acc = dv.getFloat64(pos, true);
      pos += 8;
      kind = 'double';
    } else {
      short = dv.getInt16(pos, true);
      pos += 2;
      if (short === -0x8000) {
        acc = dv.getInt32(pos, true);
        pos += 4;
        kind = 'absolute';
      } else {
        acc += short;
        kind = 'delta';
      }
    }
    steps.push({
      index: i,
      offset: at,
      bytes: hexOf(dv, at, pos - at),
      kind,
      short,
      int: acc,
      value: acc * scale,
      time: result.times[0],
      channel: result.ylabels[i],
      plotted: result.signals[0] ? result.signals[0][i] : null,
    });
  }
  return {
    encoding: label === 70
      ? 'float64, little-endian (OpenLab variant)'
      : 'delta-encoded int16, little-endian',
    header: { offset: start, length: 22, bytes: hexOf(dv, start, 22), label, count: segLen },
    headerNote: `Segment label ${label}, ${segLen} bytes long, one retention time.`,
    axis: 'wavelength',
    steps,
    bytesUsed: pos - start,
  };
}

/**
 * Describe the byte layout of an Agilent .ch or .uv file: which range holds
 * which field, and how the first values decode.
 *
 * @param {ArrayBuffer} arrayBuffer raw file contents
 * @param {string} [filename] used for error messages only
 * @param {object} [parsed] a result from `parse` for the same buffer, to skip
 *        a second decode. Parsed here when omitted.
 * @param {number} [maxSteps] how many encoded values to walk through
 * @returns {{version: string, format: string, headerEnd: number,
 *            byteLength: number, strings: string, scale: number,
 *            unit: string, regions: object[], walkthrough: object}}
 */
export function describeLayout(arrayBuffer, filename = '', parsed = null, maxSteps = 8) {
  const dv = new DataView(arrayBuffer);
  const version = readStringAscii(dv, 0);
  const layout = layoutFor(version);
  if (!layout) {
    throw new Error(`${filename || 'file'}: unsupported Agilent file type "${version}".`);
  }
  const isUv = UV_VERSIONS.has(version);
  const result = parsed || parse(arrayBuffer, filename);
  const scale = safeF64BE(dv, layout.scale) || 1;
  // Legacy 30/31 string and scale offsets were measured from sample files;
  // the modern .uv scaling factor was too.
  const legacy = layout === LEGACY_CH || layout === LEGACY_UV;

  const regions = [];

  regions.push({
    id: 'version',
    label: 'File type',
    offset: 0,
    length: 1 + dv.getUint8(0),
    kind: 'string',
    encoding: 'Pascal string, one byte per character',
    value: version,
    detail: `${dv.getUint8(0)} characters`,
    source: 'docs',
    note: 'The first byte is a length, so the whole layout hangs off these few bytes. '
      + (legacy
        ? 'Legacy types keep a short header with single-byte strings.'
        : 'Newer types keep a long header with UTF-16 strings.'),
  });

  for (const key of DESCRIBED_FIELDS) {
    const off = layout.strings[key];
    if (off === undefined) continue;
    const r = stringRegion(dv, layout, key, off, legacy);
    if (r) regions.push(r);
  }

  if (!isUv) {
    const startRaw = dv.getUint32(0x11a, false);
    const wrapped = startRaw > 0x7fffffff;
    const first = result.times[0];
    const last = result.times[result.times.length - 1];
    regions.push({
      id: 'times',
      label: 'Retention time bounds',
      offset: 0x11a,
      length: 8,
      kind: 'number',
      encoding: DOUBLE_BODY_CH.has(version)
        ? 'two float32, big-endian'
        : 'two uint32, big-endian',
      value: `${first.toFixed(4)} min to ${last.toFixed(4)} min`,
      detail: 'milliseconds in the file',
      source: 'docs',
      note: wrapped
        ? `Read unsigned, the first bound is ${startRaw.toLocaleString('en-US')}. `
          + 'Baseline recorded before injection is only right when it is read signed.'
        : 'The first and last time. Every point in between is spaced evenly across them.',
    });
  } else {
    regions.push({
      id: 'ntimes',
      label: 'Retention times in the file',
      offset: 0x116,
      length: 4,
      kind: 'number',
      encoding: 'uint32, big-endian',
      value: dv.getUint32(0x116, false).toLocaleString('en-US'),
      detail: 'spectra to read',
      source: 'docs',
      note: 'Each one has its own segment in the body, with its own retention time.',
    });
  }

  regions.push({
    id: 'scale',
    label: 'Scaling factor',
    offset: layout.scale,
    length: 8,
    kind: 'number',
    encoding: 'float64, big-endian',
    value: scale.toExponential(6),
    detail: 'multiplies every stored integer',
    source: legacy || layout === MODERN_UV ? 'measured' : 'docs',
    note: legacy
      ? 'The published offset covers newer files only. This one was found by reading the bytes.'
      : layout === MODERN_UV
        ? 'The published offset (0x127C) lands inside the data body for .uv. The real one sits '
          + 'directly before the units string.'
        : 'Without it the trace has the right shape and the wrong numbers.',
  });

  const walkthrough = isUv
    ? walkUv(dv, layout.headerEnd, scale, result, maxSteps)
    : DOUBLE_BODY_CH.has(version)
      ? walkChDouble(dv, layout.headerEnd, scale, result, maxSteps)
      : walkChDelta(dv, layout.headerEnd, scale, result, maxSteps);

  regions.push({
    id: 'body',
    label: 'Start of the data',
    offset: layout.headerEnd,
    length: walkthrough.bytesUsed,
    kind: 'body',
    encoding: walkthrough.encoding,
    value: `${result.times.length.toLocaleString('en-US')} points`,
    detail: `header ends at 0x${layout.headerEnd.toString(16).toUpperCase()}`,
    source: legacy ? 'measured' : 'docs',
    note: walkthrough.headerNote + ' The highlighted bytes are the ones decoded below.',
  });

  regions.sort((a, b) => a.offset - b.offset);

  return {
    filename,
    version,
    format: isUv ? 'Agilent .uv' : 'Agilent .ch',
    byteLength: dv.byteLength,
    headerEnd: layout.headerEnd,
    strings: layout.str === readStringUtf16 ? 'UTF-16LE' : 'single-byte',
    scale,
    scaleBytes: hexOf(dv, layout.scale, 8),
    unit: result.ylabel,
    regions,
    walkthrough,
  };
}

/** Raw bytes at an offset, for a hex view. Returns a plain array. */
export function bytesAt(arrayBuffer, offset, length) {
  const end = Math.min(offset + length, arrayBuffer.byteLength);
  return Array.from(new Uint8Array(arrayBuffer, offset, Math.max(0, end - offset)));
}

export default { parse, peekVersion, toCsv, describeLayout, bytesAt };
