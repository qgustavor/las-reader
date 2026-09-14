import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import fs from 'node:fs'
import { LasReader, bytesSource, openBytes } from '../src/index.js'
import { LasFormatError, LasUnsupportedError } from '../src/errors.js'
import { buildLas } from './helpers/build-las.js'

const SAMPLE_PATH = new URL('sample_data/Haystack_Rock.las', import.meta.url)
const FIXTURE = new Uint8Array(fs.readFileSync(SAMPLE_PATH))

describe('LasReader.open', () => {
  it('reads header, records and CRS from the fixture', async () => {
    const reader = await openBytes(FIXTURE)
    assert.equal(reader.header.versionString, '1.2')
    assert.equal(reader.pointCount, 21932)
    assert.equal(reader.pointFormat.id, 0)
    assert.equal(reader.vlrs.length, 1)
    assert.equal(reader.evlrs.length, 0)
    assert.equal(reader.crs.horizontalEpsg, 3645)
  })

  it('rejects anything that is not a ByteSource', async () => {
    await assert.rejects(() => LasReader.open(FIXTURE), TypeError)
    await assert.rejects(() => LasReader.open(null), TypeError)
  })

  it('rejects a LASzip file with a pointer to the reader that handles it', async () => {
    // LasReader itself only reads uncompressed files. The high-level openers
    // detect compression and route around it; reaching for LasReader directly
    // should say so rather than fail obscurely.
    const bytes = buildLas({ pointFormat: 1, compressed: true, points: [{}] })
    await assert.rejects(() => LasReader.open(bytesSource(bytes)), (error) => {
      assert.ok(error instanceof LasUnsupportedError)
      assert.match(error.message, /openFile|las-reader\/laz/)
      return true
    })
  })

  it('sends a compressed file to the LAZ reader rather than refusing it', async () => {
    // Marked compressed but carrying no LASzip VLR, so the LAZ reader is the
    // one that complains: proof the dispatch happened.
    const bytes = buildLas({ pointFormat: 1, compressed: true, points: [{}] })
    await assert.rejects(
      () => openBytes(bytes),
      (error) => error instanceof LasFormatError && /LASzip VLR/.test(error.message)
    )
  })

  it('refuses a file that is shorter than its header claims', async () => {
    const bytes = buildLas({ points: [{}, {}, {}] })
    await assert.rejects(
      () => openBytes(bytes.subarray(0, bytes.byteLength - 25)),
      (error) => error instanceof LasFormatError && /only holds 1/.test(error.message)
    )
  })

  it('reads what is there when allowTruncated is set', async () => {
    const bytes = buildLas({ points: [{ rawX: 1 }, { rawX: 2 }, { rawX: 3 }] })
    const reader = await openBytes(bytes.subarray(0, bytes.byteLength - 25), { allowTruncated: true })
    assert.equal(reader.pointCount, 1)
    assert.deepEqual((await reader.readPoints()).map((point) => point.rawX), [1])
  })

  it('reads extended variable length records', async () => {
    const bytes = buildLas({
      versionMinor: 4,
      pointFormat: 6,
      points: [{}, {}],
      evlrs: [{ userId: 'custom', recordId: 1, data: Uint8Array.from([7]) }]
    })
    const reader = await openBytes(bytes)
    assert.equal(reader.evlrs.length, 1)
    assert.equal(reader.records.length, 1)
    assert.equal(reader.evlrs[0].data[0], 7)
  })
})

