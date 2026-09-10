# @qgustavor/las-reader

Read [LAS] lidar point clouds in Node.js and the browser.

- **No dependencies.** The core imports nothing, not even Node built-ins.
- **LAS 1.2, 1.3 and 1.4**, point data record formats 0 to 10, VLRs and EVLRs.
- **Random access.** Iterate the file, or jump straight to point 400 000 000.
- **Built for large local files.** Nothing is buffered but the block being
  decoded, so a 20 GB file read from `<input type="file">` works like a small
  one.
- **Async iteration and Web Streams.** No `node:stream` in your bundle.

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

In a browser, open a file the user picked — nothing is uploaded:

```js
import { openBlob } from '@qgustavor/las-reader/browser'

const reader = await openBlob(fileInput.files[0])
```

> **Run this in a Web Worker.** Decoding millions of points on the main thread
> will freeze the page. `File` and `Blob` are structured-cloneable, so handing
> one to a worker costs nothing. See [Using a Web Worker](docs/browser.md#using-a-web-worker)
> for a complete example.

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

| | |
| --- | --- |
| [Getting started](docs/getting-started.md) | Opening files, reading points, what a point looks like |
| [In the browser](docs/browser.md) | Local files, **Web Workers**, HTTP |
| [In Node.js](docs/node.md) | Paths, file handles, streams |
| [Working with large files](docs/large-files.md) | Block indexes, caching, memory |
| [Finding points](docs/filtering.md) | Boxes, radii, attribute predicates, columns |
| [Coordinate systems](docs/coordinate-systems.md) | What the file declares, and reprojecting with proj4 |
| [Byte sources](docs/byte-sources.md) | The I/O interface, and writing your own |
| [API reference](docs/api.md) | Every export |
| [Migrating from 1.x](docs/migrating-from-1.x.md) | What changed and why |

## Compressed files

LASzip (`.laz`) is not supported yet. Opening a compressed file throws
`LasUnsupportedError`.

## License

Apache-2.0

[LAS]: https://www.ogc.org/publications/standard/las/
