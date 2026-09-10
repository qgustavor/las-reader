import { LasUnsupportedError } from './errors.js'

/**
 * Size in bytes of the waveform packet block appended to formats 4, 5, 9
 * and 10.
 */
const WAVE_PACKET_BYTES = 29

/**
 * Every point data record format defined by LAS 1.0 through 1.4.
 *
 * `extended` marks formats 6-10, which rearrange the bit fields, widen the
 * return numbers to four bits, promote classification to a full byte and store
 * the scan angle as a signed 16-bit count of 0.006 degree steps.
 *
 * @type {Record<number, {
 *   id: number, byteLength: number, extended: boolean, gpsTime: boolean,
 *   color: boolean, nir: boolean, waveform: boolean, minVersionMinor: number
 * }>}
 */
export const POINT_FORMATS = Object.freeze(Object.fromEntries([
  { id: 0, byteLength: 20, extended: false, gpsTime: false, color: false, nir: false, waveform: false, minVersionMinor: 0 },
  { id: 1, byteLength: 28, extended: false, gpsTime: true, color: false, nir: false, waveform: false, minVersionMinor: 0 },
  { id: 2, byteLength: 26, extended: false, gpsTime: false, color: true, nir: false, waveform: false, minVersionMinor: 2 },
  { id: 3, byteLength: 34, extended: false, gpsTime: true, color: true, nir: false, waveform: false, minVersionMinor: 2 },
  { id: 4, byteLength: 57, extended: false, gpsTime: true, color: false, nir: false, waveform: true, minVersionMinor: 3 },
  { id: 5, byteLength: 63, extended: false, gpsTime: true, color: true, nir: false, waveform: true, minVersionMinor: 3 },
  { id: 6, byteLength: 30, extended: true, gpsTime: true, color: false, nir: false, waveform: false, minVersionMinor: 4 },
  { id: 7, byteLength: 36, extended: true, gpsTime: true, color: true, nir: false, waveform: false, minVersionMinor: 4 },
  { id: 8, byteLength: 38, extended: true, gpsTime: true, color: true, nir: true, waveform: false, minVersionMinor: 4 },
  { id: 9, byteLength: 59, extended: true, gpsTime: true, color: false, nir: false, waveform: true, minVersionMinor: 4 },
  { id: 10, byteLength: 67, extended: true, gpsTime: true, color: true, nir: true, waveform: true, minVersionMinor: 4 }
].map((format) => [format.id, Object.freeze(format)])))

/** Scan angle unit for formats 6-10, in degrees. */
export const EXTENDED_SCAN_ANGLE_STEP = 0.006

/**
 * @param {number} id
 * @returns {typeof POINT_FORMATS[number]}
 */
export function getPointFormat (id) {
  const format = POINT_FORMATS[id]
  if (!format) {
    throw new LasUnsupportedError(
      `point data record format ${id} is not defined by any LAS version (0-10 are)`
    )
  }
  return format
}

/**
 * Decodes one point record.
 *
 * The reader must be positioned at the start of the record and cover at least
 * `recordLength` bytes; anything past the format's own fields is handed back
 * untouched as `extraBytes`.
 *
 * @param {import('./binary-reader.js').BinaryReader} reader
 * @param {typeof POINT_FORMATS[number]} format
 * @param {{ scale: number[], offset: number[] }} header
 * @param {number} recordLength
 * @param {object} [target] object to write into, for reuse across a hot loop
 */
export function decodePoint (reader, format, header, recordLength, target = {}) {
  const start = reader.offset
  const { scale, offset } = header

  const rawX = reader.i32()
  const rawY = reader.i32()
  const rawZ = reader.i32()

  target.rawX = rawX
  target.rawY = rawY
  target.rawZ = rawZ
  target.x = rawX * scale[0] + offset[0]
  target.y = rawY * scale[1] + offset[1]
  target.z = rawZ * scale[2] + offset[2]
  target.intensity = reader.u16()

  if (format.extended) {
    const returns = reader.u8()
    target.returnNumber = returns & 0b1111
    target.numberOfReturns = (returns >> 4) & 0b1111

    const flags = reader.u8()
    target.synthetic = (flags & 0b1) !== 0
    target.keyPoint = (flags & 0b10) !== 0
    target.withheld = (flags & 0b100) !== 0
    target.overlap = (flags & 0b1000) !== 0
    target.scannerChannel = (flags >> 4) & 0b11
    target.scanDirectionFlag = (flags >> 6) & 0b1
    target.edgeOfFlightLine = (flags >> 7) & 0b1

    target.classification = reader.u8()
    target.userData = reader.u8()
    target.scanAngleRaw = reader.i16()
    target.scanAngle = target.scanAngleRaw * EXTENDED_SCAN_ANGLE_STEP
    target.pointSourceId = reader.u16()
  } else {
    const returns = reader.u8()
    target.returnNumber = returns & 0b111
    target.numberOfReturns = (returns >> 3) & 0b111
    target.scanDirectionFlag = (returns >> 6) & 0b1
    target.edgeOfFlightLine = (returns >> 7) & 0b1

    const classification = reader.u8()
    target.classification = classification & 0b11111
    target.synthetic = (classification & 0b100000) !== 0
    target.keyPoint = (classification & 0b1000000) !== 0
    target.withheld = (classification & 0b10000000) !== 0
    // Formats 0-5 have no overlap flag; class 12 is the conventional stand-in.
    target.overlap = target.classification === 12
    target.scannerChannel = 0

    target.scanAngleRaw = reader.i8()
    target.scanAngle = target.scanAngleRaw
    target.userData = reader.u8()
    target.pointSourceId = reader.u16()
  }

  target.gpsTime = format.gpsTime ? reader.f64() : undefined

  if (format.color) {
    target.red = reader.u16()
    target.green = reader.u16()
    target.blue = reader.u16()
  } else {
    target.red = undefined
    target.green = undefined
    target.blue = undefined
  }

  target.nir = format.nir ? reader.u16() : undefined

  if (format.waveform) {
    target.waveform = {
      descriptorIndex: reader.u8(),
      byteOffset: reader.u64AsNumber('waveform byte offset'),
      packetSize: reader.u32(),
      returnPointLocation: reader.f32(),
      xT: reader.f32(),
      yT: reader.f32(),
      zT: reader.f32()
    }
  } else {
    target.waveform = undefined
  }

  const consumed = reader.offset - start
  target.extraBytes = recordLength > consumed
    ? reader.bytes(recordLength - consumed)
    : undefined

  return target
}

export { WAVE_PACKET_BYTES }
