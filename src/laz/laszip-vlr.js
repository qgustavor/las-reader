import { BinaryReader } from '../binary-reader.js'
import { LasFormatError, LasUnsupportedError } from '../errors.js'
import { EVLR_HEADER_BYTES, findRecord, VLR_HEADER_BYTES } from '../vlr.js'

/**
 * The LASzip VLR.
 *
 * A `.laz` file is a `.las` file with bit 7 set on the point data record format
 * byte, its point records replaced by compressed chunks, and one extra VLR
 * describing how to undo that. The VLR is the only place the layout of the
 * compressed data is written down: the LAS header still describes the
 * *uncompressed* records, so without this record there is no way to know the
 * chunk size, which coder was used, or how a point record was split into items.
 *
 * Everything else in the LAZ path reads from the object this module produces,
 * which is why it is parsed and validated on its own, ahead of any decoder.
 */

export const LASZIP_VLR_USER_ID = 'laszip encoded'
export const LASZIP_VLR_RECORD_ID = 22204

/** Bytes before the item list. */
export const LASZIP_VLR_FIXED_BYTES = 34

/** Bytes per item descriptor. */
export const LASZIP_ITEM_BYTES = 6

/** Chunk size LASzip uses unless told otherwise, in points. */
export const DEFAULT_CHUNK_SIZE = 50000

/**
 * A chunk size of 2^32-1 means the chunks are not a fixed number of points.
 * The chunk table then carries a point count per chunk as well as a byte count,
 * so this flag has to reach the chunk table reader.
 */
export const VARIABLE_CHUNK_SIZE = 0xffffffff

/**
 * How the point records were compressed.
 *
 * `POINTWISE` is the original LASzip 1.x scheme: one arithmetic stream over the
 * whole file, so decoding point n means decoding points 0..n first. `CHUNKED`
 * restarts the coder every `chunkSize` points, which is what makes random
 * access affordable. `LAYERED` additionally splits each chunk into per-field
 * byte ranges, so a reader that only wants coordinates can skip the rest; it is
 * what LAS 1.4 point formats 6-10 use.
 */
export const COMPRESSORS = Object.freeze({
  NONE: 0,
  POINTWISE: 1,
  POINTWISE_CHUNKED: 2,
  LAYERED_CHUNKED: 3
})

const COMPRESSOR_NAMES = Object.freeze({
  0: 'none',
  1: 'pointwise',
  2: 'pointwise chunked',
  3: 'layered chunked'
})

/** Entropy coders. LASzip has only ever shipped the arithmetic one. */
export const CODERS = Object.freeze({ ARITHMETIC: 0 })

/**
 * Item types. A point record is compressed as a sequence of items rather than
 * as one blob, because each item has its own predictor: coordinates are coded
 * against the previous point, GPS times against a small set of running deltas,
 * colours against the previous colour. The item list is therefore both a layout
 * description and a list of which decompressors to instantiate.
 */
export const ITEM_TYPES = Object.freeze({
  BYTE: 0,
  SHORT: 1,
  INT: 2,
  LONG: 3,
  FLOAT: 4,
  DOUBLE: 5,
  POINT10: 6,
  GPSTIME11: 7,
  RGB12: 8,
  WAVEPACKET13: 9,
  POINT14: 10,
  RGB14: 11,
  RGBNIR14: 12,
  WAVEPACKET14: 13,
  BYTE14: 14
})

/**
 * Expected size and known versions for each item type.
 *
 * `size: null` marks the two variable-width items: BYTE and BYTE14 cover
 * whatever trails a point record after the format's own fields, so their size
 * is whatever the writer put there.
 *
 * @type {Record<number, { name: string, size: number | null, versions: number[] }>}
 */
export const ITEM_INFO = Object.freeze(Object.fromEntries([
  [ITEM_TYPES.BYTE, { name: 'BYTE', size: null, versions: [1, 2] }],
  [ITEM_TYPES.SHORT, { name: 'SHORT', size: 2, versions: [1] }],
  [ITEM_TYPES.INT, { name: 'INT', size: 4, versions: [1] }],
  [ITEM_TYPES.LONG, { name: 'LONG', size: 8, versions: [1] }],
  [ITEM_TYPES.FLOAT, { name: 'FLOAT', size: 4, versions: [1] }],
  [ITEM_TYPES.DOUBLE, { name: 'DOUBLE', size: 8, versions: [1] }],
  [ITEM_TYPES.POINT10, { name: 'POINT10', size: 20, versions: [1, 2] }],
  [ITEM_TYPES.GPSTIME11, { name: 'GPSTIME11', size: 8, versions: [1, 2] }],
  [ITEM_TYPES.RGB12, { name: 'RGB12', size: 6, versions: [1, 2] }],
  [ITEM_TYPES.WAVEPACKET13, { name: 'WAVEPACKET13', size: 29, versions: [1] }],
  [ITEM_TYPES.POINT14, { name: 'POINT14', size: 30, versions: [3, 4] }],
  [ITEM_TYPES.RGB14, { name: 'RGB14', size: 6, versions: [3, 4] }],
  [ITEM_TYPES.RGBNIR14, { name: 'RGBNIR14', size: 8, versions: [3, 4] }],
  [ITEM_TYPES.WAVEPACKET14, { name: 'WAVEPACKET14', size: 29, versions: [3, 4] }],
  [ITEM_TYPES.BYTE14, { name: 'BYTE14', size: null, versions: [3, 4] }]
].map(([id, info]) => [id, Object.freeze({ ...info, versions: Object.freeze(info.versions) })])))

