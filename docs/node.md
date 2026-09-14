# In Node.js

```js
import { openFile, fileSource, fileHandleSource } from '@qgustavor/las-reader/node'
```

The `/node` entry point re-exports everything from the core.

## Opening a path

```js
const reader = await openFile('cloud.las')
try {
  console.log(reader.pointCount)
} finally {
  await reader.close()
}
```

`openFile` accepts a string or a `URL`. It opens the file read-only and closes
the handle if opening fails, so a rejected promise never leaks a descriptor.
`reader.close()` closes it on the way out.

Reads are positional — the handle is never seeked — so concurrent reads on the
same reader are safe.

## Reusing a handle you already own

```js
import { open } from 'node:fs/promises'
import { fileHandleSource } from '@qgustavor/las-reader/node'
import { LasReader } from '@qgustavor/las-reader'

const handle = await open('cloud.las', 'r')
const { size } = await handle.stat()

const reader = await LasReader.open(fileHandleSource(handle, size))
// reader.close() does not close the handle: you opened it, you own it.
await handle.close()
```

## Web Streams

`reader.stream()` returns a whatwg `ReadableStream` of point blocks, which is
what Node's stream module speaks to these days:

```js
import { Writable } from 'node:stream'

await reader.stream().pipeTo(Writable.toWeb(destination))
```

If you need a Node `Readable`, convert at the edge rather than inside the
library:

```js
import { Readable } from 'node:stream'

const nodeStream = Readable.fromWeb(reader.stream())
```

Keeping the conversion in your code is what lets the same library run in a
browser without `node:stream` in the bundle.

## Worker threads

The same reasoning as [browsers](browser.md#using-a-web-worker) applies to
`node:worker_threads`, minus the frozen-UI part: decoding is CPU-bound and will
hold the event loop. If you are decoding hundreds of millions of points inside
a server that also has to answer requests, put it in a worker.

Unlike a browser, a worker thread cannot receive a file handle, so open the
file inside the worker by path.

## Compressed files

`openFile` reads `.laz` as well as `.las`; it checks the header and picks the
reader. See [Compressed files](compressed-files.md).
