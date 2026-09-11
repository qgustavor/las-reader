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
`LasUnsupportedError`. PRs are welcome.

## License

Apache-2.0

[LAS]: https://www.ogc.org/publications/standard/las/
