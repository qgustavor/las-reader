import { BinaryReader } from './binary-reader.js'
import { LasFormatError, LasUnsupportedError } from './errors.js'
import { getPointFormat } from './point-format.js'

export const FILE_SIGNATURE = 'LASF'

/** Minimum public header block size for each minor version. */
export const HEADER_SIZES = Object.freeze({ 0: 227, 1: 227, 2: 227, 3: 235, 4: 375 })

/** Largest header any supported version defines; enough to read every field. */
export const MAX_HEADER_SIZE = 375

/**
 * Bit 7 of the point data record format byte marks a LASzip-compressed file.
 * Bits 6 and 7 are both used in the wild, so the top two bits are masked off.
 */
const COMPRESSION_MASK = 0b11000000
const FORMAT_MASK = 0b00111111

function decodeGlobalEncoding (raw) {
  return Object.freeze({
    raw,
    /** false: GPS week time, true: adjusted standard GPS time */
    adjustedStandardGpsTime: (raw & 0b1) !== 0,
    waveformDataInternal: (raw & 0b10) !== 0,
    waveformDataExternal: (raw & 0b100) !== 0,
    syntheticReturnNumbers: (raw & 0b1000) !== 0,
    /** true when the CRS is given as WKT rather than GeoTIFF keys */
    wkt: (raw & 0b10000) !== 0
  })
}

function formatProjectId (data1, data2, data3, data4) {
  const hex = (value, width) => value.toString(16).padStart(width, '0')
  const tail = [...data4].map((byte) => hex(byte, 2)).join('')
  return `${hex(data1, 8)}-${hex(data2, 4)}-${hex(data3, 4)}-${tail.slice(0, 4)}-${tail.slice(4)}`
}

/**
 * Parses the public header block.
 *
 * @param {Uint8Array} bytes at least the first `headerSize` bytes of the file
 * @returns {LasHeader}
 */
export function parseHeader (bytes) {
  const reader = new BinaryReader(bytes)

  const signature = reader.string(4)
  if (signature !== FILE_SIGNATURE) {
    throw new LasFormatError(
      `not a LAS file: expected the signature ${FILE_SIGNATURE}, found ${JSON.stringify(signature)}`,
      { offset: 0 }
    )
  }

  const fileSourceId = reader.u16()
  const globalEncoding = decodeGlobalEncoding(reader.u16())
  const projectId = formatProjectId(reader.u32(), reader.u16(), reader.u16(), reader.bytes(8))

  const versionMajor = reader.u8()
  const versionMinor = reader.u8()
  if (versionMajor !== 1 || HEADER_SIZES[versionMinor] === undefined) {
    throw new LasUnsupportedError(
      `unsupported LAS version ${versionMajor}.${versionMinor}; this library reads 1.0 through 1.4`
    )
  }

  const systemIdentifier = reader.string(32)
  const generatingSoftware = reader.string(32)
  const fileCreationDayOfYear = reader.u16()
  const fileCreationYear = reader.u16()
  const headerSize = reader.u16()
  const offsetToPointData = reader.u32()
  const numberOfVariableLengthRecords = reader.u32()

  const pointDataRecordFormatRaw = reader.u8()
  const pointDataRecordFormat = pointDataRecordFormatRaw & FORMAT_MASK
  const compressed = (pointDataRecordFormatRaw & COMPRESSION_MASK) !== 0
  const pointDataRecordLength = reader.u16()

  const legacyPointCount = reader.u32()
  const legacyPointCountByReturn = Array.from({ length: 5 }, () => reader.u32())

  const scale = [reader.f64(), reader.f64(), reader.f64()]
  const offset = [reader.f64(), reader.f64(), reader.f64()]
  const max = [0, 0, 0]
  const min = [0, 0, 0]
  for (let axis = 0; axis < 3; axis++) {
    max[axis] = reader.f64()
    min[axis] = reader.f64()
  }

  let startOfWaveformDataPacketRecord = 0
  let startOfFirstEvlr = 0
  let numberOfEvlrs = 0
  let pointCount = legacyPointCount
  let pointCountByReturn = legacyPointCountByReturn

  if (versionMinor >= 3 && headerSize >= HEADER_SIZES[3]) {
    startOfWaveformDataPacketRecord = reader.u64AsNumber('start of waveform data packet record')
  }

  if (versionMinor >= 4 && headerSize >= HEADER_SIZES[4]) {
    startOfFirstEvlr = reader.u64AsNumber('start of first extended variable length record')
    numberOfEvlrs = reader.u32()
    const extendedPointCount = reader.u64AsNumber('number of point records')
    const extendedByReturn = Array.from({ length: 15 }, (_, index) =>
      reader.u64AsNumber(`number of points by return ${index + 1}`))
    // Writers that only fill the legacy fields are common enough that falling
    // back is worth it; the spec requires the 1.4 fields to win when set.
    if (extendedPointCount > 0 || legacyPointCount === 0) {
      pointCount = extendedPointCount
      pointCountByReturn = extendedByReturn
    }
  }

  const header = {
    signature,
    fileSourceId,
    globalEncoding,
    projectId,
    version: { major: versionMajor, minor: versionMinor },
    versionString: `${versionMajor}.${versionMinor}`,
    systemIdentifier,
    generatingSoftware,
    fileCreationDayOfYear,
    fileCreationYear,
    headerSize,
    offsetToPointData,
    numberOfVariableLengthRecords,
    pointDataRecordFormat,
    pointDataRecordFormatRaw,
    compressed,
    pointDataRecordLength,
    legacyPointCount,
    legacyPointCountByReturn,
    pointCount,
    pointCountByReturn,
    scale,
    offset,
    bounds: { min, max },
    startOfWaveformDataPacketRecord,
    startOfFirstEvlr,
    numberOfEvlrs
  }

  validateHeader(header)
  return header
}

/**
 * Checks the header against itself and against the LAS specification. Called by
 * parseHeader; exported so that a caller can re-check a header it built.
 *
 * @param {LasHeader} header
 */
export function validateHeader (header) {
  const { version, headerSize, offsetToPointData, pointDataRecordFormat } = header
  const minimum = HEADER_SIZES[version.minor]

  if (headerSize < minimum) {
    throw new LasFormatError(
      `header size ${headerSize} is too small for LAS ${header.versionString}, which needs ${minimum}`,
      { offset: 94 }
    )
  }
  if (offsetToPointData < headerSize) {
    throw new LasFormatError(
      `offset to point data ${offsetToPointData} overlaps the ${headerSize} byte header`,
      { offset: 96 }
    )
  }

  const format = getPointFormat(pointDataRecordFormat)
  if (version.minor < format.minVersionMinor) {
    throw new LasFormatError(
      `point data record format ${format.id} was introduced in LAS 1.${format.minVersionMinor}, ` +
      `but this file claims to be LAS ${header.versionString}`,
      { offset: 104 }
    )
  }
  if (header.pointDataRecordLength < format.byteLength) {
    throw new LasFormatError(
      `point data record length ${header.pointDataRecordLength} is shorter than the ` +
      `${format.byteLength} bytes required by format ${format.id}`,
      { offset: 105 }
    )
  }
  if (header.scale.some((value) => value === 0 || !Number.isFinite(value))) {
    throw new LasFormatError(`scale factors must be finite and non-zero, got [${header.scale}]`, { offset: 131 })
  }

  return header
}

/**
 * Size in bytes of the point data block described by this header.
 * @param {LasHeader} header
 */
export function pointDataByteLength (header) {
  return header.pointCount * header.pointDataRecordLength
}

/**
 * @typedef {ReturnType<typeof parseHeader>} LasHeader
 */
