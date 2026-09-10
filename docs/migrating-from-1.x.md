# Migrating from 1.x

Version 1.x exposed `LasStreamReader`, a `stream.Transform` in object mode that
you piped a file into and that emitted arrays of points, reprojected to WGS84
with proj4. Version 2 has none of that.

## Why

The stream reader parsed each chunk from the pooled `ArrayBuffer` behind it
rather than from the chunk itself. At the default 64 KiB read size those
coincided; at 1 KiB, reading a 21 932 point file produced 175 086 garbage
records and never signalled completion. Output depended on how the bytes
happened to arrive.

Several field decoders were also wrong — the return-number byte had its
sub-fields reversed, classification was `byte << 4`, intensity was read
big-endian — and reprojection never actually happened: both code paths built an
identity transform, with the real call commented out.

Fixing those inside the streaming design was not worth doing. LAS has a header
that says where everything is and fixed-length records, so the reader now
addresses the file instead of waiting for it. That is also what makes seeking,
browser support and chunk-boundary correctness fall out for free.

## Mapping

| 1.x | 2.x |
| --- | --- |
| `new LasStreamReader(options)` + `pipe` | `await openFile(path)` / `await openBlob(file)` |
| `onParseHeader` event | `reader.header` |
| `onParseVLR` event | `reader.vlrs`, `reader.evlrs`, `reader.records` |
| `onGotProjection` event | `reader.crs` |
| `onFinishedReadingRecords` event | the loop ends |
| `onGotLazInfo` event | `reader.header.compressed` |
| `log` event | — |
| `error` event | a rejected promise or a thrown `LasError` |
| arrays of points from the stream | `for await (const point of reader)` |
| `point.raw` | `point.rawX`, `point.rawY`, `point.rawZ` |
| `point.scaled` | `point.x`, `point.y`, `point.z` |
| `point.lng_lat` | reproject yourself; see [Coordinate systems](coordinate-systems.md) |
| `point.elevation` | `point.z * (reader.crs.verticalUnitToMetres ?? 1)` |
| `point.scan_angle_rank` | `point.scanAngle` (degrees) / `point.scanAngleRaw` |
| snake_case fields generally | camelCase |
| `options.transform_lnglat` | — the library does not reproject |
| `options.projection` / `ignore_projection` | — |
| `options.parse_every_x_point` | iterate and skip, or use `readPoints` |
| `models.Header` etc. | `parseHeader`, `decodePoint`, `parseVlrs` |

## Before

```js
const las = require('las-reader')
const fs = require('fs')

const stream = new las.LasStreamReader({ transform_lnglat: true })
stream.on('onParseHeader', (header) => console.log(header.points.number_of_points))
stream.on('error', console.error)

fs.createReadStream('cloud.las').pipe(stream).pipe(sink)
```

## After

```js
import { openFile } from '@qgustavor/las-reader/node'

const reader = await openFile('cloud.las')
console.log(reader.pointCount)

for await (const point of reader) {
  // point.x, point.y, point.z
}

await reader.close()
```

## Things that are new

- LAS 1.3 and 1.4, point formats 0–10, and EVLRs.
- Random access and resumable iteration.
- A browser entry point that reads local files without uploading them.
- [Spatial and attribute filters](filtering.md).
- [Block indexes](large-files.md#block-indexes) for files you query repeatedly.
- Errors that name the byte offset of the problem.

## Things that are gone

- proj4 and int64-buffer, and the bundled 444 KB EPSG snapshot.
- The custom WKT parser.
- Node streams. `reader.stream()` returns a whatwg `ReadableStream`; convert at
  the edge if you need a Node `Readable`.