/**
 * @typedef {object} LaszipItem
 * @property {number} type one of ITEM_TYPES
 * @property {string} name human-readable type name
 * @property {number} size bytes this item occupies in an uncompressed record
 * @property {number} version item compressor version
 */

/**
 * @typedef {object} LaszipVlr
 * @property {number} compressor
 * @property {string} compressorName
 * @property {number} coder
 * @property {{ major: number, minor: number, revision: number }} version
 * @property {number} options
 * @property {number} chunkSize points per chunk, or VARIABLE_CHUNK_SIZE
 * @property {boolean} chunked false only for the unchunked pointwise scheme
 * @property {boolean} layered true for the LAS 1.4 layered scheme
 * @property {boolean} variableChunks true when chunks hold differing point counts
 * @property {number} numberOfSpecialEvlrs -1 when unused
 * @property {number} offsetToSpecialEvlrs -1 when unused
 * @property {LaszipItem[]} items
 * @property {number} pointSize sum of the item sizes
 */

function readInt64 (reader, what) {
  const offset = reader.fileOffset
  const value = reader.i64()
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(-Number.MAX_SAFE_INTEGER)) {
    throw new LasFormatError(
      `${what} is ${value}, which exceeds the largest exactly representable integer`,
      { offset }
    )
  }
  return Number(value)
}

/**
 * Parses the payload of a LASzip VLR.
 *
 * Structural problems (a truncated payload, an item count that does not match
 * the bytes present) raise LasFormatError. A well-formed record asking for
 * something this library cannot decode raises LasUnsupportedError, matching how
 * `getPointFormat` distinguishes the two.
 *
 * @param {Uint8Array} data the VLR payload, without its 54-byte header
 * @param {{ origin?: number }} [options] byte offset of `data` within the file,
 *   used only to make error messages point at the right place
 * @returns {LaszipVlr}
 */
export function parseLaszipVlr (data, { origin = 0 } = {}) {
  if (!ArrayBuffer.isView(data)) {
    throw new TypeError('parseLaszipVlr expects a typed array')
  }
  if (data.byteLength < LASZIP_VLR_FIXED_BYTES) {
    throw new LasFormatError(
      `LASzip VLR is ${data.byteLength} bytes, which is short of the ` +
      `${LASZIP_VLR_FIXED_BYTES} bytes every one of them starts with`,
      { offset: origin }
    )
  }

  const reader = new BinaryReader(data, { origin })

  const compressor = reader.u16()
  const coder = reader.u16()
  const versionMajor = reader.u8()
  const versionMinor = reader.u8()
  const versionRevision = reader.u16()
  const options = reader.u32()
  // Signed in the record, but a negative count of points per chunk is nonsense;
  // read it unsigned so that the 2^32-1 sentinel survives the trip.
  const chunkSize = reader.u32()
  const numberOfSpecialEvlrs = readInt64(reader, 'number of special EVLRs')
  const offsetToSpecialEvlrs = readInt64(reader, 'offset to special EVLRs')
  const numberOfItems = reader.u16()

  const expectedBytes = LASZIP_VLR_FIXED_BYTES + numberOfItems * LASZIP_ITEM_BYTES
  if (data.byteLength < expectedBytes) {
    throw new LasFormatError(
      `LASzip VLR declares ${numberOfItems} items, which needs ${expectedBytes} bytes, ` +
      `but the payload is ${data.byteLength}`,
      { offset: origin + LASZIP_VLR_FIXED_BYTES - 2 }
    )
  }

  if (COMPRESSOR_NAMES[compressor] === undefined) {
    throw new LasUnsupportedError(
      `LASzip compressor ${compressor} is not one this library knows (0-3 are)`
    )
  }
  if (coder !== CODERS.ARITHMETIC) {
    throw new LasUnsupportedError(
      `LASzip entropy coder ${coder} is not supported; only the arithmetic coder (0) is`
    )
  }

  if (numberOfItems === 0) {
    throw new LasFormatError('LASzip VLR describes no items, so no point layout', { offset: origin })
  }

  const items = []
  for (let index = 0; index < numberOfItems; index++) {
    items.push(parseItem(reader, index))
  }

  return Object.freeze({
    compressor,
    compressorName: COMPRESSOR_NAMES[compressor],
    coder,
    version: Object.freeze({ major: versionMajor, minor: versionMinor, revision: versionRevision }),
    options,
    chunkSize,
    chunked: compressor === COMPRESSORS.POINTWISE_CHUNKED ||
      compressor === COMPRESSORS.LAYERED_CHUNKED,
    layered: compressor === COMPRESSORS.LAYERED_CHUNKED,
    variableChunks: chunkSize === VARIABLE_CHUNK_SIZE,
    numberOfSpecialEvlrs,
    offsetToSpecialEvlrs,
    items: Object.freeze(items),
    pointSize: items.reduce((sum, item) => sum + item.size, 0)
  })
}

