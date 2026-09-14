# Compressed files

Nothing special is required to read a LASzip (`.laz`) file:

```js
import { openFile } from '@qgustavor/las-reader/node'

const reader = await openFile('cloud.laz')

console.log(reader.header.versionString, reader.pointCount)

for await (const point of reader) {
  console.log(point.x, point.y, point.z, point.classification)
}

await reader.close()
```

`openFile`, `openBlob`, `openUrl` and `openBytes` all read the header, notice
the compression bit and hand the file to the right reader. Whether a file is
compressed is the file's business, not the caller's.

What you get back is a `LazReader`, which extends `LasReader`, so everything in
[Getting started], [Finding points] and [Working with large files] works the
same way. A point read from a `.laz` file is the same object you would get from
the `.las` it was made from.

## What it costs a bundle

Decompression happens in WebAssembly, through [laz-perf]. That is the largest
thing this library depends on, so it is loaded on demand: the import that
reaches it only runs once a compressed file is actually opened. Bundlers put it
in its own chunk, and an application that only ever reads `.las` never
downloads it.

Opening a compressed file does not compile the WASM either. The header, the
VLRs and the chunk table are all read in JavaScript, so a caller that only
wants the bounds, the point count or the coordinate system never pays for it:

```js
const reader = await openFile('cloud.laz')
console.log(reader.header.bounds, reader.crs)  // no WASM compiled
await reader.close()
```

The module is created the first time a point is actually read.

## Asking directly

`@qgustavor/las-reader/laz` exports `LazReader`, `openLaz` and the pieces below
for callers who want to skip detection, share a decompressor, or work with the
chunk table. Importing it is a static dependency on laz-perf, so prefer the
ordinary openers unless you need something here.

```js
import { openLaz } from '@qgustavor/las-reader/laz'
import { fileSource } from '@qgustavor/las-reader/node'

const reader = await openLaz(await fileSource('cloud.laz'))
```

You can also ask before opening:

```js
import { isCompressed } from '@qgustavor/las-reader'

if (await isCompressed(source)) { /* ... */ }
```

## Random access

A LAZ file restarts the compressor every 50 000 points by default, and records
where each of those chunks begins in a *chunk table* at the end of the file.
That is what keeps seeking cheap: reading one point in the middle of a file
costs one chunk, not the whole file.

```js
// Decompresses the one chunk point 4 000 000 lives in.
const point = await reader.readPoint(4_000_000)
```

One chunk is cached by default: the most recently decompressed one. That covers
reading forwards, where consecutive blocks of points usually fall in the chunk
the last one ended in. It does nothing for an access pattern that alternates
between chunks, which decompresses on every read.

`cacheChunks` keeps more:

```js
const reader = await openFile('cloud.laz', { cacheChunks: 8 })
```

Eviction is least-recently-used. A cached chunk costs its point count times the
record length — with the usual 50 000 points per chunk that is 1 to 3 MB each,
so raise it deliberately rather than by default.

## Reading one reader from several places at once

`LasReader` is safe to read concurrently: reads are positional and nothing is
shared between them. `LazReader` is not. Overlapping calls share one
decompression buffer and one cache, and will interleave and corrupt each
other's output — `Promise.all` over several ranges, or a `stream()` that has
been `tee()`d, are the ways to hit it.

Await each read before starting the next, or open a reader per concurrent
worker. This is a limitation of the implementation rather than of the format.

## Truncated files

A compressed file keeps its chunk table at the end, so a file that was cut
short usually has no table at all and cannot be opened. Where the table
survives but the chunks it describes do not — a file reassembled from parts,
say — `allowTruncated` keeps the chunks that are wholly present and drops the
rest:

```js
const reader = await openFile('partial.laz', { allowTruncated: true })
console.log(reader.header.pointCount)  // what the writer meant to produce
console.log(reader.pointCount)         // what is actually readable
```

Partial chunks are dropped rather than partly decoded: a chunk missing its tail
decompresses to garbage, not to fewer points.

## Filtering and block indexes

