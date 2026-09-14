import { readExact } from './byte-source.js'
import { LasReader } from './reader.js'

/**
 * Bit 7 of the point data record format byte marks a LASzip-compressed file.
 * Bits 6 and 7 are both used in the wild, so the top two bits are masked off.
 */
const COMPRESSION_MASK = 0b11000000

/** Byte offset of the point data record format field in the public header. */
const FORMAT_BYTE = 104

/**
 * Opens a file, compressed or not.
 *
 * Which reader a file needs is written in its own header, so callers should not
 * have to know before they open it. This reads that one byte and hands the
 * source to `LasReader` or `LazReader` accordingly, and every high-level opener
 * in this library goes through it.
 *
 * The compressed reader is imported only when a compressed file is actually
 * opened. That is a code-splitting boundary, not a hedge about the dependency:
 * bundlers put laz-perf in a separate chunk, so an application that only ever
 * reads .las never downloads a WASM build of LASzip. Anything that does open a
 * .laz file pays for it once, on the first one.
 *
 * @param {import('./byte-source.js').ByteSource} source
 * @param {object} [options] passed to whichever reader is used
 * @returns {Promise<LasReader>}
 */
export async function open (source, options) {
  if (await isCompressed(source)) {
    const { LazReader } = await import('./laz/reader.js')
    return LazReader.open(source, options)
  }
  return LasReader.open(source, options)
}

/**
 * Reports whether a source holds a LASzip-compressed file.
 *
 * @param {import('./byte-source.js').ByteSource} source
 * @returns {Promise<boolean>}
 */
export async function isCompressed (source) {
  // A source too short to hold the field is not a LAS file at all. Say it is
  // uncompressed and let the header parser produce the real complaint, which
  // names the offset and what it expected.
  if (source.byteLength <= FORMAT_BYTE) return false
  const bytes = await readExact(source, FORMAT_BYTE, 1)
  return (bytes[0] & COMPRESSION_MASK) !== 0
}
