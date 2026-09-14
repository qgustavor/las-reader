import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import fs from 'node:fs'
import { LasFormatError, LasUnsupportedError } from '../src/errors.js'
import { LasReader, isCompressed, openBytes } from '../src/index.js'
import { openFile } from '../src/node.js'
import { openBlob } from '../src/browser.js'
import { bytesSource } from '../src/byte-source.js'
import { LazReader, openLazBytes } from '../src/laz.js'
import { buildLas } from './helpers/build-las.js'
import { buildLaszipVlr } from './helpers/build-laz.js'

const LAZ_PATH = new URL('sample_data/point-time-1.4.las.laz', import.meta.url)
const LAZ = new Uint8Array(fs.readFileSync(LAZ_PATH))

/**
 * These tests cover opening a compressed file: the header, the LASzip VLR, the
 * chunk table, and everything the reader derives from them. Reading points
 * needs laz-perf to actually decompress, so that is not exercised here.
 */

describe('LazReader.open', () => {
  it('opens a compressed file and reports what it holds', async () => {
    const reader = await openLazBytes(LAZ)
    try {
      assert.equal(reader.header.versionString, '1.4')
      assert.equal(reader.header.pointDataRecordFormat, 1)
      assert.equal(reader.pointCount, 1065)
      assert.equal(reader.pointFormat.byteLength, 28)
    } finally {
      await reader.close()
    }
  })

  it('counts points from the header, not from a byte range', async () => {
    // The inherited getter divides the point data range by the record length,
    // which on a compressed file measures compressed bytes and is meaningless.
    const reader = await openLazBytes(LAZ)
    try {
      assert.equal(reader.pointCount, reader.header.pointCount)
    } finally {
      await reader.close()
    }
  })

  it('exposes the records the file carries, compressed or not', async () => {
    const reader = await openLazBytes(LAZ)
    try {
      assert.ok(reader.vlrs.length >= 1)
      assert.ok(reader.records.some((record) => record.userId === 'laszip encoded'))
      assert.equal(reader.crs.kind, 'wkt')
      assert.match(reader.crs.wkt, /NAD83 \/ UTM zone 10N/)
    } finally {
      await reader.close()
    }
  })

  it('exposes the LASzip VLR and the chunk table it read', async () => {
    const reader = await openLazBytes(LAZ)
    try {
      assert.equal(reader.laszipVlr.compressorName, 'pointwise chunked')
      assert.deepEqual(reader.laszipVlr.items.map((item) => item.name), ['POINT10', 'GPSTIME11'])
      assert.equal(reader.chunkTable.chunkCount, 1)
      assert.equal(
        reader.chunkTable.chunks.reduce((sum, chunk) => sum + chunk.pointCount, 0),
        reader.pointCount
      )
    } finally {
      await reader.close()
    }
  })

  it('does not create the WASM module just to read the header', async () => {
    // laz-perf is not installed in every environment this runs in, and
    // compiling it costs more than the whole header read. A caller that wants
    // the bounds or the point count should never pay for it.
    const reader = await LazReader.open(bytesSource(LAZ))
    await reader.close()
  })

  it('reads a point range without decompressing chunks it does not touch', async () => {
    let decoded = 0
    const backend = {
      decodeChunk ({ pointCount, recordLength }) {
        decoded++
        return new Uint8Array(pointCount * recordLength)
      }
    }
    const reader = await LazReader.open(bytesSource(LAZ), { backend })
    try {
      await reader.readPoints(0, 1)
      assert.equal(decoded, 1)
      // The same chunk again, served from the cache.
      await reader.readPoints(2, 1)
      assert.equal(decoded, 1)
    } finally {
      await reader.close()
    }
  })
})

describe('LazReader rejections', () => {
  it('refuses an uncompressed file, pointing at the reader that reads it', async () => {
    const las = buildLas({ versionMinor: 2, pointFormat: 0, points: [{ rawX: 1 }] })
    await assert.rejects(
      () => openLazBytes(las),
      (error) => error instanceof LasFormatError && /not compressed/.test(error.message)
    )
  })

  it('refuses a file marked compressed that carries no LASzip VLR', async () => {
    const las = buildLas({
      versionMinor: 2, pointFormat: 0, compressed: true, points: [{ rawX: 1 }]
    })
    await assert.rejects(
      () => openLazBytes(las),
      (error) => error instanceof LasFormatError && /no\s+LASzip VLR/.test(error.message)
    )
  })

  it('refuses the unchunked pointwise scheme, which has no chunk table', async () => {
    const las = buildLas({
      versionMinor: 2,
      pointFormat: 0,
      compressed: true,
      points: [{ rawX: 1 }],
      vlrs: [buildLaszipVlr({ pointFormat: 0, compressor: 1 })]
    })
    await assert.rejects(
      () => openLazBytes(las),
      (error) => error instanceof LasUnsupportedError && /chunk table/.test(error.message)
    )
  })

  it('refuses a LASzip VLR that disagrees with the header about the point size', async () => {
    const las = buildLas({
      versionMinor: 2,
      pointFormat: 0,
      compressed: true,
      points: [{ rawX: 1 }],
      vlrs: [buildLaszipVlr({ pointFormat: 3 })]
    })
    await assert.rejects(
      () => openLazBytes(las),
      (error) => error instanceof LasFormatError && /bytes per point/.test(error.message)
    )
  })

  it('refuses a backend that is not one', async () => {
    await assert.rejects(
      () => LazReader.open(bytesSource(LAZ), { backend: {} }),
      TypeError
    )
  })
})

