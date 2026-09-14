import { POINT_FORMATS } from '../../src/point-format.js'
import { ArithmeticEncoder, IntegerCompressor } from './arithmetic-encoder.js'
import {
  COMPRESSORS,
  DEFAULT_CHUNK_SIZE,
  ITEM_TYPES,
  LASZIP_ITEM_BYTES,
  LASZIP_VLR_FIXED_BYTES,
  LASZIP_VLR_RECORD_ID,
  LASZIP_VLR_USER_ID
} from '../../src/laz/laszip-vlr.js'

/**
 * The item list LASzip writes for a given point data record format, which is
 * the same decomposition the real compressor uses: one item for the fixed
 * fields, then one per optional block, then a BYTE item for anything trailing.
 *
 * @param {number} pointFormat 0-10
 * @param {number} [extraByteCount] bytes past the format's own fields
 * @returns {Array<{ type: number, size: number, version: number }>}
 */
export function itemsForFormat (pointFormat, extraByteCount = 0) {
  const format = POINT_FORMATS[pointFormat]
  if (!format) throw new RangeError(`no such point format: ${pointFormat}`)

  const items = []
  if (format.extended) {
    items.push({ type: ITEM_TYPES.POINT14, size: 30, version: 3 })
    if (format.nir) items.push({ type: ITEM_TYPES.RGBNIR14, size: 8, version: 3 })
    else if (format.color) items.push({ type: ITEM_TYPES.RGB14, size: 6, version: 3 })
    if (format.waveform) items.push({ type: ITEM_TYPES.WAVEPACKET14, size: 29, version: 3 })
    if (extraByteCount > 0) {
      items.push({ type: ITEM_TYPES.BYTE14, size: extraByteCount, version: 3 })
    }
  } else {
    items.push({ type: ITEM_TYPES.POINT10, size: 20, version: 2 })
    if (format.gpsTime) items.push({ type: ITEM_TYPES.GPSTIME11, size: 8, version: 2 })
    if (format.color) items.push({ type: ITEM_TYPES.RGB12, size: 6, version: 2 })
    if (format.waveform) items.push({ type: ITEM_TYPES.WAVEPACKET13, size: 29, version: 1 })
    if (extraByteCount > 0) {
      items.push({ type: ITEM_TYPES.BYTE, size: extraByteCount, version: 2 })
    }
  }
  return items
}

/**
 * Encodes a LASzip VLR payload. Every field can be overridden, including to
 * values that are invalid, so that the parser's rejections can be tested.
 *
 * @param {object} [options]
 * @param {number} [options.pointFormat] used to derive `items` when not given
 * @param {number} [options.extraByteCount]
 * @param {Array<{ type: number, size: number, version: number }>} [options.items]
 * @param {number} [options.compressor]
 * @param {number} [options.coder]
 * @param {number} [options.chunkSize]
 * @param {number} [options.options]
 * @param {number} [options.numberOfSpecialEvlrs]
 * @param {number} [options.offsetToSpecialEvlrs]
 * @param {number} [options.declaredItemCount] written instead of items.length
 * @returns {Uint8Array}
 */
export function buildLaszipVlrPayload (options = {}) {
  const {
    pointFormat = 0,
    extraByteCount = 0,
    items = itemsForFormat(pointFormat, extraByteCount),
    compressor = COMPRESSORS.POINTWISE_CHUNKED,
    coder = 0,
    versionMajor = 3,
    versionMinor = 4,
    versionRevision = 3,
    chunkSize = DEFAULT_CHUNK_SIZE,
    numberOfSpecialEvlrs = -1,
    offsetToSpecialEvlrs = -1,
    declaredItemCount = items.length,
    options: optionBits = 0
  } = options

  const bytes = new Uint8Array(LASZIP_VLR_FIXED_BYTES + items.length * LASZIP_ITEM_BYTES)
  const view = new DataView(bytes.buffer)

  view.setUint16(0, compressor, true)
  view.setUint16(2, coder, true)
  view.setUint8(4, versionMajor)
  view.setUint8(5, versionMinor)
  view.setUint16(6, versionRevision, true)
  view.setUint32(8, optionBits, true)
  view.setUint32(12, chunkSize, true)
  view.setBigInt64(16, BigInt(numberOfSpecialEvlrs), true)
  view.setBigInt64(24, BigInt(offsetToSpecialEvlrs), true)
  view.setUint16(32, declaredItemCount, true)

  for (const [index, item] of items.entries()) {
    const at = LASZIP_VLR_FIXED_BYTES + index * LASZIP_ITEM_BYTES
    view.setUint16(at, item.type, true)
    view.setUint16(at + 2, item.size, true)
    view.setUint16(at + 4, item.version, true)
  }

  return bytes
}

