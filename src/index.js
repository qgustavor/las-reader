/**
 * @qgustavor/las-reader
 *
 * Pure JavaScript, no runtime dependencies, no Node built-ins. Give it a
 * ByteSource and it reads the file.
 *
 * For ready-made sources see @qgustavor/las-reader/node (files on disk) and
 * @qgustavor/las-reader/browser (Blob, File, and HTTP range requests).
 */

export { LasReader } from './reader.js'
export { bytesSource, assertByteSource, readExact, checkRange } from './byte-source.js'
export { BinaryReader } from './binary-reader.js'
export { LasError, LasFormatError, LasUnsupportedError } from './errors.js'
export { parseHeader, validateHeader, HEADER_SIZES, MAX_HEADER_SIZE, FILE_SIGNATURE } from './header.js'
export { POINT_FORMATS, getPointFormat, decodePoint, EXTENDED_SCAN_ANGLE_STEP } from './point-format.js'
export { parseVlrs, parseEvlrs, readRecords, findRecord, KNOWN_RECORDS, VLR_HEADER_BYTES, EVLR_HEADER_BYTES, DEFAULT_MAX_PAYLOAD } from './vlr.js'
export { readCrs, parseGeoKeys, linearUnitToMetres, GEO_KEYS, LINEAR_UNITS } from './crs.js'
export { pointsInBox, pointsNear, countInBox, boxToRawRange, matching, toColumns } from './filter.js'

import { LasReader } from './reader.js'
import { bytesSource } from './byte-source.js'

/**
 * Opens a LAS file already held in memory.
 *
 * @param {Uint8Array | ArrayBuffer} bytes
 * @param {{ allowTruncated?: boolean }} [options]
 * @returns {Promise<LasReader>}
 */
export function openBytes (bytes, options) {
  return LasReader.open(bytesSource(bytes), options)
}
