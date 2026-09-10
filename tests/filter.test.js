import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import fs from 'node:fs'
import {
  boxToRawRange, countInBox, matching, openBytes, pointsInBox, pointsNear, toColumns
} from '../src/index.js'
import { parseHeader } from '../src/header.js'
import { buildLas } from './helpers/build-las.js'

const FIXTURE = new Uint8Array(
  fs.readFileSync(new URL('sample_data/Haystack_Rock.las', import.meta.url))
)

async function collect (iterable) {
  const out = []
  for await (const item of iterable) out.push(item)
  return out
}

describe('boxToRawRange', () => {
  const header = parseHeader(FIXTURE) // scale [0.01, 0.01, 0.001], offset [2e6, 2e5, -0]

  it('converts world coordinates into stored integers', () => {
    const range = boxToRawRange(header, { minX: 2230800, maxX: 2230900 })
    assert.equal(range.minX, 23080000)
    assert.equal(range.maxX, 23090000)
  })

  it('leaves omitted axes unbounded', () => {
    const range = boxToRawRange(header, { minX: 2230800 })
    assert.equal(range.maxX, Infinity)
    assert.equal(range.minY, -Infinity)
  })

  it('rounds inwards so the raw range never widens the box', () => {
    const range = boxToRawRange(header, { minX: 2230800.005, maxX: 2230900.005 })
    assert.equal(range.minX, 23080001)
    assert.equal(range.maxX, 23090000)
  })

  it('returns null for a box outside the header bounds', () => {
    assert.equal(boxToRawRange(header, { minX: 9e6 }), null)
    assert.equal(boxToRawRange(header, { maxY: -9e6 }), null)
  })

  it('still converts when header bounds are not trusted', () => {
    const range = boxToRawRange(header, { minX: 9e6 }, { useHeaderBounds: false })
    assert.ok(range.minX > 0)
  })

  it('handles a negative scale factor', () => {
    const bytes = buildLas({ scale: [-0.01, 0.01, 0.01], points: [{ rawX: -100 }, { rawX: 100 }] })
    const negative = parseHeader(bytes)
    const range = boxToRawRange(negative, { minX: -1, maxX: 1 }, { useHeaderBounds: false })
    assert.equal(range.minX, -100)
    assert.equal(range.maxX, 100)
  })
})

describe('pointsInBox', () => {
  it('returns exactly the points a full scan would', async () => {
    const reader = await openBytes(FIXTURE)
    const box = { minX: 2230800, maxX: 2230900, minY: 252100, maxY: 252200 }

    const expected = []
    for await (const point of reader) {
      if (point.x >= box.minX && point.x <= box.maxX && point.y >= box.minY && point.y <= box.maxY) {
        expected.push(point.rawX)
      }
    }

    const filtered = (await collect(pointsInBox(reader, box))).map((point) => point.rawX)
    assert.ok(expected.length > 0 && expected.length < 21932, 'the box is actually selective')
    assert.deepEqual(filtered, expected)
  })

  it('tags each point with its index in the file', async () => {
    const reader = await openBytes(FIXTURE)
    const [first] = await collect(pointsInBox(reader, {}, { count: 1 }))
    assert.equal(first.index, 0)
    const [tenth] = await collect(pointsInBox(reader, {}, { start: 10, count: 1 }))
    assert.equal(tenth.index, 10)
    assert.equal(tenth.rawX, (await reader.readPoint(10)).rawX)
  })

  it('yields nothing for a box the file cannot contain', async () => {
    const reader = await openBytes(FIXTURE)
    assert.deepEqual(await collect(pointsInBox(reader, { minX: 9e9 })), [])
  })

  it('gives the same answer at every block size', async () => {
    const reader = await openBytes(FIXTURE)
    const box = { minX: 2230900, maxX: 2231000 }
    const reference = (await collect(pointsInBox(reader, box))).map((point) => point.index)
    for (const chunkSize of [20, 61, 4096]) {
      const seen = (await collect(pointsInBox(reader, box, { chunkSize }))).map((point) => point.index)
      assert.deepEqual(seen, reference, `chunkSize ${chunkSize}`)
    }
  })

  it('applies a where predicate on decoded fields', async () => {
    const bytes = buildLas({
      points: [
        { rawX: 10, classification: 2 },
        { rawX: 20, classification: 5 },
        { rawX: 30, classification: 2 }
      ]
    })
    const reader = await openBytes(bytes)
    const found = await collect(pointsInBox(reader, {}, { where: matching({ classification: 2 }) }))
    assert.deepEqual(found.map((point) => point.rawX), [10, 30])
  })
})

