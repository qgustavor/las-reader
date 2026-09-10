import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import fs from 'node:fs'
import { HEADER_SIZES, parseHeader } from '../src/header.js'
import { LasFormatError, LasUnsupportedError } from '../src/errors.js'
import { buildLas } from './helpers/build-las.js'

const FIXTURE = new Uint8Array(
  fs.readFileSync(new URL('sample_data/Haystack_Rock.las', import.meta.url))
)

describe('parseHeader, checked-in fixture', () => {
  const header = parseHeader(FIXTURE)

  it('reads the signature and version', () => {
    assert.equal(header.signature, 'LASF')
    assert.deepEqual(header.version, { major: 1, minor: 2 })
    assert.equal(header.versionString, '1.2')
  })

  it('reads the identification strings', () => {
    assert.equal(header.systemIdentifier, 'LAStools (c) by rapidlasso GmbH')
    assert.equal(header.generatingSoftware, 'lasduplicate (160730) commercia')
  })

  it('reads the record layout', () => {
    assert.equal(header.headerSize, 227)
    assert.equal(header.offsetToPointData, 331)
    assert.equal(header.numberOfVariableLengthRecords, 1)
    assert.equal(header.pointDataRecordFormat, 0)
    assert.equal(header.pointDataRecordLength, 20)
    assert.equal(header.compressed, false)
  })

  it('reads the point count', () => {
    assert.equal(header.pointCount, 21932)
    assert.equal(header.legacyPointCount, 21932)
    assert.equal(header.pointCountByReturn.length, 5)
  })

  it('reads scale, offset and bounds', () => {
    assert.deepEqual(header.scale, [0.01, 0.01, 0.001])
    assert.deepEqual(header.offset, [2000000, 200000, -0])
    assert.deepEqual(header.bounds.max, [2231104.52, 252410.1, 80.815])
    assert.deepEqual(header.bounds.min, [2230738.84, 252070.78, -1.316])
  })

  it('decodes the global encoding bits', () => {
    assert.equal(header.globalEncoding.raw, 0)
    assert.equal(header.globalEncoding.adjustedStandardGpsTime, false)
    assert.equal(header.globalEncoding.wkt, false)
  })

  it('leaves the 1.3 and 1.4 fields at zero', () => {
    assert.equal(header.startOfWaveformDataPacketRecord, 0)
    assert.equal(header.startOfFirstEvlr, 0)
    assert.equal(header.numberOfEvlrs, 0)
  })

  it('agrees with the file size', () => {
    assert.equal(
      header.offsetToPointData + header.pointCount * header.pointDataRecordLength,
      FIXTURE.byteLength
    )
  })
})

describe('parseHeader, versions', () => {
  it('reads a 1.3 header, including the waveform offset', () => {
    const header = parseHeader(buildLas({ versionMinor: 3, pointFormat: 1, points: [{}] }))
    assert.equal(header.headerSize, HEADER_SIZES[3])
    assert.equal(header.startOfWaveformDataPacketRecord, 0)
  })

  it('reads a 1.4 header and prefers the 64-bit point count', () => {
    const points = Array.from({ length: 3 }, () => ({}))
    const header = parseHeader(buildLas({ versionMinor: 4, pointFormat: 6, points }))
    assert.equal(header.headerSize, HEADER_SIZES[4])
    assert.equal(header.pointCount, 3)
    assert.equal(header.legacyPointCount, 0)
    assert.equal(header.pointCountByReturn.length, 15)
  })

  it('falls back to the legacy count when a 1.4 writer left the new field at zero', () => {
    const points = Array.from({ length: 5 }, () => ({}))
    const header = parseHeader(buildLas({ versionMinor: 4, pointFormat: 1, points, legacyCountsOnly: true }))
    assert.equal(header.pointCount, 5)
  })

  it('flags the LASzip compression bit without losing the format id', () => {
    const header = parseHeader(buildLas({ pointFormat: 3, compressed: true, points: [{}] }))
    assert.equal(header.compressed, true)
    assert.equal(header.pointDataRecordFormat, 3)
    assert.equal(header.pointDataRecordFormatRaw, 3 | 0x80)
  })
})

describe('parseHeader, malformed input', () => {
  function corrupt (mutate, options) {
    const bytes = buildLas({ points: [{}], ...options })
    mutate(bytes, new DataView(bytes.buffer))
    return bytes
  }

  it('rejects a file that does not start with LASF', () => {
    assert.throws(() => parseHeader(corrupt((bytes) => { bytes[0] = 0x50 })), (error) => {
      assert.ok(error instanceof LasFormatError)
      assert.equal(error.offset, 0)
      return true
    })
  })

  it('rejects an unsupported version', () => {
    assert.throws(() => parseHeader(corrupt((bytes) => { bytes[25] = 9 })), LasUnsupportedError)
    assert.throws(() => parseHeader(corrupt((bytes) => { bytes[24] = 2 })), LasUnsupportedError)
  })

  it('rejects an undefined point format', () => {
    assert.throws(() => parseHeader(corrupt((bytes) => { bytes[104] = 11 })), LasUnsupportedError)
  })

  it('rejects a point format the claimed version predates', () => {
    // Format 6 needs LAS 1.4; this header says 1.2.
    assert.throws(
      () => parseHeader(corrupt((bytes) => { bytes[104] = 6 })),
      (error) => error instanceof LasFormatError && /introduced in LAS 1\.4/.test(error.message)
    )
  })

  it('rejects a record length shorter than the format needs', () => {
    assert.throws(
      () => parseHeader(corrupt((_bytes, view) => view.setUint16(105, 12, true))),
      (error) => error instanceof LasFormatError && error.offset === 105
    )
  })

  it('rejects a header size smaller than the version allows', () => {
    assert.throws(
      () => parseHeader(corrupt((_bytes, view) => view.setUint16(94, 100, true))),
      (error) => error instanceof LasFormatError && /too small/.test(error.message)
    )
  })

  it('rejects point data that would start inside the header', () => {
    assert.throws(
      () => parseHeader(corrupt((_bytes, view) => view.setUint32(96, 100, true))),
      (error) => error instanceof LasFormatError && /overlaps/.test(error.message)
    )
  })

  it('rejects a zero scale factor', () => {
    assert.throws(
      () => parseHeader(corrupt((_bytes, view) => view.setFloat64(131, 0, true))),
      (error) => error instanceof LasFormatError && /non-zero/.test(error.message)
    )
  })

  it('rejects a truncated header instead of reading past the end', () => {
    const bytes = buildLas({ points: [{}] }).subarray(0, 120)
    assert.throws(() => parseHeader(bytes), LasFormatError)
  })

  it('refuses a point count that cannot be represented exactly', () => {
    const bytes = buildLas({ versionMinor: 4, pointFormat: 6, points: [{}] })
    new DataView(bytes.buffer).setBigUint64(247, 2n ** 60n, true)
    assert.throws(
      () => parseHeader(bytes),
      (error) => error instanceof LasFormatError && /number of point records/.test(error.message)
    )
  })
})
