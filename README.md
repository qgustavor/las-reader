# @qgustavor/las-reader

Read [LAS] lidar point clouds in Node.js and the browser.

- No runtime dependencies, no Node built-ins in the core.
- LAS 1.2, 1.3 and 1.4; point data record formats 0 to 10.
- Random access: iterate, or jump straight to point 4 000 000.
- Async iteration and Web Streams. No `node:stream` to bundle.

## Install

```sh
npm install @qgustavor/las-reader
```

Requires Node.js 24 or newer. ESM only.

## Usage

### Node.js

```js
import { openFile } from '@qgustavor/las-reader/node'

const reader = await openFile('cloud.las')

console.log(reader.header.versionString, reader.pointCount)

for await (const point of reader) {
  console.log(point.x, point.y, point.z, point.classification)
}

await reader.close()
```

### Browser

```js
import { openBlob, openUrl } from '@qgustavor/las-reader/browser'

const reader = await openBlob(fileInput.files[0])

// Or read straight off a server, one range request at a time:
const remote = await openUrl('https://example.com/cloud.las')
```

### Anywhere

The core entry point knows nothing about how bytes are obtained. Give it a
[ByteSource](#bytesource) and it works:

```js
import { LasReader, openBytes } from '@qgustavor/las-reader'

const reader = await openBytes(arrayBuffer)
```

## Reading points

```js
// Everything, in order.
for await (const point of reader) { /* ... */ }

// A window, and a block size in bytes.
for await (const point of reader.points({ start: 1_000_000, count: 500, chunkSize: 1 << 20 })) { }

// Blocks rather than points, if you would rather batch.
for await (const block of reader.chunks()) { /* block is an array */ }

// Random access. One read, wherever the points are.
const point = await reader.readPoint(4_000_000)
const run = await reader.readPoints(4_000_000, 100)

// A whatwg ReadableStream of blocks, for pipeThrough and tee.
reader.stream().pipeThrough(someTransform)
```

Iteration allocates one object per point. In a hot loop, `{ reuse: true }`
hands back the same object every time, which removes the allocation — copy
anything you intend to keep.

```js
for await (const point of reader.points({ reuse: true })) {
  totalZ += point.z
}
```

## Points

`x`, `y` and `z` are scaled and offset per the header. `rawX`, `rawY` and
`rawZ` are the stored integers.

| Field | Notes |
| ----- | ----- |
| `x`, `y`, `z` | Scaled coordinates |
| `rawX`, `rawY`, `rawZ` | Stored 32-bit integers |
| `intensity` | |
| `returnNumber`, `numberOfReturns` | 3 bits in formats 0-5, 4 bits in 6-10 |
| `scanDirectionFlag`, `edgeOfFlightLine` | |
| `classification` | 5 bits in formats 0-5, a full byte in 6-10 |
| `synthetic`, `keyPoint`, `withheld`, `overlap` | Booleans |
| `scannerChannel` | Formats 6-10; `0` otherwise |
| `scanAngle` | Degrees, whatever the format stores |
| `scanAngleRaw` | As stored |
| `userData`, `pointSourceId` | |
| `gpsTime` | Formats 1, 3, 4, 5, 6-10 |
| `red`, `green`, `blue` | Formats 2, 3, 5, 7, 8, 10 |
| `nir` | Formats 8 and 10 |
| `waveform` | Formats 4, 5, 9, 10 |
| `extraBytes` | Anything past the format's own fields |

## Finding points

```js
import { pointsNear, pointsInBox, countInBox, matching, toColumns } from '@qgustavor/las-reader'

// Everything within 25 metres of a coordinate. `point.distance` comes along.
for await (const point of pointsNear(reader, { x: 2230900, y: 252200, radius: 25 })) {
  console.log(point.x, point.y, point.z, point.distance)
}

// A cylinder, ground returns only.
const ground = pointsNear(reader,
  { x: 2230900, y: 252200, radius: 25, minZ: 0, maxZ: 5 },
  { where: matching({ classification: [2, 9], returnNumber: 1 }) }
)

// An axis-aligned box. Omitted axes are unbounded.
for await (const point of pointsInBox(reader, { minX: 2230800, maxX: 2230900 })) { }

// How many, without decoding any of them.
const total = await countInBox(reader, { minZ: 50 })
```

These are ordinary async iterables, so `await Array.fromAsync(...)` collects
them. Each point carries its `index` in the file, which `readPoint` will take
back later.

Rejection happens on the stored integers: the box is converted into raw
coordinate space once, then each record is tested against three `Int32`
comparisons read straight out of the block. Only the survivors are decoded, and
a box outside the header's bounding box skips the file without reading it.

For downstream geometry — hulls, triangulation, areas, volumes — `toColumns`
flattens results into parallel `Float64Array`s:

```js
const { x, y, z, count } = toColumns(await Array.fromAsync(ground))
```

## Coordinate reference systems

This library does not reproject. It reports what the file declares and leaves
the transformation to you:

```js
import proj4 from 'proj4'

const { wkt, horizontalEpsg, verticalEpsg, verticalUnitToMetres } = reader.crs

const toWgs84 = proj4(wkt ?? `EPSG:${horizontalEpsg}`, 'EPSG:4326')
const [lon, lat] = toWgs84.forward([point.x, point.y])
```

`reader.crs` also carries `geoKeys` (the whole GeoTIFF key directory as a
`Map`), `projectedEpsg`, `geographicEpsg`, `linearUnitsEpsg` and
`horizontalUnitToMetres`.

## Variable length records

`reader.vlrs`, `reader.evlrs` and `reader.records` (both, in file order). Each
record has `userId`, `recordId`, `description`, `data` as a `Uint8Array`, plus
its `fileOffset` and `byteLength`.

```js
import { findRecord, KNOWN_RECORDS } from '@qgustavor/las-reader'

const classes = findRecord(reader.records, KNOWN_RECORDS.SPEC, KNOWN_RECORDS.CLASSIFICATION_LOOKUP)
```

## ByteSource

The whole I/O interface:

```ts
interface ByteSource {
  byteLength: number
  read (offset: number, length: number): Promise<Uint8Array>
  close? (): Promise<void>
}
```

Built-in implementations: `bytesSource` (core), `fileSource` and
`fileHandleSource` (`/node`), `blobSource` and `httpRangeSource`
(`/browser`). Anything else that satisfies the interface works too.

## Errors

`LasFormatError` for malformed files, carrying the byte `offset` where the
problem was found. `LasUnsupportedError` for valid files this library cannot
decode yet. Both extend `LasError`.

## Compressed files

LASzip (`.laz`) support is not in this entry point. Opening a compressed file
throws `LasUnsupportedError`.

## Migrating from 1.x

The 1.x `LasStreamReader` was a `stream.Transform` that emitted arrays of
points and reprojected them with proj4. It is gone. See
[CHANGELOG.md](CHANGELOG.md) for the full list; the short version:

| 1.x | 2.x |
| --- | --- |
| `new LasStreamReader()` and `pipe` | `await openFile(path)` |
| `onParseHeader` event | `reader.header` |
| `onParseVLR` event | `reader.vlrs`, `reader.evlrs` |
| `onGotProjection` event | `reader.crs` |
| `point.scaled` | `point.x`, `point.y`, `point.z` |
| `point.raw` | `point.rawX`, `point.rawY`, `point.rawZ` |
| `point.lng_lat` | reproject yourself from `reader.crs` |
| snake_case fields | camelCase fields |

## License

Apache-2.0

[LAS]: https://www.ogc.org/publications/standard/las/
