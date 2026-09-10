import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { countInBox, openBytes, pointsInBox, POINT_FORMATS } from '../src/index.js'
import { boxToRawRange } from '../src/filter.js'
import { buildLas } from './helpers/build-las.js'
import { makeRandom, randomPoints } from './helpers/random.js'

const ALL_FORMATS = Object.keys(POINT_FORMATS).map(Number)

function versionFor (formatId) {
  if (formatId > 5) return 4
  if (formatId > 3) return 3
  return 2
}

async function collect (iterable) {
  const out = []
  for await (const item of iterable) out.push(item)
  return out
}

describe('property: every field survives a write/read round trip', () => {
  for (const id of ALL_FORMATS) {
    it(`format ${id}`, async () => {
      const random = makeRandom(1000 + id)
      const format = POINT_FORMATS[id]
      const written = randomPoints(random, format, 64)
      const bytes = buildLas({
        versionMinor: versionFor(id),
        pointFormat: id,
        scale: [0.001, 0.001, 0.001],
        offset: [0, 0, 0],
        points: written
      })

      const reader = await openBytes(bytes)
      const read = await reader.readPoints()
      assert.equal(read.length, written.length)

      for (const [index, expected] of written.entries()) {
        const actual = read[index]
        const where = `format ${id}, point ${index}`

        assert.equal(actual.rawX, expected.rawX, where)
        assert.equal(actual.rawY, expected.rawY, where)
        assert.equal(actual.rawZ, expected.rawZ, where)
        assert.equal(actual.intensity, expected.intensity, where)
        assert.equal(actual.returnNumber, expected.returnNumber, where)
        assert.equal(actual.numberOfReturns, expected.numberOfReturns, where)
        assert.equal(actual.scanDirectionFlag, expected.scanDirectionFlag, where)
        assert.equal(actual.edgeOfFlightLine, expected.edgeOfFlightLine, where)
        assert.equal(actual.classification, expected.classification, where)
        assert.equal(actual.synthetic, expected.synthetic, where)
        assert.equal(actual.keyPoint, expected.keyPoint, where)
        assert.equal(actual.withheld, expected.withheld, where)
        assert.equal(actual.scanAngleRaw, expected.scanAngleRaw, where)
        assert.equal(actual.userData, expected.userData, where)
        assert.equal(actual.pointSourceId, expected.pointSourceId, where)

        if (format.extended) {
          assert.equal(actual.overlap, expected.overlap, where)
          assert.equal(actual.scannerChannel, expected.scannerChannel, where)
        }
        if (format.gpsTime) assert.equal(actual.gpsTime, expected.gpsTime, where)
        if (format.color) {
          assert.equal(actual.red, expected.red, where)
          assert.equal(actual.green, expected.green, where)
          assert.equal(actual.blue, expected.blue, where)
        }
        if (format.nir) assert.equal(actual.nir, expected.nir, where)
        if (format.waveform) assert.deepEqual(actual.waveform, expected.waveform, where)
      }
    })
  }
})