function parseItem (reader, index) {
  const offset = reader.fileOffset
  const type = reader.u16()
  const size = reader.u16()
  const version = reader.u16()

  const info = ITEM_INFO[type]
  if (info === undefined) {
    throw new LasUnsupportedError(`LASzip item ${index} has type ${type}, which is not defined`)
  }
  if (info.size !== null && size !== info.size) {
    throw new LasFormatError(
      `LASzip item ${index} is a ${info.name}, which is ${info.size} bytes, but declares ${size}`,
      { offset: offset + 2 }
    )
  }
  if (info.size === null && size === 0) {
    throw new LasFormatError(
      `LASzip item ${index} is a ${info.name} of zero bytes, which encodes nothing`,
      { offset: offset + 2 }
    )
  }
  if (!info.versions.includes(version)) {
    throw new LasUnsupportedError(
      `LASzip item ${index} is a ${info.name} at version ${version}; ` +
      `this library decodes version ${info.versions.join(' and ')}`
    )
  }

  return Object.freeze({ type, name: info.name, size, version })
}

/**
 * Finds and parses the LASzip VLR among a reader's records.
 *
 * @param {import('../vlr.js').LasRecord[]} records
 * @returns {LaszipVlr | undefined} undefined when the file carries no such record
 */
export function findLaszipVlr (records) {
  const record = findRecord(records, LASZIP_VLR_USER_ID, LASZIP_VLR_RECORD_ID)
  if (record === undefined) return undefined
  if (record.data === null) {
    throw new LasFormatError(
      'the LASzip VLR payload was not loaded; it is larger than the record payload limit',
      { offset: record.fileOffset }
    )
  }
  // Records parsed from a buffer carry no dataOffset, so derive it: reporting
  // the header offset instead would put every error 54 bytes early.
  const origin = record.dataOffset ??
    record.fileOffset + (record.extended ? EVLR_HEADER_BYTES : VLR_HEADER_BYTES)
  return parseLaszipVlr(record.data, { origin })
}

/**
 * Checks a LASzip VLR against the LAS header it came with.
 *
 * The two describe the same records from different sides, and a disagreement
 * means one of them is lying: the item sizes have to add up to the record
 * length the header declares, or the decompressed output would not fit the
 * layout the rest of the library decodes with.
 *
 * @param {LaszipVlr} vlr
 * @param {{ pointDataRecordLength: number, pointDataRecordFormat: number }} header
 * @returns {LaszipVlr}
 */
export function assertVlrMatchesHeader (vlr, header) {
  if (vlr.pointSize !== header.pointDataRecordLength) {
    throw new LasFormatError(
      `the LASzip VLR describes ${vlr.pointSize} bytes per point but the header ` +
      `declares ${header.pointDataRecordLength}`
    )
  }

  const wantsExtended = header.pointDataRecordFormat >= 6
  const hasExtended = vlr.items.some((item) => item.type === ITEM_TYPES.POINT14)
  const hasLegacy = vlr.items.some((item) => item.type === ITEM_TYPES.POINT10)

  if (wantsExtended && !hasExtended) {
    throw new LasFormatError(
      `point data record format ${header.pointDataRecordFormat} needs a POINT14 item, ` +
      `but the LASzip VLR lists ${vlr.items.map((item) => item.name).join(', ')}`
    )
  }
  if (!wantsExtended && !hasLegacy) {
    throw new LasFormatError(
      `point data record format ${header.pointDataRecordFormat} needs a POINT10 item, ` +
      `but the LASzip VLR lists ${vlr.items.map((item) => item.name).join(', ')}`
    )
  }

  return vlr
}
