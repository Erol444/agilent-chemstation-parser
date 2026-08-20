/**
 * Checks describeLayout() against the sample files: every region it reports has
 * to land on bytes that independently decode to the value it claims, and every
 * step of the decode walkthrough has to end on the number in the golden CSV.
 *
 * Run: node hexcheck.mjs        (add SHOW=1 for the full region dump)
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse, describeLayout } from './parser.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

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

/** First two data rows of a golden CSV, as numbers. */
function goldenRows(path, n) {
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');
  const out = [];
  for (let i = 1; i < lines.length && out.length < n; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    out.push(line.split(',').map(Number));
  }
  return out;
}

/** Independent re-read of a pascal string, not using the parser's helpers. */
function readPascal(dv, offset, wide) {
  const len = dv.getUint8(offset);
  let s = '';
  for (let i = 0; i < len; i++) {
    s += wide
      ? String.fromCharCode(dv.getUint16(offset + 1 + i * 2, true))
      : String.fromCharCode(dv.getUint8(offset + 1 + i));
  }
  return s.trim();
}

let checks = 0;
let fails = 0;
const problems = [];

function ok(cond, what) {
  checks++;
  if (!cond) {
    fails++;
    problems.push(what);
  }
}

for (const c of CASES) {
  const sPath = join(ROOT, c.sample);
  const gPath = join(ROOT, c.golden);
  if (!existsSync(sPath) || !existsSync(gPath)) {
    console.log(`SKIP  ${c.sample}`);
    continue;
  }
  const label = c.sample.replace('samples/', '');
  const buf = readFileSync(sPath);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const dv = new DataView(ab);
  const result = parse(ab, label);
  const d = describeLayout(ab, label, result);

  ok(d.version === result.version, `${label}: version mismatch`);

  let prevEnd = -1;
  for (const r of d.regions) {
    ok(r.length > 0, `${label}/${r.id}: empty region`);
    ok(r.offset >= 0 && r.offset + r.length <= d.byteLength,
      `${label}/${r.id}: range 0x${r.offset.toString(16)}+${r.length} outside the file`);
    ok(r.offset >= prevEnd, `${label}/${r.id}: overlaps the region before it`);
    prevEnd = r.offset + r.length;

    if (r.kind === 'string') {
      const wide = d.strings === 'UTF-16LE' && r.id !== 'version';
      ok(readPascal(dv, r.offset, wide) === r.value,
        `${label}/${r.id}: bytes at 0x${r.offset.toString(16)} do not spell "${r.value}"`);
      const chars = dv.getUint8(r.offset);
      ok((r.fullLength || r.length) === 1 + chars * (wide ? 2 : 1),
        `${label}/${r.id}: declared length does not match the length byte`);
    }
    if (r.id === 'scale') {
      ok(dv.getFloat64(r.offset, false) === d.scale,
        `${label}: scaling factor is not the float64 at 0x${r.offset.toString(16)}`);
    }
    if (r.id === 'body') {
      ok(r.offset === d.headerEnd, `${label}: body does not start at the header end`);
    }
  }

  const w = d.walkthrough;
  ok(w.steps.length > 0, `${label}: no decode steps`);
  ok(w.bytesUsed > 0, `${label}: walkthrough consumed no bytes`);
  if (w.header) {
    ok(w.header.offset === d.headerEnd, `${label}: segment header is not at the header end`);
  }

  const rows = goldenRows(gPath, 2);
  for (const s of w.steps) {
    ok(s.offset >= d.headerEnd && s.offset < d.byteLength,
      `${label}: step ${s.index} reads outside the body`);
    ok(s.value === s.plotted,
      `${label}: step ${s.index} value ${s.value} is not the plotted ${s.plotted}`);
    // byte -> integer -> x scale -> golden CSV, with nothing in between.
    const goldenValue = w.axis === 'wavelength'
      ? rows[0][1 + s.index]
      : rows[s.index] && rows[s.index][1];
    if (goldenValue !== undefined) {
      const rel = Math.abs(s.value - goldenValue) / Math.max(Math.abs(goldenValue), 1e-9);
      ok(rel < 1e-9,
        `${label}: step ${s.index} decodes to ${s.value}, golden says ${goldenValue}`);
    }
  }

  const shown = w.axis === 'wavelength' ? Math.min(2, w.steps.length) : 2;
  console.log(
    `OK    ${label.padEnd(22)} v${d.version.padEnd(4)} header 0x${d.headerEnd.toString(16).toUpperCase()}  ` +
    `${d.strings.padEnd(11)} scale@0x${d.regions.find((r) => r.id === 'scale').offset.toString(16).toUpperCase().padEnd(4)} ` +
    `${d.scale.toExponential(4)}  ${d.regions.length} regions  ` +
    `first ${shown}: ${w.steps.slice(0, shown).map((s) => s.value.toFixed(6)).join(', ')}`
  );

  if (process.env.SHOW) {
    for (const r of d.regions) {
      console.log(
        `      0x${r.offset.toString(16).toUpperCase().padStart(4, '0')} +${String(r.length).padStart(3)}  ` +
        `${r.source.padEnd(8)} ${r.label.padEnd(24)} ${JSON.stringify(r.value).slice(0, 46)}`
      );
    }
    for (const s of w.steps) {
      console.log(
        `      step ${String(s.index).padStart(2)} 0x${s.offset.toString(16).toUpperCase()} ` +
        `[${s.bytes}] ${s.kind.padEnd(8)} int ${String(s.int).padStart(10)} -> ${s.value}`
      );
    }
  }
}

console.log(`\n${checks - fails} of ${checks} checks passed`);
for (const p of problems) console.log(`FAIL  ${p}`);
process.exit(fails === 0 ? 0 : 1);
