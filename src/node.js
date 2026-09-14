/**
 * @qgustavor/las-reader/node
 *
 * Node.js sources, so callers do not have to write the fs plumbing themselves.
 */

import { open as openFileHandle } from 'node:fs/promises'
import { checkRange } from './byte-source.js'
import { open } from './open.js'

export * from './index.js'

/**
 * A ByteSource backed by a file on disk. Reads are positional, so the file
 * handle is never seeked and concurrent reads are safe.
 *
 * @param {string | URL} path
 * @returns {Promise<import('./byte-source.js').ByteSource>}
 */
export async function fileSource (path) {
  const handle = await openFileHandle(path, 'r')
  let byteLength
  try {
    byteLength = (await handle.stat()).size
  } catch (error) {
    await handle.close()
    throw error
  }

  return {
    byteLength,
    async read (offset, length) {
      checkRange(offset, length, byteLength)
      const buffer = new Uint8Array(length)
      const { bytesRead } = await handle.read(buffer, 0, length, offset)
      return bytesRead === length ? buffer : buffer.subarray(0, bytesRead)
    },
    async close () {
      await handle.close()
    }
  }
}

/**
 * A ByteSource backed by an already-open FileHandle. The handle is not closed
 * by `LasReader.close()`; whoever opened it still owns it.
 *
 * @param {import('node:fs/promises').FileHandle} handle
 * @param {number} byteLength
 * @returns {import('./byte-source.js').ByteSource}
 */
export function fileHandleSource (handle, byteLength) {
  return {
    byteLength,
    async read (offset, length) {
      checkRange(offset, length, byteLength)
      const buffer = new Uint8Array(length)
      const { bytesRead } = await handle.read(buffer, 0, length, offset)
      return bytesRead === length ? buffer : buffer.subarray(0, bytesRead)
    }
  }
}

/**
 * Opens a LAS or LAZ file from disk. Call `reader.close()` when done.
 *
 * Compression is detected from the header, so the same call reads either.
 *
 * @param {string | URL} path
 * @param {{ allowTruncated?: boolean }} [options]
 * @returns {Promise<import('./reader.js').LasReader>}
 */
export async function openFile (path, options) {
  const source = await fileSource(path)
  try {
    return await open(source, options)
  } catch (error) {
    await source.close()
    throw error
  }
}
