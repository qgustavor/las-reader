/**
 * @qgustavor/las-reader
 *
 * Give it a ByteSource and it reads the file. Compressed files are detected
 * from the header and the LASzip decoder is loaded on demand, so a bundle that
 * never opens a .laz never pulls it in.
 *
 * For ready-made sources see @qgustavor/las-reader/node (files on disk) and
 * @qgustavor/las-reader/browser (Blob, File, and HTTP range requests).
 */

export { LasReader } from './reader.js'
export { open, isCompressed } from './open.js'
export { bytesSource, assertByteSource, readExact, checkRange } from './byte-source.js'
export { BinaryReader } from './binary-reader.js'
export { LasError, LasFormatError, LasUnsupportedError } from './errors.js'
export { parseHeader, validateHeader, HEADER_SIZES, MAX_HEADER_SIZE, FILE_SIGNATURE } from './header.js'
export { POINT_FORMATS, getPointFormat, decodePoint, EXTENDED_SCAN_ANGLE_STEP } from './point-format.js'
export { parseVlrs, parseEvlrs, readRecords, findRecord, KNOWN_RECORDS, VLR_HEADER_BYTES, EVLR_HEADER_BYTES, DEFAULT_MAX_PAYLOAD } from './vlr.js'
export { readCrs, parseGeoKeys, linearUnitToMetres, GEO_KEYS, LINEAR_UNITS } from './crs.js'
export { pointsInBox, pointsNear, countInBox, boxToRawRange, matching, toColumns } from './filter.js'
export { buildBlockIndex, candidateRuns, assertIndexMatches, selectivity, DEFAULT_BLOCK_SIZE } from './block-index.js'

import { bytesSource } from './byte-source.js'
import { open } from './open.js'

/**
 * Opens a LAS or LAZ file already held in memory.
 *
 * Compression is detected from the header. The LASzip decoder is loaded only
 * if the file turns out to need it.
 *
 * @param {Uint8Array | ArrayBuffer} bytes
 * @param {{ allowTruncated?: boolean }} [options]
 * @returns {Promise<import('./reader.js').LasReader>}
 */
export function openBytes (bytes, options) {
  return open(bytesSource(bytes), options)
}
