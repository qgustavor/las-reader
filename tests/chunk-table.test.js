import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import fs from 'node:fs'
import { bytesSource } from '../src/byte-source.js'
import { LasFormatError, LasUnsupportedError } from '../src/errors.js'
import { parseHeader } from '../src/header.js'
import { parseRecords } from '../src/vlr.js'
import { findLaszipVlr } from '../src/laz/laszip-vlr.js'
import {
  chunkForPoint,
  chunksForRange,
  decodeChunkTable,
  readChunkTable
} from '../src/laz/chunk-table.js'
import { buildChunkTable, buildChunkedLaz } from './helpers/build-laz.js'

const LAZ_PATH = new URL('sample_data/point-time-1.4.las.laz', import.meta.url)

/** Opens a LAZ byte array far enough to read its chunk table. */
async function openTable (bytes) {
  const header = parseHeader(bytes)
  const vlrs = parseRecords(
    bytes.subarray(header.headerSize, header.offsetToPointData),
    header.numberOfVariableLengthRecords,
    { origin: header.headerSize }
  )
  const vlr = findLaszipVlr(vlrs)
  return { header, vlr, table: await readChunkTable(bytesSource(bytes), header, vlr) }
}

describe('chunk table, on a file LASzip wrote', () => {
  const bytes = new Uint8Array(fs.readFileSync(LAZ_PATH))

  it('decodes sizes that account for exactly the compressed byte range', async () => {
    const { table } = await openTable(bytes)

    // This is the check that says the arithmetic decoder agrees with LASzip
    // rather than merely with itself: the sizes are deltas from an adaptive
    // model, and a decoder that is even slightly wrong produces numbers that
    // look plausible but do not add up.
    const total = table.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
    assert.equal(total, table.compressedByteLength)
    assert.equal(table.chunks.at(-1).offset + table.chunks.at(-1).byteLength, table.tableOffset)
  })

  it('reports the layout the file actually has', async () => {
    const { header, table } = await openTable(bytes)
    assert.equal(table.version, 0)
    assert.equal(table.chunkCount, 1)
    assert.equal(table.variableChunks, false)
    assert.equal(table.pointsPerChunk, 50000)
    assert.equal(table.firstChunkOffset, header.offsetToPointData + 8)
    assert.equal(
      table.chunks.reduce((sum, chunk) => sum + chunk.pointCount, 0),
      header.pointCount
    )
  })

  it('reads the table without reading the whole file', async () => {
    const { header, vlr } = await openTable(bytes)
    const reads = []
    const counting = {
      byteLength: bytes.byteLength,
      async read (offset, length) {
        reads.push(length)
        return bytes.subarray(offset, offset + length)
      }
    }
    await readChunkTable(counting, header, vlr)
    assert.ok(
      reads.every((length) => length < 1000),
      `expected small reads, got ${reads}`
    )
  })
})

