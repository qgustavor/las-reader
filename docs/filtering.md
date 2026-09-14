# Finding points

Filters reject points on their stored integers before decoding them. On a
compressed file the decompression happens first, so the saving is smaller —
see [Compressed files](compressed-files.md).

```js
import {
  pointsNear, pointsInBox, countInBox, matching, toColumns, boxToRawRange
} from '@qgustavor/las-reader'
```

All of these are async iterables over the same reader, so they compose with
`for await`, `break`, and `Array.fromAsync`.

## By radius

```js
for await (const point of pointsNear(reader, { x: 2230900, y: 252200, radius: 25 })) {
  console.log(point.x, point.y, point.z, point.distance)
}
```

`point.distance` is the planimetric distance from the centre, so sorting by it
gives you nearest-first. Adding `minZ`/`maxZ` turns the circle into a cylinder:

```js
pointsNear(reader, { x, y, radius: 25, minZ: 0, maxZ: 5 })
```

## By box

```js
for await (const point of pointsInBox(reader, { minX: 2230800, maxX: 2230900 })) { }
```

Any of `minX`, `maxX`, `minY`, `maxY`, `minZ`, `maxZ` may be omitted, in which
case that side is unbounded. Bounds are inclusive.

## By attribute

`where` takes any predicate over a decoded point. `matching` builds the common
ones:

```js
import { matching } from '@qgustavor/las-reader'

pointsNear(reader, centre, {
  where: matching({
    classification: [2, 9],   // an array matches any of its values
    returnNumber: 1,          // anything else matches by equality
    withheld: false,
    minZ: 0, maxZ: 50,        // z and intensity take ranges
    maxIntensity: 30_000
  })
})
```

Or write your own:

```js
pointsInBox(reader, box, { where: (point) => point.numberOfReturns > 1 })
```

## Counting

```js
const total = await countInBox(reader, { minZ: 50 })
```

`countInBox` never decodes a point, so it is much cheaper than collecting and
taking `.length`. Useful for sizing a buffer, or for deciding whether a query
is worth running at all.

## Collecting results

```js
const points = await Array.fromAsync(pointsNear(reader, centre))
```

Each point carries `index`, its position in the file. Keep those instead of the
points themselves if you only need to come back to them later:

```js
const hits = []
for await (const point of pointsNear(reader, centre)) hits.push(point.index)
// ... later
const revisited = await reader.readPoint(hits[0])
```

## Columns

For geometry work — convex hulls, triangulation, areas, volumes — parallel
typed arrays beat an array of objects on both memory and access cost:

```js
import { toColumns } from '@qgustavor/las-reader'

const { x, y, z, count, classification } = toColumns(points, ['classification'])
// x, y, z and classification are Float64Array of length `count`
```

These are also what you want to send across a `postMessage` boundary, since the
buffers can be transferred rather than serialised. See
[Using a Web Worker](browser.md#using-a-web-worker).

## How rejection works

A query box is converted once into the integer space the file actually stores:

```
raw = (world - offset) / scale
```

Each record is then tested with three `Int32` reads taken straight from the
block. Only survivors go through the full decode — the bit fields, the optional
GPS time and colour, the object allocation. On a selective query that is nearly
all of the work avoided.

`boxToRawRange` is exported if you want the converted range yourself. It rounds
inwards, so the integer range is never wider than the box you asked for, and it
returns `null` when the box misses the header's bounding box, which lets a query
skip a file without reading a point.

Some writers record wrong bounds in the header. If you suspect that, pass
`{ useHeaderBounds: false }` and the early rejection is skipped.

## Making it fast on a file you query repeatedly

Everything above still walks the whole file, because points are stored in
acquisition order. Build a [block index](large-files.md#block-indexes) once and
pass it in:

```js
const index = await buildBlockIndex(reader)
pointsNear(reader, centre, { index })
```

Results are identical either way. Only the amount read changes.
