/**
 * @qgustavor/las-reader/browser
 *
 * Browser sources. Nothing here is Node-specific; it runs anywhere that has
 * Blob and fetch, which includes Node itself.
 */

import { LasReader } from './reader.js'
import { checkRange } from './byte-source.js'
import { LasFormatError } from './errors.js'

export * from './index.js'

/**
 * A ByteSource backed by a Blob or File. `Blob.slice` is lazy, so a file picked
 * from an <input> is never loaded in full.
 *
 * @param {Blob} blob
 * @returns {import('./byte-source.js').ByteSource}
 */
export function blobSource (blob) {
  return {
    byteLength: blob.size,
    async read (offset, length) {
      checkRange(offset, length, blob.size)
      return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer())
    }
  }
}

/**
 * A ByteSource backed by HTTP range requests, so a file on a server can be read
 * without downloading it.
 *
 * The server must report its size and honour Range. If it does not, the whole
 * body is fetched once and served from memory, which is correct but defeats the
 * point; pass `{ requireRanges: true }` to fail loudly instead.
 *
 * @param {string | URL} url
 * @param {{ fetch?: typeof globalThis.fetch, headers?: HeadersInit, requireRanges?: boolean }} [options]
 * @returns {Promise<import('./byte-source.js').ByteSource>}
 */
export async function httpRangeSource (url, options = {}) {
  const doFetch = options.fetch ?? globalThis.fetch
  const headers = options.headers

  const probe = await doFetch(url, { method: 'HEAD', headers })
  if (!probe.ok) {
    throw new LasFormatError(`HEAD ${url} responded ${probe.status}`)
  }

  const declaredLength = Number(probe.headers.get('content-length'))
  const acceptsRanges = probe.headers.get('accept-ranges') === 'bytes'

  if (!acceptsRanges || !Number.isInteger(declaredLength) || declaredLength <= 0) {
    if (options.requireRanges) {
      throw new LasFormatError(`${url} does not support range requests`)
    }
    const response = await doFetch(url, { headers })
    if (!response.ok) throw new LasFormatError(`GET ${url} responded ${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    return {
      byteLength: bytes.byteLength,
      async read (offset, length) {
        checkRange(offset, length, bytes.byteLength)
        return bytes.subarray(offset, offset + length)
      }
    }
  }

  return {
    byteLength: declaredLength,
    async read (offset, length) {
      checkRange(offset, length, declaredLength)
      if (length === 0) return new Uint8Array()
      const range = `bytes=${offset}-${offset + length - 1}`
      const response = await doFetch(url, { headers: { ...headers, Range: range } })
      if (response.status !== 206 && response.status !== 200) {
        throw new LasFormatError(`GET ${url} with ${range} responded ${response.status}`, { offset })
      }
      return new Uint8Array(await response.arrayBuffer())
    }
  }
}

/**
 * Opens a LAS file held in a Blob or File.
 *
 * @param {Blob} blob
 * @param {{ allowTruncated?: boolean }} [options]
 * @returns {Promise<LasReader>}
 */
export function openBlob (blob, options) {
  return LasReader.open(blobSource(blob), options)
}

/**
 * Opens a LAS file over HTTP, reading only the ranges it needs.
 *
 * @param {string | URL} url
 * @param {{ fetch?: typeof globalThis.fetch, headers?: HeadersInit, requireRanges?: boolean, allowTruncated?: boolean }} [options]
 * @returns {Promise<LasReader>}
 */
export async function openUrl (url, options = {}) {
  return LasReader.open(await httpRangeSource(url, options), options)
}
