# Working with large files

Nothing here is special-cased for size. The reader addresses the file rather
than buffering it, so the same code path handles 400 KB and 20 GB. What changes
at scale is how many times you are willing to walk the file.

## What is held in memory

Opening a file reads the header, the VLRs and the EVLR headers. That is a few
kilobytes even on a huge file: records are walked one at a time rather than by
slurping the region they live in.

A record payload larger than 16 MiB is not read at open. It keeps its
`dataOffset` and `dataLength`, and you can fetch it when you want it:

```js
const bytes = await reader.readRecordData(record)
```

This matters because LAS 1.3 and 1.4 store internal waveform data packets in an
EVLR at the end of the file, where a payload can be gigabytes. Raise or lower
the threshold with `{ maxRecordPayload }` on open.

While reading points, the reader holds one block: `chunkSize` bytes, 1 MiB by
default. Nothing accumulates. Iterating a 20 GB file uses about the same memory
as iterating a small one.

If you collect results, you own that memory — a query returning ten million
points will build ten million objects. [`toColumns`](filtering.md#columns)
flattens them into typed arrays, which is both smaller and the shape geometry
code wants.

## The problem with one pass per query

Points sit in the file in acquisition order. Nothing about position tells you
where in the file to look, so a spatial query has to consider every record.

One pass over a large file is acceptable. Five is not, and interactive use
means many.

Everything below assumes an uncompressed file. On a `.laz` the costs are
different, because bytes must be decompressed before they can be rejected —
see [Compressed files](compressed-files.md).

## Block indexes

`buildBlockIndex` walks the file once and records the bounding box of each run
of points. Queries then skip the blocks that cannot contain a match.

```js
import { buildBlockIndex, pointsNear } from '@qgustavor/las-reader'

const index = await buildBlockIndex(reader, {
  blockSize: 65_536,
  signal: controller.signal,
  onProgress: ({ pointsDone, pointCount }) => showBar(pointsDone / pointCount)
})

for await (const point of pointsNear(reader, { x, y, radius: 25 }, { index })) {
  // reads only the blocks whose bounding box overlaps the query
}
```

Building decodes nothing. It reads the three coordinates of each record
straight out of the block, so the pass is bound by I/O rather than by parsing.

The index is plain data — six `Int32Array`s and a few numbers:

```js
{
  version: 1,
  pointCount, recordLength, blockSize, blockCount,
  minX, maxX, minY, maxY, minZ, maxZ   // Int32Array, one entry per block
}
```

At the default block size that is about 24 bytes per 65 536 points: roughly
360 KB for a billion points, 8 KB for ten million.

`pointsInBox`, `pointsNear` and `countInBox` all accept `{ index }`. Results
are identical with and without it; the only difference is how much gets read.

### Choosing a block size

Smaller blocks reject more precisely and cost more memory. Larger blocks are
cheaper to keep and read more slack around each hit. 65 536 is a reasonable
default; if your points are strongly spatially sorted, smaller blocks pay off,
and if they are scattered, no block size will help much.

`selectivity(index, range)` reports the fraction of the file a query would read,
which is the honest way to find out:

```js
import { boxToRawRange, selectivity } from '@qgustavor/las-reader'

const range = boxToRawRange(reader.header, box)
console.log(selectivity(index, range))   // 0.004 — good. 0.9 — the index is not helping.
```

## Caching an index

The index is structured-cloneable, so it survives `postMessage` and IndexedDB
without any serialisation of your own. For a file the user opens repeatedly,
build it once:

```js
const key = `${file.name}:${file.size}:${file.lastModified}`

let index = await store.get(key)          // your IndexedDB wrapper
if (!index) {
  index = await buildBlockIndex(reader)
  await store.put(key, index)
}
```

Always let the library check it before use — a stale index would otherwise
return quietly wrong answers:

```js
import { assertIndexMatches } from '@qgustavor/las-reader'

assertIndexMatches(index, reader)   // throws LasFormatError on a mismatch
```

`pointsInBox`, `pointsNear` and `countInBox` do this for you.

## Do it off the main thread

An indexing pass over a 20 GB file is minutes of solid CPU and I/O. In a
browser that must not happen on the main thread. See
[Using a Web Worker](browser.md#using-a-web-worker) for a complete example,
including keeping the reader and the index alive in the worker between queries.

## Truncated files

A file shorter than its header claims is an error by default, naming how many
points are actually present. To read what is there:

```js
const reader = await openBlob(file, { allowTruncated: true })
reader.pointCount   // what is really in the file
```
