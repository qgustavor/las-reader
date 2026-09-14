/**
 * @qgustavor/las-reader/laz
 *
 * Reading LASzip-compressed files. Kept to its own entry point because it
 * pulls in laz-perf, which is a WASM build of the LASzip codecs and the
 * largest thing this library depends on; a bundle that only reads .las never
 * touches it.
 *
 * The division of labour: the header, the VLRs and the chunk table are read
 * here in JavaScript, so the file can be addressed the same way an
 * uncompressed one is. Only the chunks themselves cross into WASM, one at a
 * time, which is what keeps random access affordable.
 */

import { bytesSource } from './byte-source.js'
import { LazReader } from './laz/reader.js'

export { LazReader } from './laz/reader.js'
export { lazPerfBackend, assertLazBackend } from './laz/backend.js'
export {
  parseLaszipVlr,
  findLaszipVlr,
  assertVlrMatchesHeader,
  COMPRESSORS,
  CODERS,
  ITEM_TYPES,
  ITEM_INFO,
  DEFAULT_CHUNK_SIZE,
  VARIABLE_CHUNK_SIZE,
  LASZIP_VLR_USER_ID,
  LASZIP_VLR_RECORD_ID
} from './laz/laszip-vlr.js'
export {
  readChunkTable,
  decodeChunkTable,
  chunkForPoint,
  chunksForRange,
  CHUNK_TABLE_VERSION
} from './laz/chunk-table.js'

/**
 * Opens a compressed file from any ByteSource.
 *
 * Pair it with `fileSource` from the /node entry point, or `blobSource` and
 * `httpRangeSource` from /browser:
 *
 * ```js
 * import { fileSource } from '@qgustavor/las-reader/node'
 * import { openLaz } from '@qgustavor/las-reader/laz'
 *
 * const reader = await openLaz(await fileSource('cloud.laz'))
 * ```
 *
 * @param {import('./byte-source.js').ByteSource} source
 * @param {{ backend?: import('./laz/backend.js').LazBackend, lazPerf?: object }} [options]
 * @returns {Promise<LazReader>}
 */
export function openLaz (source, options) {
  return LazReader.open(source, options)
}

/**
 * Opens a compressed file already held in memory.
 *
 * @param {Uint8Array | ArrayBuffer} bytes
 * @param {{ backend?: import('./laz/backend.js').LazBackend, lazPerf?: object }} [options]
 * @returns {Promise<LazReader>}
 */
export function openLazBytes (bytes, options) {
  return LazReader.open(bytesSource(bytes), options)
}
