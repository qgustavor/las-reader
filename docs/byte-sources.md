# Byte sources

A `ByteSource` is the whole I/O interface. Everything else in this library is
pure computation over bytes.

```ts
interface ByteSource {
  byteLength: number
  read (offset: number, length: number): Promise<Uint8Array>
  close? (): Promise<void>
}
```

That is it: how big it is, and give me these bytes. Because reads are addressed
rather than pushed, seeking, resuming and chunk-boundary correctness are
properties of the design rather than features that had to be built.

## The built-in ones

| Source | Entry point | Backed by |
| --- | --- | --- |
| `bytesSource(bytes)` | core | An `ArrayBuffer` or typed array in memory |
| `fileSource(path)` | `/node` | A file on disk, positional reads |
| `fileHandleSource(handle, size)` | `/node` | A `FileHandle` you already own |
| `blobSource(blob)` | `/browser` | `Blob.slice`, lazy |
| `httpRangeSource(url, opts)` | `/browser` | HTTP `Range` requests |

Pass one to `LasReader.open`:

```js
import { LasReader, bytesSource } from '@qgustavor/las-reader'

const reader = await LasReader.open(bytesSource(arrayBuffer))
```

`openFile`, `openBlob`, `openUrl` and `openBytes` are conveniences that build a
source and open it in one call.

## Writing your own

Anything that can answer "give me bytes `[offset, offset + length)`" works —
a Cache Storage entry, an OPFS handle, a decrypted volume, a test double.

```js
const source = {
  byteLength: total,
  async read (offset, length) {
    return await somehowFetch(offset, length)
  }
}

const reader = await LasReader.open(source)
```

Three things to know:

**Returning short is allowed.** If `read` returns fewer bytes than asked for,
the library calls again for the rest. Returning zero bytes when more were
expected is treated as the source running out and throws a `LasFormatError`
rather than looping.

**Views are not copied.** The bytes you return may be handed out as subarrays,
for instance as a record's `data`. If your buffer is reused between calls,
return a copy.

**Validate your range.** `checkRange(offset, length, byteLength)` is exported so
your source rejects out-of-range reads the same way the built-in ones do:

```js
import { checkRange } from '@qgustavor/las-reader'

async read (offset, length) {
  checkRange(offset, length, this.byteLength)
  // ...
}
```

`assertByteSource(value)` throws a `TypeError` unless something looks like a
source, and `readExact(source, offset, length)` is the helper that reassembles
short reads if you want it for your own code.

## What the reader asks for

- Opening: the first 375 bytes, then the VLR region, then each EVLR header and
  payload in turn. A few kilobytes, whatever the file size.
- Iterating: one block at a time, `chunkSize` bytes, 1 MiB by default.
- `readPoint` / `readPoints`: exactly the requested run, in one read.

Reads are sequential in file order within a pass, so a source that does
read-ahead will do well. Nothing is read twice unless you ask twice.
