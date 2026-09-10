import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import fs from 'node:fs'
import { LasFormatError } from '../src/errors.js'
import { parseHeader } from '../src/header.js'
import { findRecord, parseEvlrs, parseVlrs, readRecords, EVLR_HEADER_BYTES, VLR_HEADER_BYTES } from '../src/vlr.js'
import { LasReader, bytesSource } from '../src/index.js'
import { buildLas } from './helpers/build-las.js'

const FIXTURE = new Uint8Array(
  fs.readFileSync(new URL('sample_data/Haystack_Rock.las', import.meta.url))
)

describe('parseVlrs', () => {
  it('reads the GeoKeyDirectory from the checked-in fixture', () => {
    const header = parseHeader(FIXTURE)
    const vlrs = parseVlrs(
      FIXTURE.subarray(header.headerSize, header.offsetToPointData),
      header.numberOfVariableLengthRecords,
      header.headerSize
    )

    assert.equal(vlrs.length, 1)
    const [record] = vlrs
    assert.equal(record.reserved, 43707)
    assert.equal(record.userId, 'LASF_Projection')
    assert.equal(record.recordId, 34735)
    assert.equal(record.description, 'Projection Parameters')
    assert.equal(record.data.byteLength, 48)
    assert.equal(record.byteLength, VLR_HEADER_BYTES + 48)
    assert.equal(record.fileOffset, 227)
    assert.equal(record.extended, false)
  })

  it('reads several records laid end to end', () => {
    const bytes = buildLas({
      points: [{}],
      vlrs: [
        { userId: 'first', recordId: 1, data: Uint8Array.from([1, 2, 3]) },
        { userId: 'second', recordId: 2, data: Uint8Array.from([4]) },
        { userId: 'third', recordId: 3, data: new Uint8Array() }
      ]
    })
    const header = parseHeader(bytes)
    const vlrs = parseVlrs(
      bytes.subarray(header.headerSize, header.offsetToPointData), 3, header.headerSize
    )
    assert.deepEqual(vlrs.map((record) => record.userId), ['first', 'second', 'third'])
    assert.deepEqual(vlrs.map((record) => record.data.byteLength), [3, 1, 0])
    assert.equal(vlrs[1].fileOffset, header.headerSize + VLR_HEADER_BYTES + 3)
  })

  it('stops early when the header overstates the record count', () => {
    const bytes = buildLas({ points: [{}], vlrs: [{ userId: 'only', recordId: 1, data: Uint8Array.from([1]) }] })
    const header = parseHeader(bytes)
    const vlrs = parseVlrs(bytes.subarray(header.headerSize, header.offsetToPointData), 99, header.headerSize)
    assert.equal(vlrs.length, 1)
  })

  it('throws when a record declares a payload that runs off the end', () => {
    const bytes = buildLas({ points: [{}], vlrs: [{ userId: 'liar', recordId: 1, data: Uint8Array.from([1]) }] })
    const header = parseHeader(bytes)
    const region = bytes.subarray(header.headerSize, header.offsetToPointData)
    new DataView(region.buffer, region.byteOffset).setUint16(20, 5000, true)
    assert.throws(
      () => parseVlrs(region, 1, header.headerSize),
      (error) => error instanceof LasFormatError && /only \d+ are left/.test(error.message)
    )
  })
})

describe('parseEvlrs', () => {
  it('reads extended records from the end of a 1.4 file', () => {
    const wkt = 'PROJCS["fake",AUTHORITY["EPSG","32610"]]'
    const bytes = buildLas({
      versionMinor: 4,
      pointFormat: 6,
      points: [{}, {}],
      evlrs: [
        { userId: 'LASF_Projection', recordId: 2112, data: new TextEncoder().encode(wkt) },
        { userId: 'custom', recordId: 7, data: Uint8Array.from([1, 2]) }
      ]
    })
    const header = parseHeader(bytes)
    assert.equal(header.numberOfEvlrs, 2)
    assert.ok(header.startOfFirstEvlr > 0)

    const evlrs = parseEvlrs(
      bytes.subarray(header.startOfFirstEvlr), header.numberOfEvlrs, header.startOfFirstEvlr
    )
    assert.equal(evlrs.length, 2)
    assert.equal(evlrs[0].extended, true)
    assert.equal(new TextDecoder().decode(evlrs[0].data), wkt)
    assert.equal(evlrs[0].byteLength, EVLR_HEADER_BYTES + wkt.length)
    assert.equal(evlrs[1].recordId, 7)
  })

  it('reads a payload larger than a VLR could hold', () => {
    const big = new Uint8Array(70000).fill(0xab)
    const bytes = buildLas({
      versionMinor: 4,
      pointFormat: 6,
      points: [{}],
      evlrs: [{ userId: 'big', recordId: 1, data: big }]
    })
    const header = parseHeader(bytes)
    const [record] = parseEvlrs(bytes.subarray(header.startOfFirstEvlr), 1, header.startOfFirstEvlr)
    assert.equal(record.data.byteLength, 70000)
    assert.equal(record.data.at(-1), 0xab)
  })

  it('refuses a payload length that cannot be represented exactly', () => {
    const bytes = buildLas({
      versionMinor: 4, pointFormat: 6, points: [{}], evlrs: [{ userId: 'x', recordId: 1, data: Uint8Array.from([1]) }]
    })
    const header = parseHeader(bytes)
    new DataView(bytes.buffer).setBigUint64(header.startOfFirstEvlr + 20, 2n ** 62n, true)
    assert.throws(
      () => parseEvlrs(bytes.subarray(header.startOfFirstEvlr), 1, header.startOfFirstEvlr),
      LasFormatError
    )
  })
})