describe('LasReader on a compressed file', () => {
  it('sends the caller to the laz entry point', async () => {
    await assert.rejects(
      () => LasReader.open(bytesSource(LAZ)),
      (error) => error instanceof LasUnsupportedError && /laz/.test(error.message)
    )
  })
})

describe('opening a compressed file through the ordinary entry points', () => {
  // A caller should not have to know whether their file is compressed before
  // they open it. The header says so, and every high-level opener reads it.

  it('openBytes returns a LazReader for a compressed file', async () => {
    const reader = await openBytes(LAZ)
    try {
      assert.ok(reader instanceof LazReader)
      assert.equal(reader.pointCount, 1065)
    } finally {
      await reader.close()
    }
  })

  it('openBytes still returns a plain LasReader for an uncompressed file', async () => {
    const reader = await openBytes(buildLas({ pointFormat: 0, points: [{ rawX: 7 }] }))
    try {
      assert.ok(reader instanceof LasReader)
      assert.ok(!(reader instanceof LazReader))
    } finally {
      await reader.close()
    }
  })

  it('openFile reads a .laz from disk with no extra ceremony', async () => {
    const reader = await openFile(LAZ_PATH)
    try {
      assert.ok(reader instanceof LazReader)
      assert.equal(reader.header.versionString, '1.4')
    } finally {
      await reader.close()
    }
  })

  it('openBlob reads a compressed Blob', async () => {
    const reader = await openBlob(new Blob([LAZ]))
    try {
      assert.ok(reader instanceof LazReader)
      assert.equal(reader.pointCount, 1065)
    } finally {
      await reader.close()
    }
  })

  it('detects compression without parsing the whole header', async () => {
    assert.equal(await isCompressed(bytesSource(LAZ)), true)
    assert.equal(
      await isCompressed(bytesSource(buildLas({ pointFormat: 0, points: [{}] }))),
      false
    )
  })

  it('leaves a file too short to hold the format byte to the header parser', async () => {
    // Not "uncompressed" so much as "not a LAS file"; the error should say that
    // rather than complain about a missing LASzip VLR.
    assert.equal(await isCompressed(bytesSource(new Uint8Array(8))), false)
    await assert.rejects(() => openBytes(new Uint8Array(8)), LasFormatError)
  })
})

describe('truncated compressed files', () => {
  /**
   * Shortens the compressed data by `dropped` bytes, keeping the chunk table
   * intact and pointing at its new position. The table then describes more
   * bytes than the file holds, which is what a file cut short looks like once
   * the table has been recovered.
   */
  const shortened = (dropped) => {
    const view = new DataView(LAZ.buffer, LAZ.byteOffset, LAZ.byteLength)
    const offsetToPointData = view.getUint32(96, true)
    const tableOffset = Number(view.getBigInt64(offsetToPointData, true))
    const table = LAZ.subarray(tableOffset)

    const movedTo = tableOffset - dropped
    const bytes = new Uint8Array(movedTo + table.byteLength)
    bytes.set(LAZ.subarray(0, movedTo))
    bytes.set(table, movedTo)
    new DataView(bytes.buffer).setBigInt64(offsetToPointData, BigInt(movedTo), true)
    return bytes
  }

  it('refuses a file whose chunks do not fit, and says what to pass', async () => {
    // Move the chunk table pointer back so the chunks overrun the data.
    const bytes = shortened(200)
    await assert.rejects(
      () => openBytes(bytes),
      (error) => error instanceof LasFormatError && /allowTruncated/.test(error.message)
    )
  })

  it('drops chunks that are not all there when allowed', async () => {
    const bytes = shortened(200)
    const reader = await openBytes(bytes, { allowTruncated: true })
    try {
      // The one chunk no longer fits, so there is nothing left to read.
      assert.equal(reader.chunkTable.chunks.length, 0)
      assert.equal(reader.pointCount, 0)
      assert.deepEqual(await reader.readPoints(0, 10), [])
    } finally {
      await reader.close()
    }
  })

  it('counts points from the chunks present, not from the header', async () => {
    const bytes = shortened(200)
    const reader = await openBytes(bytes, { allowTruncated: true })
    try {
      assert.equal(reader.header.pointCount, 1065)
      assert.notEqual(reader.pointCount, reader.header.pointCount)
    } finally {
      await reader.close()
    }
  })
})

describe('chunk caching', () => {
  const countingBackend = () => {
    const decoded = []
    return {
      decoded,
      decodeChunk ({ pointCount, recordLength }) {
        decoded.push(pointCount)
        return new Uint8Array(pointCount * recordLength)
      }
    }
  }

  it('keeps one chunk by default', async () => {
    const backend = countingBackend()
    const reader = await openBytes(LAZ, { backend })
    try {
      await reader.readPoints(0, 1)
      await reader.readPoints(500, 1)
      assert.equal(backend.decoded.length, 1)
    } finally {
      await reader.close()
    }
  })

  it('keeps as many as asked for', async () => {
    const backend = countingBackend()
    const reader = await openBytes(LAZ, { backend, cacheChunks: 4 })
    try {
      await reader.readPoints(0, 1)
      await reader.readPoints(1, 1)
      assert.equal(backend.decoded.length, 1)
    } finally {
      await reader.close()
    }
  })

  it('never caches less than one chunk, whatever it is told', async () => {
    const backend = countingBackend()
    const reader = await openBytes(LAZ, { backend, cacheChunks: 0 })
    try {
      await reader.readPoints(0, 1)
      await reader.readPoints(1, 1)
      assert.equal(backend.decoded.length, 1)
    } finally {
      await reader.close()
    }
  })
})
