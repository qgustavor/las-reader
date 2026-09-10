import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import fs from 'node:fs'
import { BinaryReader } from '../src/binary-reader.js'
import { LasUnsupportedError } from '../src/errors.js'
import { getPointFormat, POINT_FORMATS, decodePoint } from '../src/point-format.js'
import { parseHeader } from '../src/header.js'
import { buildLas } from './helpers/build-las.js'

const SPEC_SIZES = { 0: 20, 1: 28, 2: 26, 3: 34, 4: 57, 5: 63, 6: 30, 7: 36, 8: 38, 9: 59, 10: 67 }

function decodeFirstPoint (options) {
  const bytes = buildLas(options)
  const header = parseHeader(bytes)
  const format = getPointFormat(header.pointDataRecordFormat)
  const reader = new BinaryReader(
    bytes.subarray(header.offsetToPointData, header.offsetToPointData + header.pointDataRecordLength)
  )
  return decodePoint(reader, format, header, header.pointDataRecordLength)
}

describe('point formats', () => {
  it('matches the record lengths in the specification', () => {
    for (const [id, byteLength] of Object.entries(SPEC_SIZES)) {
      assert.equal(POINT_FORMATS[id].byteLength, byteLength, `format ${id}`)
    }
    assert.equal(Object.keys(POINT_FORMATS).length, 11)
  })

  it('rejects formats outside 0-10', () => {
    assert.throws(() => getPointFormat(11), LasUnsupportedError)
    assert.throws(() => getPointFormat(-1), LasUnsupportedError)
  })

  it('consumes exactly the record length for every format', () => {
    for (const id of Object.keys(SPEC_SIZES).map(Number)) {
      const versionMinor = id > 5 ? 4 : id > 3 ? 3 : 2
      const bytes = buildLas({ versionMinor, pointFormat: id, points: [{ rawX: 1 }] })
      const header = parseHeader(bytes)
      const reader = new BinaryReader(bytes.subarray(header.offsetToPointData))
      decodePoint(reader, getPointFormat(id), header, header.pointDataRecordLength)
      assert.equal(reader.offset, SPEC_SIZES[id], `format ${id}`)
    }
  })
})

describe('decodePoint, legacy formats 0-5', () => {
  it('applies scale and offset', () => {
    const point = decodeFirstPoint({
      scale: [0.01, 0.01, 0.001],
      offset: [2000000, 200000, 0],
      points: [{ rawX: 23084422, rawY: 5208093, rawZ: -26 }]
    })
    assert.deepEqual([point.rawX, point.rawY, point.rawZ], [23084422, 5208093, -26])
    assert.equal(point.x, 2230844.22)
    assert.equal(point.y, 252080.93)
    assert.ok(Math.abs(point.z - -0.026) < 1e-9)
  })

  it('decodes the return bit field in specification order', () => {
    const point = decodeFirstPoint({
      points: [{ returnNumber: 3, numberOfReturns: 5, scanDirectionFlag: 1, edgeOfFlightLine: 1 }]
    })
    assert.equal(point.returnNumber, 3)
    assert.equal(point.numberOfReturns, 5)
    assert.equal(point.scanDirectionFlag, 1)
    assert.equal(point.edgeOfFlightLine, 1)
  })

  it('separates classification from its flag bits', () => {
    const point = decodeFirstPoint({
      points: [{ classification: 2, synthetic: true, withheld: true }]
    })
    assert.equal(point.classification, 2)
    assert.equal(point.synthetic, true)
    assert.equal(point.keyPoint, false)
    assert.equal(point.withheld, true)
  })

  it('reads intensity little-endian', () => {
    assert.equal(decodeFirstPoint({ points: [{ intensity: 0x1234 }] }).intensity, 0x1234)
  })

  it('reads the scan angle rank as signed degrees', () => {
    assert.equal(decodeFirstPoint({ points: [{ scanAngleRaw: -90 }] }).scanAngle, -90)
  })

  it('reads gps time for format 1', () => {
    const point = decodeFirstPoint({ pointFormat: 1, points: [{ gpsTime: 123456.789 }] })
    assert.equal(point.gpsTime, 123456.789)
    assert.equal(point.red, undefined)
  })

  it('reads colour for format 3', () => {
    const point = decodeFirstPoint({
      pointFormat: 3,
      points: [{ gpsTime: 1, red: 65535, green: 256, blue: 7 }]
    })
    assert.deepEqual([point.red, point.green, point.blue], [65535, 256, 7])
    assert.equal(point.nir, undefined)
  })

  it('reads the waveform block for format 4', () => {
    const point = decodeFirstPoint({
      versionMinor: 3,
      pointFormat: 4,
      points: [{ waveform: { descriptorIndex: 3, byteOffset: 4294967296, packetSize: 120, returnPointLocation: 0.5, xT: 1, yT: 2, zT: 3 } }]
    })
    assert.equal(point.waveform.descriptorIndex, 3)
    assert.equal(point.waveform.byteOffset, 4294967296)
    assert.equal(point.waveform.packetSize, 120)
    assert.deepEqual(
      [point.waveform.returnPointLocation, point.waveform.xT, point.waveform.yT, point.waveform.zT],
      [0.5, 1, 2, 3]
    )
  })
})