`pointsInBox`, `pointsNear`, `countInBox` and `buildBlockIndex` all work, but
their cost model is not the one described in [Working with large files]. On an
uncompressed file they win by rejecting points on their stored integers before
decoding them, and by reading only the byte ranges an index says are worth
reading. On a compressed file the bytes have to be decompressed before anything
can be rejected, and decompression is the expensive part.

So a filtered pass over a `.laz` file still decompresses every chunk it
touches, and `buildBlockIndex` decompresses the whole file. An index is still
worth building if you will query the same file repeatedly, because it avoids
re-decoding and lets `selectivity` tell you what a query will cost — but it
does not make the first pass cheap, and it does not currently skip whole
chunks.

The chunk table is available if you want to reason about it:

```js
console.log(reader.chunkTable.chunkCount)
for (const chunk of reader.chunkTable.chunks) {
  console.log(chunk.index, chunk.firstPoint, chunk.pointCount, chunk.byteLength)
}
```

## Over HTTP

Because chunks are addressed rather than streamed, a compressed file on a server
can be read without downloading it, the same as an uncompressed one:

```js
import { openUrl } from '@qgustavor/las-reader/browser'

const reader = await openUrl('https://example.com/cloud.laz')
const first = await reader.readPoints(0, 100)
```

This fetches the header, the chunk table, and the one chunk those hundred points
are in.

## In the browser

Emscripten needs to find the `.wasm` file. Most bundlers handle this. When it
is served from somewhere non-obvious, anything passed as `lazPerf` is handed
to laz-perf's `createLazPerf`, so whatever that accepts for locating the
module goes there:

```js
const reader = await openBlob(file, { lazPerf: { /* createLazPerf options */ } })
```

## Sharing one WASM module

Creating the module compiles the WASM, which is worth doing once if you are
opening many files:

```js
import { lazPerfBackend } from '@qgustavor/las-reader/laz'

const backend = await lazPerfBackend()
const readers = await Promise.all(paths.map((path) => openFile(path, { backend })))

// ...

backend.close()
```

A backend passed in this way is not closed by `reader.close()`; whoever created
it still owns it.

## What is not supported

| | |
| --- | --- |
| The unchunked pointwise scheme | LASzip 1.x wrote files as a single stream with no chunk table, so there is nothing to seek with. Reading them start to finish is possible in principle — laz-perf's whole-file API does it — but this library does not, because its chunk decoder is told only the point format and assumes the modern item versions. Throws `LasUnsupportedError`. |
| Files with no chunk table | Written when the producing process died before filling the table in. The points are all still there and start immediately after the chunk table pointer, so they can be read forwards; what is lost is seeking. This library refuses them rather than silently dropping to sequential reads. Throws `LasUnsupportedError`. |
| Writing | This library reads. |
| Waveform formats (4, 5, 9, 10) | The LASzip VLR parser accepts the WAVEPACKET items, and nothing rejects these formats, but whether laz-perf's chunk decoder handles them has not been established. Treat them as unproven rather than supported. |

Neither of the first two is a limit of the format. Both are cases where the
only thing on offer would be sequential decoding, and giving that back from an
API whose whole shape promises random access seemed worse than refusing. If you
have such files, say so — it is a feature, not a dead end.

## Errors

| | |
| --- | --- |
| `LasFormatError` | The file is marked compressed but carries no LASzip VLR, the VLR disagrees with the header about the point size, or the chunk table does not account for the compressed bytes |
| `LasUnsupportedError` | A LASzip scheme, item version or chunk table version this library does not read |

A chunk table whose sizes do not add up to the compressed byte range is treated
as a hard error rather than something to work around. The sizes are deltas
decoded from an adaptive model, so a table that decodes wrongly produces
plausible-looking numbers; if they do not sum correctly, every chunk offset
after the first is suspect and decompressing from them would produce garbage
rather than an error.

[Getting started]: getting-started.md
[Finding points]: filtering.md
[Working with large files]: large-files.md
[laz-perf]: https://github.com/hobuinc/laz-perf
