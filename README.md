# @qgustavor/las-reader

Read [LAS] lidar point clouds in Node.js and the browser.

```sh
npm install @qgustavor/las-reader
```

Node.js 24 or newer. ESM only.

## Quick start

```js
import { openFile } from '@qgustavor/las-reader/node'

const reader = await openFile('cloud.las')

console.log(reader.header.versionString, reader.pointCount)

for await (const point of reader) {
  console.log(point.x, point.y, point.z, point.classification)
}

await reader.close()
```

In a browser, open a file the user picked:

```js
import { openBlob } from '@qgustavor/las-reader/browser'

const reader = await openBlob(fileInput.files[0])
```

## Finding points

```js
import { pointsNear, matching } from '@qgustavor/las-reader'

for await (const point of pointsNear(
  reader,
  { x: 2230900, y: 252200, radius: 25 },
  { where: matching({ classification: [2, 9] }) }
)) {
  console.log(point.x, point.y, point.z, point.distance)
}
```

Queries reject points on the stored integers before decoding anything. On a
file you will query more than once, build an index first so later queries skip
most of it — see [Working with large files](docs/large-files.md).

## Documentation

| [Getting started](docs/getting-started.md) | Opening files, reading points, what a point looks like |
| --- | --- |
| [In the browser](docs/browser.md) | Local files, Web Workers, HTTP |
| [In Node.js](docs/node.md) | Paths, file handles, streams |
| [Working with large files](docs/large-files.md) | Block indexes, caching, memory |
| [Finding points](docs/filtering.md) | Boxes, radii, attribute predicates, columns |
| [Coordinate systems](docs/coordinate-systems.md) | What the file declares, and reprojecting with proj4 |
| [Byte sources](docs/byte-sources.md) | The I/O interface and writing your own |
| [Compressed files](docs/compressed-files.md) | Reading `.laz`, chunk tables, sharing a WASM module |
| [API reference](docs/api.md) | Every export |
| [Migrating from 1.x](docs/migrating-from-1.x.md) | What changed and why |

## Compressed files

LASzip (`.laz`) files open the same way `.las` files do:

```js
const reader = await openFile('cloud.laz')
```

The openers read the header and pick the right reader, so callers do not have
to know which they have. Decompression uses [laz-perf] in WebAssembly, loaded
only when a compressed file is actually opened, so a bundle that reads only
`.las` never pulls it in.

Chunks are decompressed as they are needed, so `readPoint(4_000_000)` costs one
chunk rather than the whole file — see
[Compressed files](docs/compressed-files.md).

[laz-perf]: https://github.com/hobuinc/laz-perf

## License

Apache-2.0

[LAS]: https://www.ogc.org/publications/standard/las/
