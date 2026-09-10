import { HEADER_SIZES } from '../../src/header.js'
import { POINT_FORMATS } from '../../src/point-format.js'

const encoder = new TextEncoder()

function writeString (bytes, offset, value, length) {
  const encoded = encoder.encode(value).subarray(0, length)
  bytes.set(encoded, offset)
}

/**
 * Writes a syntheic LAS file. Only the parts a test cares about need to be
 * supplied; everything else gets a valid default.
 *
 * @param {object} [options]
 * @param {number} [options.versionMinor] 2, 3 or 4
 * @param {number} [options.pointFormat] 0-10
 * @param {number} [options.extraByteCount] padding appended to each record
 * @param {number[]} [options.scale]
 * @param {number[]} [options.offset]
 * @param {Array<object>} [options.points] see writePoint for the accepted fields
 * @param {Array<{userId: string, recordId: number, data: Uint8Array, description?: string}>} [options.vlrs]
 * @param {Array<{userId: string, recordId: number, data: Uint8Array, description?: string}>} [options.evlrs]
 * @param {boolean} [options.compressed] set the LASzip bit on the format byte
 * @param {boolean} [options.legacyCountsOnly] leave the 1.4 point count at zero
 * @param {number} [options.globalEncoding]
 * @returns {Uint8Array}
 */
export function buildLas (options = {}) {
  const {
    versionMinor = 2,
    pointFormat = 0,
    extraByteCount = 0,
    scale = [0.01, 0.01, 0.01],
    offset = [0, 0, 0],
    points = [],
    vlrs = [],
    evlrs = [],
    compressed = false,
    legacyCountsOnly = false,
    globalEncoding = 0
  } = options

  const format = POINT_FORMATS[pointFormat]
  const recordLength = format.byteLength + extraByteCount
  const headerSize = HEADER_SIZES[versionMinor]

  const vlrBytes = vlrs.map((vlr) => encodeRecord(vlr, 54))
  const vlrTotal = vlrBytes.reduce((sum, bytes) => sum + bytes.byteLength, 0)
  const offsetToPointData = headerSize + vlrTotal
  const pointsTotal = points.length * recordLength

  const evlrBytes = evlrs.map((evlr) => encodeRecord(evlr, 60))
  const evlrTotal = evlrBytes.reduce((sum, bytes) => sum + bytes.byteLength, 0)
  const startOfFirstEvlr = evlrs.length > 0 ? offsetToPointData + pointsTotal : 0

  const total = offsetToPointData + pointsTotal + evlrTotal
  const bytes = new Uint8Array(total)
  const view = new DataView(bytes.buffer)

  writeString(bytes, 0, 'LASF', 4)
  view.setUint16(4, 0, true) // file source id
  view.setUint16(6, globalEncoding, true)
  bytes[24] = 1
  bytes[25] = versionMinor
  writeString(bytes, 26, 'las-reader test suite', 32)
  writeString(bytes, 58, 'buildLas', 32)
  view.setUint16(90, 1, true) // day of year
  view.setUint16(92, 2026, true)
  view.setUint16(94, headerSize, true)
  view.setUint32(96, offsetToPointData, true)
  view.setUint32(100, vlrs.length, true)
  bytes[104] = pointFormat | (compressed ? 0x80 : 0)
  view.setUint16(105, recordLength, true)

  const legacyCount = versionMinor >= 4 && pointFormat > 5 ? 0 : points.length
  view.setUint32(107, legacyCountsOnly ? points.length : legacyCount, true)

  for (let axis = 0; axis < 3; axis++) {
    view.setFloat64(131 + axis * 8, scale[axis], true)
    view.setFloat64(155 + axis * 8, offset[axis], true)
  }

  const bounds = computeBounds(points, scale, offset)
  for (let axis = 0; axis < 3; axis++) {
    view.setFloat64(179 + axis * 16, bounds.max[axis], true)
    view.setFloat64(187 + axis * 16, bounds.min[axis], true)
  }

  if (versionMinor >= 3) {
    view.setBigUint64(227, 0n, true) // start of waveform data packet record
  }
  if (versionMinor >= 4) {
    view.setBigUint64(235, BigInt(startOfFirstEvlr), true)
    view.setUint32(243, evlrs.length, true)
    view.setBigUint64(247, legacyCountsOnly ? 0n : BigInt(points.length), true)
  }

  let cursor = headerSize
  for (const record of vlrBytes) {
    bytes.set(record, cursor)
    cursor += record.byteLength
  }

  for (const [index, point] of points.entries()) {
    writePoint(bytes, cursor + index * recordLength, point, format, recordLength)
  }
  cursor += pointsTotal

  for (const record of evlrBytes) {
    bytes.set(record, cursor)
    cursor += record.byteLength
  }

  return bytes
}

