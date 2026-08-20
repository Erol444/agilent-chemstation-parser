# agilent-chemstation-parser

Reads Agilent ChemStation `.ch` and `.uv` files in JavaScript. Gives you the
retention times and the signal. Writes CSV. No dependencies, no build step.
Runs in Node and in a browser.

These are the binary files inside a `.D` folder. ChemStation writes them, and
almost nothing else reads them. There are good Python readers. This is the
JavaScript one, so you can open a run in a browser tab with no server.

## Use

```js
import { parse, toCsv } from './parser.mjs';

const run = parse(arrayBuffer, 'DAD1A.ch');

run.times      // retention times, in minutes
run.signals    // one row per time, one value per channel
run.ylabels    // channel labels. Wavelengths in nm for .uv
run.detector   // 'UV', 'FID', 'ADC'
run.version    // '30', '130', '179', '31', '131'
run.metadata   // instrument, model, method, software, date, units

writeFileSync('run.csv', toCsv(run));
```

Also exports `peekVersion` to check a file before reading it, and
`describeLayout` to get back every byte offset the parser used.

Needs Node 18 or newer. In a browser, pass it the `ArrayBuffer` from a
`FileReader`.

## What it reads

| File | Version | Detectors seen | How the numbers are stored | Checked |
| --- | --- | --- | --- | --- |
| `.ch` | 30 | UV | delta encoded int16 and int32, big endian | yes |
| `.ch` | 130 | UV, ELSD and CAD via ADC | delta encoded int16 and int32, big endian | yes |
| `.ch` | 179 | UV (OpenLab), FID | float64, little endian | yes |
| `.ch` | 181 | FID | float64, little endian | no sample yet |
| `.uv` | 31 | DAD spectra | delta encoded int16 and int32, little endian | yes |
| `.uv` | 131 | DAD spectra | delta encoded, or float64 | yes, both kinds |

Version 181 shares its code path with 179, but no public 181 file exists to
check it against. It is listed as untested for that reason.

Anything else is named and refused. A file is never drawn wrong on purpose.

## Tests

```bash
./fetch-samples.sh
node test.mjs
```

11 real files from 5 `.D` folders, every value compared against a CSV that
ChemStation and rainbow agree on. Last run: 11 passed, 0 failed, and the largest
relative error on 1.4 million values was zero.

There is a second test that is harder to fool:

```bash
node hexcheck.mjs
```

It takes every field the parser claims to have read, decodes that byte range on
its own, and checks the two answers match. Then it walks the first raw values
all the way to plotted units. Last run: 729 of 729 checks passed. A parser that
guessed a right answer from a wrong offset fails this.

`fetch-samples.sh` downloads the test files from the rainbow project. They are
not committed here, because rainbow is LGPL-3.0 and this code is MIT.

## Viewer

If you want to look at a run without writing code,
[PeakWright](https://peakwright.com) uses this parser in the browser. The file
stays on your machine.

## License

MIT