/**
 * The same payload wrapped as a record, ready to pass to `buildLas`.
 *
 * @param {Parameters<typeof buildLaszipVlrPayload>[0]} [options]
 */
export function buildLaszipVlr (options = {}) {
  return {
    userId: LASZIP_VLR_USER_ID,
    recordId: LASZIP_VLR_RECORD_ID,
    description: 'by laszip test helper',
    data: buildLaszipVlrPayload(options)
  }
}

/**
 * Encodes a chunk table: the 8-byte header followed by the coded entries.
 *
 * Real files rarely hold more than one chunk at test sizes, so this is how the
 * chunk-to-chunk delta prediction gets exercised.
 *
 * @param {number[]} sizes compressed byte length of each chunk
 * @param {{ counts?: number[], version?: number }} [options] `counts` marks a
 *   variable-chunk table, which stores a point count per chunk as well
 * @returns {Uint8Array}
 */
export function buildChunkTable (sizes, { counts = null, version = 0 } = {}) {
  const encoder = new ArithmeticEncoder()
  const integers = new IntegerCompressor(encoder, 32, 2)

  let previousCount = 0
  let previousSize = 0
  for (const [index, size] of sizes.entries()) {
    if (counts !== null) {
      integers.compress(previousCount, counts[index], 0)
      previousCount = counts[index]
    }
    integers.compress(previousSize, size, 1)
    previousSize = size
  }
  const coded = sizes.length > 0 ? encoder.done() : new Uint8Array()

  const bytes = new Uint8Array(8 + coded.byteLength)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, version, true)
  view.setUint32(4, sizes.length, true)
  bytes.set(coded, 8)
  return bytes
}

/**
 * Assembles a file shaped like a chunked LAZ file: header, VLRs, the chunk
 * table pointer, filler standing in for compressed chunks, then the table.
 *
 * The chunk bytes are not real compressed data — nothing in the chunk table
 * path decodes them — but every offset and length is consistent.
 *
 * @param {object} [options]
 * @param {number[]} [options.chunkSizes] compressed size of each chunk
 * @param {number} [options.pointCount]
 * @param {number} [options.chunkSize] points per chunk
 * @param {number[]} [options.chunkCounts] points per chunk, for variable chunks
 * @param {number} [options.pointFormat]
 * @param {number} [options.tableOffsetOverride] written instead of the real one
 * @returns {Uint8Array}
 */
export function buildChunkedLaz (options = {}) {
  const {
    chunkSizes = [200, 210, 190],
    pointCount = 120000,
    chunkSize = 50000,
    chunkCounts = null,
    pointFormat = 1,
    tableOffsetOverride = null,
    tableVersion = 0
  } = options

  const laszipVlr = buildLaszipVlr({
    pointFormat,
    chunkSize: chunkCounts === null ? chunkSize : 0xffffffff
  })
  const table = buildChunkTable(chunkSizes, { counts: chunkCounts, version: tableVersion })
  const compressedTotal = chunkSizes.reduce((sum, size) => sum + size, 0)

  const format = POINT_FORMATS[pointFormat]
  const headerSize = 375
  const vlrBytes = 54 + laszipVlr.data.byteLength
  const offsetToPointData = headerSize + vlrBytes
  const tableOffset = offsetToPointData + 8 + compressedTotal

  const bytes = new Uint8Array(tableOffset + table.byteLength)
  const view = new DataView(bytes.buffer)

  new TextEncoder().encodeInto('LASF', bytes.subarray(0, 4))
  bytes[24] = 1
  bytes[25] = 4
  view.setUint16(94, headerSize, true)
  view.setUint32(96, offsetToPointData, true)
  view.setUint32(100, 1, true)
  bytes[104] = pointFormat | 0x80
  view.setUint16(105, format.byteLength, true)
  view.setUint32(107, pointCount, true)
  for (let axis = 0; axis < 3; axis++) {
    view.setFloat64(131 + axis * 8, 0.01, true)
    view.setFloat64(155 + axis * 8, 0, true)
  }
  view.setBigUint64(247, BigInt(pointCount), true)

  // The LASzip VLR.
  let cursor = headerSize
  view.setUint16(cursor, 0, true)
  new TextEncoder().encodeInto(laszipVlr.userId, bytes.subarray(cursor + 2, cursor + 18))
  view.setUint16(cursor + 18, laszipVlr.recordId, true)
  view.setUint16(cursor + 20, laszipVlr.data.byteLength, true)
  bytes.set(laszipVlr.data, cursor + 54)

  view.setBigInt64(
    offsetToPointData,
    BigInt(tableOffsetOverride === null ? tableOffset : tableOffsetOverride),
    true
  )
  bytes.set(table, tableOffset)

  return bytes
}
