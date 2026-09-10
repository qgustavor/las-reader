import { BinaryReader } from './binary-reader.js'
import { LasFormatError } from './errors.js'

/** Bytes in a variable length record header, before its payload. */
export const VLR_HEADER_BYTES = 54

/**
 * Bytes in an extended variable length record header. EVLRs differ from VLRs
 * only in that the payload length is 64 bits rather than 16, which is what
 * lifts the 65535-byte ceiling that made VLRs useless for large WKT strings,
 * classification tables and LASzip chunk tables.
 */
export const EVLR_HEADER_BYTES = 60

/**
 * @typedef {object} LasRecord
 * @property {number} reserved
 * @property {string} userId
 * @property {number} recordId
 * @property {string} description
 * @property {Uint8Array} data
 * @property {boolean} extended true for EVLRs
 * @property {number} fileOffset byte offset of the record header in the file
 * @property {number} byteLength header plus payload
 */

function parseRecord (reader, extended) {
  const fileOffset = reader.fileOffset
  const reserved = reader.u16()
  const userId = reader.string(16)
  const recordId = reader.u16()
  const payloadLength = extended
    ? reader.u64AsNumber(`length of record ${recordId} from ${JSON.stringify(userId)}`)
    : reader.u16()
  const description = reader.string(32)

  if (payloadLength > reader.remaining) {
    throw new LasFormatError(
      `${extended ? 'EVLR' : 'VLR'} ${recordId} from ${JSON.stringify(userId)} declares ` +
      `${payloadLength} bytes of payload but only ${reader.remaining} are left`,
      { offset: reader.fileOffset }
    )
  }

  return {
    reserved,
    userId,
    recordId,
    description,
    data: reader.bytes(payloadLength),
    extended,
    fileOffset,
    byteLength: (extended ? EVLR_HEADER_BYTES : VLR_HEADER_BYTES) + payloadLength
  }
}

/**
 * Reads `count` records laid end to end.
 *
 * Stops early, rather than throwing, when the region runs out before the
 * declared count is reached: headers that overstate the record count are common
 * and the records already read are still usable. A record whose own declared
 * payload runs past the end is an error, because that means the offsets are
 * wrong rather than merely the count.
 *
 * @param {Uint8Array} bytes
 * @param {number} count how many records the header claims are here
 * @param {{ extended?: boolean, origin?: number }} [options]
 * @returns {LasRecord[]}
 */
export function parseRecords (bytes, count, { extended = false, origin = 0 } = {}) {
  const reader = new BinaryReader(bytes, { origin })
  const headerBytes = extended ? EVLR_HEADER_BYTES : VLR_HEADER_BYTES
  const records = []

  for (let index = 0; index < count; index++) {
    if (reader.remaining < headerBytes) break
    records.push(parseRecord(reader, extended))
  }

  return records
}

/**
 * @param {Uint8Array} bytes region between the header and the point data
 * @param {number} count
 * @param {number} origin
 */
export function parseVlrs (bytes, count, origin = 0) {
  return parseRecords(bytes, count, { extended: false, origin })
}

/**
 * @param {Uint8Array} bytes region from startOfFirstEvlr to the end of the file
 * @param {number} count
 * @param {number} origin
 */
export function parseEvlrs (bytes, count, origin = 0) {
  return parseRecords(bytes, count, { extended: true, origin })
}

/**
 * Finds the first record with the given user id and record id. VLRs and EVLRs
 * share a namespace, so callers can search both lists at once.
 *
 * @param {LasRecord[]} records
 * @param {string} userId
 * @param {number} recordId
 * @returns {LasRecord | undefined}
 */
export function findRecord (records, userId, recordId) {
  return records.find((record) => record.userId === userId && record.recordId === recordId)
}

/** Well-known user ids and record ids from the LAS specification. */
export const KNOWN_RECORDS = Object.freeze({
  PROJECTION: 'LASF_Projection',
  SPEC: 'LASF_Spec',
  LASZIP: 'laszip encoded',
  GEO_KEY_DIRECTORY: 34735,
  GEO_DOUBLE_PARAMS: 34736,
  GEO_ASCII_PARAMS: 34737,
  MATH_TRANSFORM_WKT: 2111,
  COORDINATE_SYSTEM_WKT: 2112,
  CLASSIFICATION_LOOKUP: 0,
  TEXT_AREA_DESCRIPTION: 3,
  EXTRA_BYTES: 4,
  WAVEFORM_PACKET_DESCRIPTOR_MIN: 100,
  WAVEFORM_PACKET_DESCRIPTOR_MAX: 354,
  LASZIP_RECORD_ID: 22204
})
