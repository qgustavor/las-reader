import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import fs from 'node:fs'
import {
  assertIndexMatches, buildBlockIndex, candidateRuns, countInBox, openBytes,
  pointsInBox, pointsNear, selectivity, LasFormatError, boxToRawRange
} from '../src/index.js'
import { buildLas } from './helpers/build-las.js'
import { makeRandom } from './helpers/random.js'

const FIXTURE = new Uint8Array(
  fs.readFileSync(new URL('sample_data/Haystack_Rock.las', import.meta.url))
)

async function collect (iterable) {
  const out = []
  for await (const item of iterable) out.push(item)
  return out
}

describe('buildBlockIndex', () => {
  it('records the bounding box of each block of points', async () => {
    const reader = await openBytes(FIXTURE)
    const index = await buildBlockIndex(reader, { blockSize: 1000 })

    assert.equal(index.pointCount, 21932)
    assert.equal(index.blockSize, 1000)
    assert.equal(index.blockCount, 22)
    assert.equal(index.minX.length, 22)

    const points = await reader.readPoints(0, 1000)
    assert.equal(index.minX[0], Math.min(...points.map((point) => point.rawX)))
    assert.equal(index.maxZ[0], Math.max(...points.map((point) => point.rawZ)))
  })

  it('covers every point, including a short final block', async () => {
    const reader = await openBytes(FIXTURE)
    const index = await buildBlockIndex(reader, { blockSize: 7000 })
    assert.equal(index.blockCount, 4)

    const all = await reader.readPoints()
    const rawMinX = Math.min(...all.map((point) => point.rawX))
    assert.equal(Math.min(...index.minX), rawMinX)
  })

  it('reports progress', async () => {
    const reader = await openBytes(FIXTURE)
    const seen = []
    await buildBlockIndex(reader, { blockSize: 5000, onProgress: (p) => seen.push(p) })

    assert.equal(seen.length, 5)
    assert.deepEqual(seen.at(-1), { blocksDone: 5, blockCount: 5, pointsDone: 21932, pointCount: 21932 })
    assert.ok(seen[0].pointsDone < seen.at(-1).pointsDone)
  })

  it('can be aborted', async () => {
    const reader = await openBytes(FIXTURE)
    const controller = new AbortController()
    await assert.rejects(
      () => buildBlockIndex(reader, {
        blockSize: 100,
        signal: controller.signal,
        onProgress: ({ blocksDone }) => { if (blocksDone === 3) controller.abort() }
      }),
      (error) => error.name === 'AbortError'
    )
  })

  it('rejects a nonsensical block size', async () => {
    const reader = await openBytes(FIXTURE)
    await assert.rejects(() => buildBlockIndex(reader, { blockSize: 0 }), RangeError)
    await assert.rejects(() => buildBlockIndex(reader, { blockSize: 1.5 }), RangeError)
  })

  it('handles an empty file', async () => {
    const reader = await openBytes(buildLas({ points: [] }))
    const index = await buildBlockIndex(reader)
    assert.equal(index.blockCount, 0)
    assert.equal(selectivity(index, boxToRawRange(reader.header, {}, { useHeaderBounds: false })), 0)
  })
})

describe('assertIndexMatches', () => {
  it('accepts an index built from the same file', async () => {
    const reader = await openBytes(FIXTURE)
    const index = await buildBlockIndex(reader, { blockSize: 1000 })
    assert.equal(assertIndexMatches(index, reader), index)
  })

  it('rejects an index from a different file', async () => {
    const reader = await openBytes(FIXTURE)
    const other = await openBytes(buildLas({ points: [{}, {}, {}] }))
    const index = await buildBlockIndex(other)
    assert.throws(() => assertIndexMatches(index, reader), LasFormatError)
  })

  it('rejects an unknown version', async () => {
    const reader = await openBytes(FIXTURE)
    const index = await buildBlockIndex(reader, { blockSize: 1000 })
    assert.throws(() => assertIndexMatches({ ...index, version: 99 }, reader), LasFormatError)
  })
})