describe('LasReader point access', () => {
  it('reads a single point by index', async () => {
    const reader = await openBytes(FIXTURE)
    const first = await reader.readPoint(0)
    const last = await reader.readPoint(21931)
    assert.deepEqual([first.rawX, first.rawY, first.rawZ], [23084422, 5208093, -26])
    assert.deepEqual([last.rawX, last.rawY, last.rawZ], [23100792, 5239942, 1196])
  })

  it('reads a run starting anywhere', async () => {
    const reader = await openBytes(FIXTURE)
    const run = await reader.readPoints(1000, 3)
    assert.equal(run.length, 3)
    const [expected] = await reader.readPoints(1001, 1)
    assert.deepEqual(run[1].rawX, expected.rawX)
  })

  it('clamps a run that runs off the end instead of failing', async () => {
    const reader = await openBytes(FIXTURE)
    assert.equal((await reader.readPoints(21930, 100)).length, 2)
    assert.equal((await reader.readPoints(99999, 10)).length, 0)
    assert.equal(await reader.readPoint(99999), undefined)
  })

  it('rejects a negative or fractional start', async () => {
    const reader = await openBytes(FIXTURE)
    await assert.rejects(() => reader.readPoints(-1), RangeError)
    await assert.rejects(() => reader.readPoints(1.5), RangeError)
  })

  it('resumes iteration from a saved index', async () => {
    const reader = await openBytes(FIXTURE)
    const seen = []
    for await (const point of reader.points({ count: 10 })) seen.push(point.rawX)

    const resumed = []
    for await (const point of reader.points({ start: 10, count: 10 })) resumed.push(point.rawX)

    const straight = (await reader.readPoints(0, 20)).map((point) => point.rawX)
    assert.deepEqual([...seen, ...resumed], straight)
  })
})

describe('LasReader iteration', () => {
  it('yields every point, in file order', async () => {
    const reader = await openBytes(FIXTURE)
    let count = 0
    let firstX
    let lastX
    for await (const point of reader) {
      if (count === 0) firstX = point.rawX
      lastX = point.rawX
      count++
    }
    assert.equal(count, 21932)
    assert.equal(firstX, 23084422)
    assert.equal(lastX, 23100792)
  })

  it('produces identical output at every chunk size', async () => {
    const reader = await openBytes(FIXTURE)
    const reference = (await reader.readPoints(0, 500)).map((point) => point.rawX)

    // 20 is exactly one record, 37 straddles every record boundary, 1 forces
    // the minimum block, and the default reads the lot in one go.
    for (const chunkSize of [1, 20, 37, 64, 1000, 1 << 20]) {
      const seen = []
      for await (const point of reader.points({ count: 500, chunkSize })) seen.push(point.rawX)
      assert.deepEqual(seen, reference, `chunkSize ${chunkSize}`)
    }
  })

  it('is unaffected by a source that returns short reads', async () => {
    const dribbling = {
      byteLength: FIXTURE.byteLength,
      async read (offset, length) {
        return FIXTURE.subarray(offset, offset + Math.min(length, 7))
      }
    }
    const reader = await LasReader.open(dribbling)
    assert.equal(reader.pointCount, 21932)
    const points = await reader.readPoints(0, 5)
    assert.deepEqual(points.map((point) => point.rawX), [23084422, 23081793, 23084437, 23105369, 23104803])
  })

  it('hands back the same object every time with reuse', async () => {
    const reader = await openBytes(FIXTURE)
    const seen = new Set()
    const values = []
    for await (const point of reader.points({ count: 4, chunkSize: 40, reuse: true })) {
      seen.add(point)
      values.push(point.rawX)
    }
    assert.equal(seen.size, 2, 'one scratch object per slot in the block')
    assert.deepEqual(values, [23084422, 23081793, 23084437, 23105369])
  })

  it('yields blocks from chunks()', async () => {
    const reader = await openBytes(FIXTURE)
    const sizes = []
    for await (const block of reader.chunks({ count: 250, chunkSize: 100 * 20 })) {
      sizes.push(block.length)
    }
    assert.deepEqual(sizes, [100, 100, 50])
  })
})

describe('LasReader.stream', () => {
  it('exposes point blocks as a whatwg ReadableStream', async () => {
    const reader = await openBytes(FIXTURE)
    const stream = reader.stream({ count: 150, chunkSize: 100 * 20 })
    assert.ok(stream instanceof ReadableStream)

    let total = 0
    for await (const block of stream) total += block.length
    assert.equal(total, 150)
  })

  it('stops reading when the consumer cancels', async () => {
    const reader = await openBytes(FIXTURE)
    const stream = reader.stream({ chunkSize: 20 })
    const cursor = stream.getReader()
    const { value } = await cursor.read()
    assert.equal(value.length, 1)
    await cursor.cancel()
  })
})

describe('LasReader.close', () => {
  it('calls close on the source when it has one', async () => {
    let closed = false
    const source = { ...bytesSource(FIXTURE), close: async () => { closed = true } }
    const reader = await LasReader.open(source)
    await reader.close()
    assert.equal(closed, true)
  })

  it('is harmless on a source with no close', async () => {
    await (await openBytes(FIXTURE)).close()
  })
})