describe('findRecord', () => {
  it('matches on user id and record id together', () => {
    const records = [
      { userId: 'LASF_Projection', recordId: 34735 },
      { userId: 'LASF_Spec', recordId: 4 }
    ]
    assert.equal(findRecord(records, 'LASF_Spec', 4).recordId, 4)
    assert.equal(findRecord(records, 'LASF_Spec', 34735), undefined)
    assert.equal(findRecord(records, 'nope', 4), undefined)
  })
})

describe('readRecords, incremental', () => {
  it('reads records without buffering the region they live in', async () => {
    const bytes = buildLas({
      versionMinor: 4,
      pointFormat: 6,
      points: [{}],
      evlrs: [
        { userId: 'first', recordId: 1, data: Uint8Array.from([1, 2, 3]) },
        { userId: 'second', recordId: 2, data: Uint8Array.from([4]) }
      ]
    })
    const header = parseHeader(bytes)

    let bytesRead = 0
    const source = {
      byteLength: bytes.byteLength,
      async read (offset, length) {
        bytesRead += length
        return bytes.subarray(offset, offset + length)
      }
    }

    const records = await readRecords(
      source, header.startOfFirstEvlr, bytes.byteLength, 2, { extended: true }
    )
    assert.deepEqual(records.map((record) => record.userId), ['first', 'second'])
    assert.deepEqual([...records[0].data], [1, 2, 3])
    assert.equal(bytesRead, EVLR_HEADER_BYTES * 2 + 4, 'only the headers and their payloads')
  })

  it('leaves an oversized payload unread but locatable', async () => {
    const bytes = buildLas({
      versionMinor: 4,
      pointFormat: 6,
      points: [{}],
      evlrs: [{ userId: 'waveform', recordId: 65535, data: new Uint8Array(4096).fill(7) }]
    })
    const header = parseHeader(bytes)
    const source = bytesSource(bytes)

    const [record] = await readRecords(
      source, header.startOfFirstEvlr, bytes.byteLength, 1, { extended: true, maxPayload: 64 }
    )
    assert.equal(record.data, null)
    assert.equal(record.dataLength, 4096)
    assert.equal(record.dataOffset, header.startOfFirstEvlr + EVLR_HEADER_BYTES)

    const reader = await LasReader.open(source, { maxRecordPayload: 64 })
    const fetched = await reader.readRecordData(reader.evlrs[0])
    assert.equal(fetched.byteLength, 4096)
    assert.equal(fetched[0], 7)
  })

  it('does not read the tail of the file to find the records at its end', async () => {
    // 8 MiB of point data followed by one small EVLR: opening the file should
    // not touch the point block.
    const points = Array.from({ length: 400_000 }, (_, index) => ({ rawX: index }))
    const bytes = buildLas({
      versionMinor: 4,
      pointFormat: 6,
      points,
      evlrs: [{ userId: 'tiny', recordId: 1, data: Uint8Array.from([9]) }]
    })

    let bytesRead = 0
    const source = {
      byteLength: bytes.byteLength,
      async read (offset, length) {
        bytesRead += length
        return bytes.subarray(offset, offset + length)
      }
    }

    const reader = await LasReader.open(source)
    assert.equal(reader.evlrs.length, 1)
    assert.ok(bytesRead < 4096, `opening read ${bytesRead} bytes of a ${bytes.byteLength} byte file`)
    assert.equal(reader.pointCount, 400_000)
  })
})
