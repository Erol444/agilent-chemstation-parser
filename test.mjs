/**
 * Compares parser.mjs output against the golden CSVs published with the rainbow
 * test suite (tests/outputs/<color>/<name>.csv).
 *
 * Golden layout: first row is "RT (min),<ylabel>,<ylabel>,...", then one row per
 * retention time with the time in minutes followed by one value per channel.
 *
 * Run: node test.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse } from './parser.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

const REL_TOL = 1e-3;   // required by the demo spec
const ABS_FLOOR = 1e-9; // guards division by ~0 goldens only

const CASES = [
  { sample: 'samples/brown.D/dad1A.ch', golden: 'goldens/brown/dad1A.csv' },
  { sample: 'samples/brown.D/dad1B.ch', golden: 'goldens/brown/dad1B.csv' },
  { sample: 'samples/red.D/DAD1B.ch', golden: 'goldens/red/DAD1B.csv' },
  { sample: 'samples/red.D/DAD1C.ch', golden: 'goldens/red/DAD1C.csv' },
  { sample: 'samples/red.D/ADC1A.CH', golden: 'goldens/red/ADC1A.csv' },
  { sample: 'samples/orange.D/ADC1A.CH', golden: 'goldens/orange/ADC1A.csv' },
  { sample: 'samples/pink.D/DAD1A.ch', golden: 'goldens/pink/DAD1A.csv' },
  { sample: 'samples/yellow.D/FID1A.ch', golden: 'goldens/yellow/FID1A.csv' },
  { sample: 'samples/brown.D/dad1.uv', golden: 'goldens/brown/dad1.csv' },
  { sample: 'samples/red.D/DAD1.UV', golden: 'goldens/red/DAD1.csv' },
  { sample: 'samples/pink.D/DAD1.uv', golden: 'goldens/pink/DAD1.csv' },
];

function readGolden(path) {
  const text = readFileSync(path, 'utf8');
  const nl = text.indexOf('\n');
  const header = text.slice(0, nl).trim().split(',');
  const labels = header.slice(1);
  const times = [];
  const rows = [];
  let i = nl + 1;
  const len = text.length;
  while (i < len) {
    let j = text.indexOf('\n', i);
    if (j === -1) j = len;
    const line = text.slice(i, j);
    i = j + 1;
    if (!line || line === '\r') continue;
    const parts = line.split(',');
    times.push(Number(parts[0]));
    const row = new Float64Array(parts.length - 1);
    for (let k = 1; k < parts.length; k++) row[k - 1] = Number(parts[k]);
    rows.push(row);
  }
  return { labels, times, rows };
}

function close(a, b) {
  const d = Math.abs(a - b);
  if (d <= ABS_FLOOR) return true;
  return d <= REL_TOL * Math.max(Math.abs(a), Math.abs(b));
}

function compare(actual, golden) {
  if (actual.times.length !== golden.times.length) {
    return { ok: false, why: `time count ${actual.times.length} != golden ${golden.times.length}` };
  }
  const nCh = golden.rows.length ? golden.rows[0].length : 0;
  if (actual.ylabels.length !== nCh) {
    return { ok: false, why: `channel count ${actual.ylabels.length} != golden ${nCh}` };
  }

  let maxTimeErr = 0;
  let worstTimeAt = -1;
  for (let i = 0; i < golden.times.length; i++) {
    const a = actual.times[i];
    const g = golden.times[i];
    if (!close(a, g)) {
      return { ok: false, why: `time[${i}] ${a} != ${g}` };
    }
    const rel = Math.abs(a - g) / Math.max(Math.abs(g), ABS_FLOOR);
    if (rel > maxTimeErr) { maxTimeErr = rel; worstTimeAt = i; }
  }

  let maxValErr = 0;
  let worstVal = null;
  let n = 0;
  for (let i = 0; i < golden.rows.length; i++) {
    const gr = golden.rows[i];
    const ar = actual.signals[i];
    for (let k = 0; k < nCh; k++) {
      const a = ar[k];
      const g = gr[k];
      n++;
      if (!close(a, g)) {
        return { ok: false, why: `value[t=${i}][ch=${k}] ${a} != ${g}` };
      }
      const rel = Math.abs(a - g) / Math.max(Math.abs(g), ABS_FLOOR);
      if (rel > maxValErr) { maxValErr = rel; worstVal = { i, k, a, g }; }
    }
  }
  return { ok: true, maxTimeErr, maxValErr, n, worstTimeAt, worstVal };
}

function fmt(x) {
  if (x === 0) return '0';
  return x.toExponential(2);
}

let pass = 0;
let fail = 0;
const rows = [];

for (const c of CASES) {
  const sPath = join(ROOT, c.sample);
  const gPath = join(ROOT, c.golden);
  const label = c.sample.replace('samples/', '');
  if (!existsSync(sPath) || !existsSync(gPath)) {
    console.log(`SKIP  ${label.padEnd(24)} missing sample or golden`);
    continue;
  }
  const buf = readFileSync(sPath);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  let actual;
  try {
    actual = parse(ab, label);
  } catch (err) {
    console.log(`FAIL  ${label.padEnd(24)} parse threw: ${err.message}`);
    fail++;
    continue;
  }
  const golden = readGolden(gPath);
  const r = compare(actual, golden);
  const shape = `${actual.times.length}x${actual.ylabels.length}`;
  if (r.ok) {
    pass++;
    console.log(
      `PASS  ${label.padEnd(24)} v${actual.version.padEnd(4)} ${shape.padStart(10)}  ` +
      `max rel err: time ${fmt(r.maxTimeErr)}, value ${fmt(r.maxValErr)}  (${r.n} values)`
    );
    rows.push({ label, version: actual.version, shape, t: fmt(r.maxTimeErr), v: fmt(r.maxValErr), n: r.n });
  } else {
    fail++;
    console.log(`FAIL  ${label.padEnd(24)} v${actual.version.padEnd(4)} ${shape.padStart(10)}  ${r.why}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed (relative tolerance ${REL_TOL})`);

if (process.env.MARKDOWN) {
  console.log('\n| File | Version | Shape (times x channels) | Max rel. time error | Max rel. value error | Values compared |');
  console.log('| --- | --- | --- | --- | --- | --- |');
  for (const r of rows) {
    console.log(`| ${r.label} | ${r.version} | ${r.shape} | ${r.t} | ${r.v} | ${r.n.toLocaleString('en-US')} |`);
  }
}

process.exit(fail === 0 ? 0 : 1);