describe('decodePoint, extended formats 6-10', () => {
  it('reads four-bit return numbers', () => {
    const point = decodeFirstPoint({
      versionMinor: 4,
      pointFormat: 6,
      points: [{ returnNumber: 9, numberOfReturns: 12 }]
    })
    assert.equal(point.returnNumber, 9)
    assert.equal(point.numberOfReturns, 12)
  })

  it('reads the full classification byte', () => {
    const point = decodeFirstPoint({
      versionMinor: 4,
      pointFormat: 6,
      points: [{ classification: 200 }]
    })
    assert.equal(point.classification, 200)
  })

  it('reads the flag byte, including overlap and scanner channel', () => {
    const point = decodeFirstPoint({
      versionMinor: 4,
      pointFormat: 6,
      points: [{ overlap: true, keyPoint: true, scannerChannel: 3, edgeOfFlightLine: 1 }]
    })
    assert.equal(point.overlap, true)
    assert.equal(point.keyPoint, true)
    assert.equal(point.synthetic, false)
    assert.equal(point.scannerChannel, 3)
    assert.equal(point.edgeOfFlightLine, 1)
  })

  it('converts the scan angle from 0.006 degree steps', () => {
    const point = decodeFirstPoint({
      versionMinor: 4,
      pointFormat: 6,
      points: [{ scanAngleRaw: -5000 }]
    })
    assert.equal(point.scanAngleRaw, -5000)
    assert.ok(Math.abs(point.scanAngle - -30) < 1e-9)
  })

  it('reads near infrared for format 8', () => {
    const point = decodeFirstPoint({
      versionMinor: 4,
      pointFormat: 8,
      points: [{ red: 1, green: 2, blue: 3, nir: 4095 }]
    })
    assert.equal(point.nir, 4095)
  })
})

describe('decodePoint, extra bytes', () => {
  it('hands back trailing bytes untouched', () => {
    const point = decodeFirstPoint({
      extraByteCount: 4,
      points: [{ extraBytes: Uint8Array.from([9, 8, 7, 6]) }]
    })
    assert.deepEqual([...point.extraBytes], [9, 8, 7, 6])
  })

  it('leaves extraBytes undefined when the record has none', () => {
    assert.equal(decodeFirstPoint({ points: [{}] }).extraBytes, undefined)
  })
})

describe('decodePoint, against the checked-in fixture', () => {
  it('agrees with the bytes of Haystack_Rock.las', () => {
    const bytes = new Uint8Array(fs.readFileSync(new URL('sample_data/Haystack_Rock.las', import.meta.url)))
    const header = parseHeader(bytes)
    const format = getPointFormat(header.pointDataRecordFormat)
    const reader = new BinaryReader(bytes.subarray(header.offsetToPointData))
    const point = decodePoint(reader, format, header, header.pointDataRecordLength)

    assert.deepEqual([point.rawX, point.rawY, point.rawZ], [23084422, 5208093, -26])
    assert.equal(point.x, 2230844.22)
    // The legacy reader reported return 0 of 2 with edge_of_flight_line set.
    assert.equal(point.returnNumber, 1)
    assert.equal(point.numberOfReturns, 1)
    assert.equal(point.scanDirectionFlag, 0)
    assert.equal(point.edgeOfFlightLine, 0)
    assert.equal(point.classification, 0)
    assert.equal(point.overlap, false)
  })
})