describe('candidateRuns', () => {
  it('merges neighbouring blocks into one run', async () => {
    const reader = await openBytes(FIXTURE)
    const index = await buildBlockIndex(reader, { blockSize: 1000 })
    const everything = boxToRawRange(reader.header, {}, { useHeaderBounds: false })

    const runs = [...candidateRuns(index, everything)]
    assert.deepEqual(runs, [{ start: 0, count: 21932 }], 'a query matching everything is one run')
  })

  it('yields nothing when no block can match', async () => {
    const reader = await openBytes(FIXTURE)
    const index = await buildBlockIndex(reader, { blockSize: 1000 })
    const impossible = { minX: 2e9, maxX: 2e9, minY: -2e9, maxY: 2e9, minZ: -2e9, maxZ: 2e9 }
    assert.deepEqual([...candidateRuns(index, impossible)], [])
  })

  it('honours a start and count window', async () => {
    const reader = await openBytes(FIXTURE)
    const index = await buildBlockIndex(reader, { blockSize: 1000 })
    const everything = boxToRawRange(reader.header, {}, { useHeaderBounds: false })

    const runs = [...candidateRuns(index, everything, { start: 500, count: 2000 })]
    assert.deepEqual(runs, [{ start: 500, count: 2000 }])
  })
})

describe('indexed queries', () => {
  it('gives exactly the same points as an unindexed query', async () => {
    const reader = await openBytes(FIXTURE)
    const index = await buildBlockIndex(reader, { blockSize: 500 })
    const random = makeRandom(97)

    for (let round = 0; round < 12; round++) {
      const box = {
        minX: random.float(2230700, 2231100),
        maxX: random.float(2230700, 2231100),
        minY: random.float(252000, 252450),
        maxY: random.float(252000, 252450)
      }
      if (box.minX > box.maxX) [box.minX, box.maxX] = [box.maxX, box.minX]
      if (box.minY > box.maxY) [box.minY, box.maxY] = [box.maxY, box.minY]

      const plain = (await collect(pointsInBox(reader, box))).map((point) => point.index)
      const indexed = (await collect(pointsInBox(reader, box, { index }))).map((point) => point.index)
      assert.deepEqual(indexed, plain, `round ${round}`)

      assert.equal(await countInBox(reader, box, { index }), plain.length, `round ${round}`)
    }
  })

  it('works for radius queries too', async () => {
    const reader = await openBytes(FIXTURE)
    const index = await buildBlockIndex(reader, { blockSize: 500 })
    const centre = { x: 2230900, y: 252200, radius: 20 }

    const plain = (await collect(pointsNear(reader, centre))).map((point) => point.index)
    const indexed = (await collect(pointsNear(reader, centre, { index }))).map((point) => point.index)
    assert.deepEqual(indexed, plain)
    assert.ok(plain.length > 0)
  })

  it('reads far less of the file for a selective query', async () => {
    let bytesRead = 0
    const counting = {
      byteLength: FIXTURE.byteLength,
      async read (offset, length) {
        bytesRead += length
        return FIXTURE.subarray(offset, offset + length)
      }
    }
    const { LasReader } = await import('../src/index.js')
    const reader = await LasReader.open(counting)
    const index = await buildBlockIndex(reader, { blockSize: 500 })

    const box = { minX: 2230850, maxX: 2230870, minY: 252150, maxY: 252170 }
    const range = boxToRawRange(reader.header, box)

    bytesRead = 0
    await collect(pointsInBox(reader, box, { index, chunkSize: 500 * 20 }))
    const withIndex = bytesRead

    bytesRead = 0
    await collect(pointsInBox(reader, box, { chunkSize: 500 * 20 }))
    const withoutIndex = bytesRead

    assert.ok(
      withIndex < withoutIndex / 2,
      `indexed read ${withIndex} bytes, unindexed ${withoutIndex}`
    )
    assert.ok(selectivity(index, range) < 0.5)
  })

  it('refuses a mismatched index rather than returning wrong answers', async () => {
    const reader = await openBytes(FIXTURE)
    const other = await openBytes(buildLas({ points: [{}, {}] }))
    const index = await buildBlockIndex(other)
    await assert.rejects(
      () => collect(pointsInBox(reader, {}, { index })),
      LasFormatError
    )
  })

  it('survives a structuredClone round trip, as IndexedDB would do', async () => {
    const reader = await openBytes(FIXTURE)
    const index = await buildBlockIndex(reader, { blockSize: 500 })
    const restored = structuredClone(index)

    const box = { minX: 2230850, maxX: 2230950 }
    assert.equal(
      await countInBox(reader, box, { index: restored }),
      await countInBox(reader, box)
    )
  })
})
