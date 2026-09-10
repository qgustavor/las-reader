# In the browser

```js
import { openBlob, openUrl, blobSource, httpRangeSource } from '@qgustavor/las-reader/browser'
```

The `/browser` entry point re-exports everything from the core, so this is the
only import you need.

## Local files

```html
<input type="file" id="picker" accept=".las">
```

```js
import { openBlob } from '@qgustavor/las-reader/browser'

picker.addEventListener('change', async () => {
  const reader = await openBlob(picker.files[0])
  console.log(reader.header.versionString, reader.pointCount)
})
```

A `File` is a `Blob`, and reads go through `Blob.slice`, which is lazy: the
browser pages in only the ranges asked for, straight from disk. Nothing is
uploaded, nothing is copied into memory up front, and nothing is held but the
block currently being decoded. A 20 GB file behaves like a 20 MB one.

This also works with the File System Access API, since a handle's `getFile()`
returns a `File`:

```js
const [handle] = await window.showOpenFilePicker()
const reader = await openBlob(await handle.getFile())
```

## Using a Web Worker

**Do this.** It is the single thing most likely to be forgotten and most likely
to be regretted. Decoding a few million points takes seconds of solid CPU; on
the main thread that is seconds of frozen UI, no repaint, no scrolling, no
cancel button.

`File` and `Blob` are structured-cloneable, so passing one to a worker costs
nothing — the browser hands over a reference to the same bytes on disk, it does
not copy the file.

Three rules that make the difference:

1. **Send the `File`, not its contents.** Never `arrayBuffer()` it on the main
   thread.
2. **Send results back as typed arrays, transferred.** Posting a few hundred
   thousand point objects will serialise them one property at a time and undo
   the point of the exercise. Use [`toColumns`](filtering.md#columns) and put
   the buffers in the transfer list.
3. **Keep the reader alive in the worker** between queries, along with any
   [block index](large-files.md), so a second query does not reopen the file.

### The worker

```js
// las-worker.js
import { openBlob } from '@qgustavor/las-reader/browser'
import { buildBlockIndex, pointsNear, toColumns } from '@qgustavor/las-reader'

let reader = null
let index = null

self.onmessage = async ({ data }) => {
  try {
    switch (data.type) {
      case 'open': {
        reader = await openBlob(data.file)
        index = null
        self.postMessage({
          type: 'opened',
          id: data.id,
          header: {
            version: reader.header.versionString,
            pointCount: reader.pointCount,
            bounds: reader.header.bounds,
            format: reader.header.pointDataRecordFormat
          },
          crs: {
            wkt: reader.crs.wkt,
            horizontalEpsg: reader.crs.horizontalEpsg,
            verticalEpsg: reader.crs.verticalEpsg
          }
        })
        break
      }

      case 'index': {
        index = await buildBlockIndex(reader, {
          onProgress ({ pointsDone, pointCount }) {
            self.postMessage({ type: 'progress', id: data.id, done: pointsDone, total: pointCount })
          }
        })
        self.postMessage({ type: 'indexed', id: data.id, index })
        break
      }

      case 'near': {
        const found = []
        for await (const point of pointsNear(reader, data.centre, { index })) {
          found.push(point)
        }
        const columns = toColumns(found, ['classification', 'intensity'])
        self.postMessage({ type: 'result', id: data.id, columns }, [
          columns.x.buffer, columns.y.buffer, columns.z.buffer,
          columns.classification.buffer, columns.intensity.buffer
        ])
        break
      }
    }
  } catch (error) {
    self.postMessage({ type: 'error', id: data.id, message: error.message, name: error.name })
  }
}
```

### The page

```js
const worker = new Worker(new URL('./las-worker.js', import.meta.url), { type: 'module' })

const pending = new Map()
let nextId = 0

function ask (message, transfer = []) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    worker.postMessage({ ...message, id }, transfer)
  })
}

worker.onmessage = ({ data }) => {
  if (data.type === 'progress') return showProgress(data.done / data.total)
  const entry = pending.get(data.id)
  if (!entry) return
  pending.delete(data.id)
  data.type === 'error'
    ? entry.reject(Object.assign(new Error(data.message), { name: data.name }))
    : entry.resolve(data)
}

// The File crosses the boundary by reference; its bytes stay on disk.
const { header } = await ask({ type: 'open', file: picker.files[0] })

const { columns } = await ask({
  type: 'near',
  centre: { x: 2230900, y: 252200, radius: 25 }
})

console.log(columns.count, columns.x, columns.z)
```

`type: 'module'` on the `Worker` is required — this package is ESM only.

### Cancelling

`buildBlockIndex` takes an `AbortSignal`. An indexing pass over a large file is
a visible operation and someone will want to stop it:

```js
const controller = new AbortController()
index = await buildBlockIndex(reader, { signal: controller.signal })
```

Iteration is cancellable by leaving the loop — `break`, `return`, or throwing
all close the generator and stop reading.

## Over HTTP

For a file on a server that honours range requests:

```js
import { openUrl } from '@qgustavor/las-reader/browser'

const reader = await openUrl('https://example.com/cloud.las')
```

Only the ranges needed are fetched. If the server does not report a size or
does not support `Range`, the whole body is downloaded once and served from
memory, which is correct but defeats the purpose; pass `{ requireRanges: true }`
to fail loudly instead. `{ headers }` and `{ fetch }` are also accepted, the
latter for auth wrappers and for testing.

A full scan over HTTP still transfers the whole point block. For anything large,
prefer a local file.

## Bundlers

The package is ESM with no dependencies and no Node built-ins in the core, so
nothing needs polyfilling and `sideEffects: false` lets unused exports be
dropped. Import from `@qgustavor/las-reader/browser` rather than `/node` — the
latter imports `node:fs/promises`, which bundlers will either fail on or shim
pointlessly.