describe('countInBox', () => {
  it('agrees with pointsInBox without decoding anything', async () => {
    const reader = await openBytes(FIXTURE)
    const box = { minX: 2230800, maxX: 2230900 }
    const counted = await countInBox(reader, box)
    const listed = await collect(pointsInBox(reader, box))
    assert.equal(counted, listed.length)
    assert.ok(counted > 0)
  })

  it('is zero for an impossible box', async () => {
    const reader = await openBytes(FIXTURE)
    assert.equal(await countInBox(reader, { minZ: 1e6 }), 0)
  })
})

describe('pointsNear', () => {
  it('returns points inside the circle and no others', async () => {
    const reader = await openBytes(FIXTURE)
    const centre = { x: 2230900, y: 252200, radius: 25 }

    const found = await collect(pointsNear(reader, centre))
    assert.ok(found.length > 0)

    for (const point of found) {
      const distance = Math.hypot(point.x - centre.x, point.y - centre.y)
      assert.ok(distance <= centre.radius + 1e-9)
      assert.ok(Math.abs(point.distance - distance) < 1e-9)
    }

    let expected = 0
    for await (const point of reader) {
      if (Math.hypot(point.x - centre.x, point.y - centre.y) <= centre.radius) expected++
    }
    assert.equal(found.length, expected)
  })

  it('excludes the corners the bounding box would have included', async () => {
    const reader = await openBytes(FIXTURE)
    const centre = { x: 2230900, y: 252200, radius: 25 }
    const inCircle = await countInBox(reader, {}) && (await collect(pointsNear(reader, centre))).length
    const inSquare = await countInBox(reader, {
      minX: centre.x - 25, maxX: centre.x + 25, minY: centre.y - 25, maxY: centre.y + 25
    })
    assert.ok(inCircle < inSquare, `${inCircle} in the circle, ${inSquare} in its bounding box`)
  })

  it('becomes a cylinder when given a z range', async () => {
    const reader = await openBytes(FIXTURE)
    const found = await collect(
      pointsNear(reader, { x: 2230900, y: 252200, radius: 50, minZ: 0, maxZ: 5 })
    )
    assert.ok(found.length > 0)
    for (const point of found) assert.ok(point.z >= 0 && point.z <= 5)
  })

  it('rejects a negative radius', async () => {
    const reader = await openBytes(FIXTURE)
    await assert.rejects(() => collect(pointsNear(reader, { x: 0, y: 0, radius: -1 })), RangeError)
  })

  it('yields nothing when the radius is zero and no point sits on the centre', async () => {
    const reader = await openBytes(FIXTURE)
    assert.deepEqual(await collect(pointsNear(reader, { x: 2230900.005, y: 252200.005, radius: 0 })), [])
  })
})

describe('matching', () => {
  const point = { classification: 2, returnNumber: 1, z: 10, intensity: 500, withheld: false }

  it('matches a single value', () => {
    assert.equal(matching({ classification: 2 })(point), true)
    assert.equal(matching({ classification: 3 })(point), false)
  })

  it('matches any value in an array', () => {
    assert.equal(matching({ classification: [2, 9] })(point), true)
    assert.equal(matching({ classification: [3, 9] })(point), false)
  })

  it('combines fields with and', () => {
    assert.equal(matching({ classification: 2, returnNumber: 1 })(point), true)
    assert.equal(matching({ classification: 2, returnNumber: 2 })(point), false)
  })

  it('applies z and intensity as ranges', () => {
    assert.equal(matching({ minZ: 5, maxZ: 15 })(point), true)
    assert.equal(matching({ minZ: 11 })(point), false)
    assert.equal(matching({ maxIntensity: 400 })(point), false)
  })

  it('matches booleans', () => {
    assert.equal(matching({ withheld: false })(point), true)
    assert.equal(matching({ withheld: true })(point), false)
  })

  it('matches everything when given nothing', () => {
    assert.equal(matching()(point), true)
  })
})

describe('toColumns', () => {
  it('produces parallel typed arrays', async () => {
    const reader = await openBytes(FIXTURE)
    const points = await reader.readPoints(0, 4)
    const columns = toColumns(points, ['intensity'])

    assert.equal(columns.count, 4)
    assert.ok(columns.x instanceof Float64Array)
    assert.equal(columns.x[0], points[0].x)
    assert.equal(columns.z[3], points[3].z)
    assert.equal(columns.intensity[1], points[1].intensity)
  })

  it('handles an empty result', () => {
    const columns = toColumns([])
    assert.equal(columns.count, 0)
    assert.equal(columns.x.length, 0)
  })
})