describe('chunk table, synthetic', () => {
  it('turns sizes into offsets laid end to end', async () => {
    const { table } = await openTable(buildChunkedLaz({
      chunkSizes: [200, 210, 190],
      pointCount: 120000
    }))

    assert.deepEqual(table.chunks.map((chunk) => chunk.byteLength), [200, 210, 190])
    assert.deepEqual(
      table.chunks.map((chunk) => chunk.offset),
      [table.firstChunkOffset, table.firstChunkOffset + 200, table.firstChunkOffset + 410]
    )
  })

  it('gives the last chunk only the points that are left', async () => {
    const { table } = await openTable(buildChunkedLaz({
      chunkSizes: [200, 210, 190],
      pointCount: 120000,
      chunkSize: 50000
    }))
    assert.deepEqual(table.chunks.map((chunk) => chunk.pointCount), [50000, 50000, 20000])
  })

  it('round-trips a long run of chunks, where each size is a delta on the last', async () => {
    // The real fixture holds a single chunk, so this is what exercises the
    // chunk-to-chunk prediction the table is actually coded with.
    const sizes = Array.from({ length: 400 }, (_, index) => 180000 + ((index * 37) % 900))
    const { table } = await openTable(buildChunkedLaz({
      chunkSizes: sizes,
      pointCount: 400 * 50000
    }))
    assert.deepEqual(table.chunks.map((chunk) => chunk.byteLength), sizes)
  })

  it('reads a variable-chunk table, which stores point counts too', async () => {
    const counts = [1000, 2500, 700, 4000]
    const sizes = [120, 300, 90, 480]
    const { table } = await openTable(buildChunkedLaz({
      chunkSizes: sizes,
      chunkCounts: counts,
      pointCount: counts.reduce((sum, count) => sum + count, 0)
    }))

    assert.equal(table.variableChunks, true)
    assert.equal(table.pointsPerChunk, null)
    assert.deepEqual(table.chunks.map((chunk) => chunk.pointCount), counts)
    assert.deepEqual(table.chunks.map((chunk) => chunk.firstPoint), [0, 1000, 3500, 4200])
  })

  describe('rejections', () => {
    it('refuses a file whose chunk table was never written', async () => {
      await assert.rejects(
        () => openTable(buildChunkedLaz({ tableOffsetOverride: -1 })),
        (error) => error instanceof LasUnsupportedError && /no chunk table/.test(error.message)
      )
    })

    it('refuses a chunk table pointer past the end of the file', async () => {
      await assert.rejects(
        () => openTable(buildChunkedLaz({ tableOffsetOverride: 9999999 })),
        (error) => error instanceof LasFormatError && /but the file is/.test(error.message)
      )
    })

    it('refuses sizes that do not account for the compressed bytes', async () => {
      // Corrupt a byte inside the coded entries. The decoder will happily
      // produce numbers from it; the sum is what catches that they are wrong.
      const bytes = buildChunkedLaz({ chunkSizes: [200, 210, 190] })
      const header = parseHeader(bytes)
      const view = new DataView(bytes.buffer)
      const tableOffset = Number(view.getBigInt64(header.offsetToPointData, true))
      bytes[tableOffset + 9] ^= 0xff

      await assert.rejects(
        () => openTable(bytes),
        (error) => error instanceof LasFormatError && /did not decode correctly/.test(error.message)
      )
    })

    it('refuses a truncated chunk table rather than inventing sizes', async () => {
      const bytes = buildChunkedLaz({ chunkSizes: [200, 210, 190] })
      const header = parseHeader(bytes)
      const view = new DataView(bytes.buffer)
      const tableOffset = Number(view.getBigInt64(header.offsetToPointData, true))

      await assert.rejects(
        () => openTable(bytes.subarray(0, tableOffset + 9)),
        (error) => error instanceof LasFormatError
      )
    })

    it('refuses an unknown chunk table version', async () => {
      await assert.rejects(
        () => openTable(buildChunkedLaz({ tableVersion: 1 })),
        (error) => error instanceof LasUnsupportedError && /version 1/.test(error.message)
      )
    })

    it('refuses a table header the file is too short to hold', () => {
      assert.throws(() => decodeChunkTable(new Uint8Array(4)), LasFormatError)
    })
  })

  it('reads an empty table', () => {
    const decoded = decodeChunkTable(buildChunkTable([]))
    assert.equal(decoded.chunkCount, 0)
    assert.deepEqual(decoded.sizes, [])
  })
})

describe('locating points', () => {
  const build = () => openTable(buildChunkedLaz({
    chunkSizes: [200, 210, 190],
    pointCount: 120000,
    chunkSize: 50000
  }))

  it('finds the chunk a point sits in', async () => {
    const { table } = await build()
    assert.equal(chunkForPoint(table, 0).index, 0)
    assert.equal(chunkForPoint(table, 49999).index, 0)
    assert.equal(chunkForPoint(table, 50000).index, 1)
    assert.equal(chunkForPoint(table, 119999).index, 2)
  })

  it('finds nothing for a point the file does not hold', async () => {
    const { table } = await build()
    assert.equal(chunkForPoint(table, 120000), undefined)
    assert.equal(chunkForPoint(table, -1), undefined)
  })

  it('searches a variable-chunk table', async () => {
    const counts = [1000, 2500, 700, 4000]
    const { table } = await openTable(buildChunkedLaz({
      chunkSizes: [120, 300, 90, 480],
      chunkCounts: counts,
      pointCount: 8200
    }))

    assert.equal(chunkForPoint(table, 0).index, 0)
    assert.equal(chunkForPoint(table, 999).index, 0)
    assert.equal(chunkForPoint(table, 1000).index, 1)
    assert.equal(chunkForPoint(table, 3499).index, 1)
    assert.equal(chunkForPoint(table, 4200).index, 3)
    assert.equal(chunkForPoint(table, 8199).index, 3)
    assert.equal(chunkForPoint(table, 8200), undefined)
  })

  it('selects only the chunks a range touches', async () => {
    const { table } = await build()
    assert.deepEqual(chunksForRange(table, 0, 1).map((chunk) => chunk.index), [0])
    assert.deepEqual(chunksForRange(table, 49999, 2).map((chunk) => chunk.index), [0, 1])
    assert.deepEqual(chunksForRange(table, 60000, 50000).map((chunk) => chunk.index), [1, 2])
    assert.deepEqual(chunksForRange(table, 0, 120000).map((chunk) => chunk.index), [0, 1, 2])
    assert.deepEqual(chunksForRange(table, 0, 0), [])
    assert.deepEqual(chunksForRange(table, 120000, 5), [])
  })
})
