import { LasFormatError } from './errors.js'

/**
 * A random-access source of bytes.
 *
 * This is the only thing the reader needs in order to work, and it is
 * deliberately small enough that a file handle, an HTTP endpoint that supports
 * range requests, a Blob, or an in-memory array can all satisfy it. Because
 * reads are addressed rather than pushed, seeking and re-reading come for free
 * and no stream implementation has to be bundled.
 *
 * @typedef {object} ByteSource
 * @property {number} byteLength total size of the source in bytes
 * @property {(offset: number, length: number) => Promise<Uint8Array>} read
 *   resolves with exactly `length` bytes starting at `offset`
 * @property {() => Promise<void>} [close] releases any underlying handle
 */

/**
 * Wraps bytes already in memory.
 *
 * @param {Uint8Array | ArrayBuffer} input
 * @returns {ByteSource}
 */
export function bytesSource (input) {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input
  if (!ArrayBuffer.isView(bytes)) {
    throw new TypeError('bytesSource expects an ArrayBuffer or a typed array')
  }
  return {
    byteLength: bytes.byteLength,
    async read (offset, length) {
      checkRange(offset, length, bytes.byteLength)
      return bytes.subarray(offset, offset + length)
    }
  }
}

/**
 * Throws unless [offset, offset + length) fits inside a source of `byteLength`.
 *
 * Every ByteSource implementation calls this before touching its backing store,
 * so an out-of-range read fails the same way whatever the source is.
 *
 * @param {number} offset
 * @param {number} length
 * @param {number} byteLength
 */
export function checkRange (offset, length, byteLength) {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new LasFormatError(`read offset must be a non-negative integer, got ${offset}`)
  }
  if (!Number.isInteger(length) || length < 0) {
    throw new LasFormatError(`read length must be a non-negative integer, got ${length}`)
  }
  if (offset + length > byteLength) {
    throw new LasFormatError(
      `read of ${length} bytes runs past the end of a ${byteLength} byte source`,
      { offset }
    )
  }
}

/**
 * Throws unless `value` looks like a ByteSource.
 *
 * @param {unknown} value
 * @returns {ByteSource}
 */
export function assertByteSource (value) {
  if (
    typeof value !== 'object' || value === null ||
    typeof (/** @type {ByteSource} */ (value).read) !== 'function' ||
    !Number.isInteger(/** @type {ByteSource} */ (value).byteLength)
  ) {
    throw new TypeError(
      'expected a ByteSource: an object with a numeric byteLength and a read(offset, length) method'
    )
  }
  return /** @type {ByteSource} */ (value)
}

/**
 * Reads exactly `length` bytes, concatenating partial reads if the underlying
 * source returns short. Sources are allowed to return less than asked for; the
 * rest of the library is not written to cope with that.
 *
 * @param {ByteSource} source
 * @param {number} offset
 * @param {number} length
 * @returns {Promise<Uint8Array>}
 */
export async function readExact (source, offset, length) {
  checkRange(offset, length, source.byteLength)
  const first = await source.read(offset, length)
  if (first.byteLength === length) return first

  const out = new Uint8Array(length)
  let filled = 0
  let chunk = first
  while (filled < length) {
    if (chunk.byteLength === 0) {
      throw new LasFormatError(
        `source returned no data reading ${length} bytes; got ${filled}`,
        { offset: offset + filled }
      )
    }
    out.set(chunk.subarray(0, Math.min(chunk.byteLength, length - filled)), filled)
    filled += chunk.byteLength
    if (filled < length) chunk = await source.read(offset + filled, length - filled)
  }
  return out
}
