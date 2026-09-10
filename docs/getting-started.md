# Getting started

## Opening a file

Every entry point gives you a `LasReader`. Which one you use depends on where
the bytes are.

```js
// Node.js: a path on disk
import { openFile } from '@qgustavor/las-reader/node'
const reader = await openFile('cloud.las')

// Browser: a File or Blob the user picked
import { openBlob } from '@qgustavor/las-reader/browser'
const reader = await openBlob(fileInput.files[0])

// Anywhere: bytes you already have
import { openBytes } from '@qgustavor/las-reader'
const reader = await openBytes(arrayBuffer)
```

Opening reads the header, the variable length records and the extended
variable length records. It does not read any points, and it does not read the
whole file — even a 20 GB file opens in a few kilobytes of reads.

Call `reader.close()` when you are done. It releases the file handle in Node;
elsewhere it does nothing, but calling it is harmless.

## What the header tells you

```js
reader.header.versionString        // '1.4'
reader.header.pointCount           // 431_927_004
reader.header.pointDataRecordFormat // 6
reader.header.scale                // [0.001, 0.001, 0.001]
reader.header.offset               // [0, 0, 0]
reader.header.bounds               // { min: [x, y, z], max: [x, y, z] }
reader.header.systemIdentifier     // 'LAStools (c) by rapidlasso GmbH'
```

`reader.pointCount` is the number of points the reader will actually produce,
which is what you want in a loop. `reader.header.pointCount` is what the header
claims — the two differ only for a truncated file opened with
`{ allowTruncated: true }`.

See the [API reference](api.md#lasheader) for every header field.

## Reading points

The reader is async iterable:

```js
for await (const point of reader) {
  console.log(point.x, point.y, point.z)
}
```

`points()` takes the same options in more detail:

```js
// A window of the file.
for await (const point of reader.points({ start: 1_000_000, count: 500 })) { }

// Blocks rather than points, if you would rather batch.
for await (const block of reader.chunks()) {
  console.log(block.length)   // block is an array of points
}
```

Random access costs one read, wherever in the file you land:

```js
const point = await reader.readPoint(400_000_000)
const run = await reader.readPoints(400_000_000, 100)
```

This is what makes resuming work. If a pass stopped at point 4 million, start
the next one at 4 million; you do not have to read what came before.

## What a point looks like

`x`, `y` and `z` have the header's scale and offset applied. `rawX`, `rawY` and
`rawZ` are the integers as stored.

| Field | Notes |
| --- | --- |
| `x`, `y`, `z` | Scaled coordinates |
| `rawX`, `rawY`, `rawZ` | Stored 32-bit integers |
| `intensity` | |
| `returnNumber`, `numberOfReturns` | 3 bits in formats 0–5, 4 bits in 6–10 |
| `scanDirectionFlag`, `edgeOfFlightLine` | `0` or `1` |
| `classification` | 5 bits in formats 0–5, a full byte in 6–10 |
| `synthetic`, `keyPoint`, `withheld`, `overlap` | Booleans |
| `scannerChannel` | Formats 6–10; `0` otherwise |
| `scanAngle` | Degrees, whatever the format stores |
| `scanAngleRaw` | As stored: whole degrees, or 0.006° steps in 6–10 |
| `userData`, `pointSourceId` | |
| `gpsTime` | Formats 1, 3, 4, 5 and 6–10 |
| `red`, `green`, `blue` | Formats 2, 3, 5, 7, 8, 10 |
| `nir` | Formats 8 and 10 |
| `waveform` | Formats 4, 5, 9, 10 |
| `extraBytes` | `Uint8Array` of anything past the format's own fields |

Fields a format does not have are `undefined` rather than absent, so the shape
of the object is stable and engines can keep it monomorphic.

Points from a filter also carry `index`, their position in the file, which you
can hand back to `readPoint` later.

## Errors

```js
import { LasError, LasFormatError, LasUnsupportedError } from '@qgustavor/las-reader'
```

`LasFormatError` means the bytes are wrong, and carries `.offset`, the position
in the file where the problem was found. `LasUnsupportedError` means the file is
valid but uses something not implemented yet — a LASzip-compressed file, for
instance. Both extend `LasError`.

Anything the reader throws on purpose is a `LasError`. If you ever see a bare
`TypeError` or `RangeError` come out of it on a malformed file, that is a bug
worth reporting.

## Next

- [In the browser](browser.md) — and why this belongs in a worker
- [Working with large files](large-files.md)
- [Finding points](filtering.md)