describe('property: reading is independent of how it is read', () => {
  it('iteration matches readPoints, at any block size', async () => {
    const random = makeRandom(7)
    for (let round = 0; round < 12; round++) {
      const id = random.pick(ALL_FORMATS)
      const format = POINT_FORMATS[id]
      const count = random.int(1, 40)
      const bytes = buildLas({
        versionMinor: versionFor(id),
        pointFormat: id,
        extraByteCount: random.int(0, 6),
        points: randomPoints(random, format, count)
      })

      const reader = await openBytes(bytes)
      const reference = (await reader.readPoints()).map((point) => point.rawX)
      assert.equal(reference.length, count)

      const chunkSize = random.int(1, 400)
      const iterated = []
      for await (const point of reader.points({ chunkSize })) iterated.push(point.rawX)
      assert.deepEqual(iterated, reference, `format ${id}, chunkSize ${chunkSize}`)

      const blocks = await collect(reader.chunks({ chunkSize }))
      assert.deepEqual(blocks.flat().map((point) => point.rawX), reference)
      assert.equal(blocks.reduce((sum, block) => sum + block.length, 0), count)
    }
  })

  it('any start and count reads the same window as a full scan', async () => {
    const random = makeRandom(11)
    const bytes = buildLas({ pointFormat: 1, points: randomPoints(random, POINT_FORMATS[1], 50) })
    const reader = await openBytes(bytes)
    const all = (await reader.readPoints()).map((point) => point.rawX)

    for (let round = 0; round < 25; round++) {
      const start = random.int(0, 60)
      const count = random.int(0, 60)
      const window = (await reader.readPoints(start, count)).map((point) => point.rawX)
      assert.deepEqual(window, all.slice(start, start + count), `start ${start}, count ${count}`)
    }
  })

  it('a source that returns short reads changes nothing', async () => {
    const random = makeRandom(13)
    const bytes = buildLas({ pointFormat: 3, points: randomPoints(random, POINT_FORMATS[3], 30) })
    const whole = await openBytes(bytes)
    const reference = (await whole.readPoints()).map((point) => point.rawX)

    for (const limit of [1, 3, 17]) {
      const { LasReader } = await import('../src/index.js')
      const reader = await LasReader.open({
        byteLength: bytes.byteLength,
        async read (offset, length) {
          return bytes.subarray(offset, offset + Math.min(length, limit))
        }
      })
      assert.deepEqual((await reader.readPoints()).map((point) => point.rawX), reference, `limit ${limit}`)
    }
  })
})

describe('property: filters agree with a full scan', () => {
  it('pointsInBox selects exactly what a scan would', async () => {
    const random = makeRandom(23)

    for (let round = 0; round < 15; round++) {
      const points = Array.from({ length: 120 }, () => ({
        rawX: random.int(-1000, 1000),
        rawY: random.int(-1000, 1000),
        rawZ: random.int(-1000, 1000)
      }))
      const bytes = buildLas({ scale: [0.01, 0.01, 0.01], points })
      const reader = await openBytes(bytes)

      const box = {
        minX: random.float(-12, 0),
        maxX: random.float(0, 12),
        minY: random.float(-12, 0),
        maxY: random.float(0, 12)
      }

      const inside = (point) =>
        point.x >= box.minX && point.x <= box.maxX &&
        point.y >= box.minY && point.y <= box.maxY

      const scanned = (await reader.readPoints())
        .map((point, index) => ({ point, index }))
        .filter(({ point }) => inside(point))

      const filtered = await collect(pointsInBox(reader, box))

      assert.deepEqual(
        filtered.map((point) => point.index),
        scanned.map(({ index }) => index),
        `round ${round}`
      )
      assert.equal(await countInBox(reader, box), scanned.length, `round ${round}`)
    }
  })

  it('the raw range never includes a coordinate outside the box', async () => {
    const random = makeRandom(31)

    for (let round = 0; round < 50; round++) {
      const scale = random.pick([0.001, 0.01, 0.5, 1, -0.01])
      const offset = random.float(-1000, 1000)
      const header = {
        scale: [scale, scale, scale],
        offset: [offset, offset, offset],
        bounds: { min: [-1e9, -1e9, -1e9], max: [1e9, 1e9, 1e9] }
      }
      const lo = random.float(-100, 0)
      const hi = lo + random.float(0, 100)

      const range = boxToRawRange(header, { minX: lo, maxX: hi }, { useHeaderBounds: false })
      if (range === null) continue

      for (const raw of [range.minX, range.maxX]) {
        if (!Number.isFinite(raw)) continue
        const world = raw * scale + offset
        assert.ok(
          world >= lo - 1e-9 && world <= hi + 1e-9,
          `raw ${raw} maps to ${world}, outside [${lo}, ${hi}] at scale ${scale}`
        )
      }
    }
  })
})