function computeBounds (points, scale, offset) {
  const max = [-Infinity, -Infinity, -Infinity]
  const min = [Infinity, Infinity, Infinity]
  for (const point of points) {
    const raw = [point.rawX ?? 0, point.rawY ?? 0, point.rawZ ?? 0]
    for (let axis = 0; axis < 3; axis++) {
      const value = raw[axis] * scale[axis] + offset[axis]
      if (value > max[axis]) max[axis] = value
      if (value < min[axis]) min[axis] = value
    }
  }
  for (let axis = 0; axis < 3; axis++) {
    if (!Number.isFinite(max[axis])) max[axis] = 0
    if (!Number.isFinite(min[axis])) min[axis] = 0
  }
  return { min, max }
}

function encodeRecord (record, headerLength) {
  const data = record.data ?? new Uint8Array()
  const bytes = new Uint8Array(headerLength + data.byteLength)
  const view = new DataView(bytes.buffer)
  view.setUint16(0, record.reserved ?? 0, true)
  writeString(bytes, 2, record.userId, 16)
  view.setUint16(18, record.recordId, true)
  if (headerLength === 54) {
    view.setUint16(20, data.byteLength, true)
    writeString(bytes, 22, record.description ?? '', 32)
  } else {
    view.setBigUint64(20, BigInt(data.byteLength), true)
    writeString(bytes, 28, record.description ?? '', 32)
  }
  bytes.set(data, headerLength)
  return bytes
}

function writePoint (bytes, at, point, format, recordLength) {
  const view = new DataView(bytes.buffer, bytes.byteOffset + at, recordLength)
  let cursor = 0
  view.setInt32(cursor, point.rawX ?? 0, true); cursor += 4
  view.setInt32(cursor, point.rawY ?? 0, true); cursor += 4
  view.setInt32(cursor, point.rawZ ?? 0, true); cursor += 4
  view.setUint16(cursor, point.intensity ?? 0, true); cursor += 2

  if (format.extended) {
    view.setUint8(cursor, ((point.returnNumber ?? 1) & 0b1111) | (((point.numberOfReturns ?? 1) & 0b1111) << 4))
    cursor += 1
    view.setUint8(cursor,
      (point.synthetic ? 0b1 : 0) |
      (point.keyPoint ? 0b10 : 0) |
      (point.withheld ? 0b100 : 0) |
      (point.overlap ? 0b1000 : 0) |
      (((point.scannerChannel ?? 0) & 0b11) << 4) |
      ((point.scanDirectionFlag ?? 0) << 6) |
      ((point.edgeOfFlightLine ?? 0) << 7))
    cursor += 1
    view.setUint8(cursor, point.classification ?? 0); cursor += 1
    view.setUint8(cursor, point.userData ?? 0); cursor += 1
    view.setInt16(cursor, point.scanAngleRaw ?? 0, true); cursor += 2
    view.setUint16(cursor, point.pointSourceId ?? 0, true); cursor += 2
  } else {
    view.setUint8(cursor, ((point.returnNumber ?? 1) & 0b111) |
      (((point.numberOfReturns ?? 1) & 0b111) << 3) |
      ((point.scanDirectionFlag ?? 0) << 6) |
      ((point.edgeOfFlightLine ?? 0) << 7))
    cursor += 1
    view.setUint8(cursor, ((point.classification ?? 0) & 0b11111) |
      (point.synthetic ? 0b100000 : 0) |
      (point.keyPoint ? 0b1000000 : 0) |
      (point.withheld ? 0b10000000 : 0))
    cursor += 1
    view.setInt8(cursor, point.scanAngleRaw ?? 0); cursor += 1
    view.setUint8(cursor, point.userData ?? 0); cursor += 1
    view.setUint16(cursor, point.pointSourceId ?? 0, true); cursor += 2
  }

  if (format.gpsTime) {
    view.setFloat64(cursor, point.gpsTime ?? 0, true); cursor += 8
  }
  if (format.color) {
    view.setUint16(cursor, point.red ?? 0, true); cursor += 2
    view.setUint16(cursor, point.green ?? 0, true); cursor += 2
    view.setUint16(cursor, point.blue ?? 0, true); cursor += 2
  }
  if (format.nir) {
    view.setUint16(cursor, point.nir ?? 0, true); cursor += 2
  }
  if (format.waveform) {
    const waveform = point.waveform ?? {}
    view.setUint8(cursor, waveform.descriptorIndex ?? 0); cursor += 1
    view.setBigUint64(cursor, BigInt(waveform.byteOffset ?? 0), true); cursor += 8
    view.setUint32(cursor, waveform.packetSize ?? 0, true); cursor += 4
    view.setFloat32(cursor, waveform.returnPointLocation ?? 0, true); cursor += 4
    view.setFloat32(cursor, waveform.xT ?? 0, true); cursor += 4
    view.setFloat32(cursor, waveform.yT ?? 0, true); cursor += 4
    view.setFloat32(cursor, waveform.zT ?? 0, true); cursor += 4
  }
  if (point.extraBytes) {
    bytes.set(point.extraBytes, at + cursor)
  }
}
