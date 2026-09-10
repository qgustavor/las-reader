import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import fs from 'node:fs'
import { LasError, openBytes, POINT_FORMATS, pointsNear } from '../src/index.js'
import { buildLas } from './helpers/build-las.js'
import { makeRandom, randomPoints } from './helpers/random.js'

const FIXTURE = new Uint8Array(
  fs.readFileSync(new URL('sample_data/Haystack_Rock.las', import.meta.url))
)

/**
 * The contract under fuzzing: for any input at all, the reader either produces
 * points or throws a LasError. It never throws a RangeError or a TypeError from
 * an unchecked DataView access, never returns a point with undefined
 * coordinates, and always terminates.
 */
async function readEverything (bytes, seed) {
  try {
    const reader = await openBytes(bytes, { allowTruncated: true })
    let count = 0
    for await (const point of reader.points({ chunkSize: 512 })) {
      assert.equal(typeof point.x, 'number', `seed ${seed}: point ${count} has no x`)
      assert.equal(typeof point.classification, 'number', `seed ${seed}: point ${count} has no classification`)
      count++
    }
    assert.equal(count, reader.pointCount, `seed ${seed}: yielded ${count} of ${reader.pointCount}`)
    return { ok: true, count }
  } catch (error) {
    assert.ok(
      error instanceof LasError,
      `seed ${seed}: expected a LasError, got ${error?.constructor?.name}: ${error?.message}\n${error?.stack}`
    )
    return { ok: false, error }
  }
}

describe('fuzz: corrupted bytes', () => {
  it('survives single-byte corruption anywhere in the header or VLRs', async () => {
    const random = makeRandom(101)
    let accepted = 0
    let rejected = 0

    for (let round = 0; round < 400; round++) {
      const bytes = FIXTURE.slice(0, 4096)
      const at = random.int(0, 330)
      bytes[at] = random.int(0, 255)
      const result = await readEverything(bytes, `header-${round}-at-${at}`)
      result.ok ? accepted++ : rejected++
    }

    assert.ok(rejected > 0, 'corruption should sometimes be caught')
    assert.ok(accepted > 0, 'corruption should sometimes be harmless')
  })

  it('survives scattered corruption across a whole small file', async () => {
    const random = makeRandom(202)

    for (let round = 0; round < 150; round++) {
      const id = random.pick(Object.keys(POINT_FORMATS).map(Number))
      const versionMinor = id > 5 ? 4 : id > 3 ? 3 : 2
      const bytes = buildLas({
        versionMinor,
        pointFormat: id,
        points: randomPoints(random, POINT_FORMATS[id], 20),
        vlrs: [{ userId: 'LASF_Projection', recordId: 34735, data: new Uint8Array(random.int(0, 40)) }]
      })

      for (let hit = 0; hit < random.int(1, 8); hit++) {
        bytes[random.int(0, bytes.byteLength - 1)] = random.int(0, 255)
      }

      await readEverything(bytes, `scatter-${round}-format-${id}`)
    }
  })

  it('survives truncation at any length', async () => {
    const random = makeRandom(303)

    for (let round = 0; round < 200; round++) {
      const length = random.int(0, 5000)
      await readEverything(FIXTURE.slice(0, length), `truncate-${round}-at-${length}`)
    }
  })

  it('survives random bytes that happen to start with LASF', async () => {
    const random = makeRandom(404)

    for (let round = 0; round < 200; round++) {
      const bytes = new Uint8Array(random.int(4, 900))
      for (let index = 0; index < bytes.length; index++) bytes[index] = random.int(0, 255)
      bytes.set([0x4c, 0x41, 0x53, 0x46])
      await readEverything(bytes, `noise-${round}`)
    }
  })

  it('survives corruption of the extended variable length records', async () => {
    const random = makeRandom(505)

    for (let round = 0; round < 100; round++) {
      const bytes = buildLas({
        versionMinor: 4,
        pointFormat: 6,
        points: randomPoints(random, POINT_FORMATS[6], 8),
        evlrs: [
          { userId: 'LASF_Projection', recordId: 2112, data: new TextEncoder().encode('PROJCS["x"]') },
          { userId: 'other', recordId: 9, data: new Uint8Array(32) }
        ]
      })
      // Aim at the region after the points, where the EVLRs live.
      const start = Math.floor(bytes.byteLength * 0.7)
      bytes[random.int(start, bytes.byteLength - 1)] = random.int(0, 255)
      await readEverything(bytes, `evlr-${round}`)
    }
  })
})

describe('fuzz: filters over corrupted input', () => {
  it('never lets a filter throw anything but a LasError', async () => {
    const random = makeRandom(606)

    for (let round = 0; round < 120; round++) {
      const bytes = FIXTURE.slice(0, 8192)
      bytes[random.int(0, 400)] = random.int(0, 255)

      try {
        const reader = await openBytes(bytes, { allowTruncated: true })
        for await (const point of pointsNear(
          reader,
          { x: random.float(2230000, 2232000), y: random.float(252000, 253000), radius: random.float(0, 500) },
          { useHeaderBounds: random.bool(), chunkSize: 256 }
        )) {
          assert.ok(Number.isFinite(point.distance), `round ${round}: non-finite distance`)
        }
      } catch (error) {
        assert.ok(error instanceof LasError, `round ${round}: ${error?.constructor?.name}: ${error?.message}`)
      }
    }
  })
})

describe('fuzz: adversarial sources', () => {
  it('does not hang on a source that always returns one byte', async () => {
    const reader = await openBytes(FIXTURE)
    assert.equal(reader.pointCount, 21932)

    const trickle = {
      byteLength: FIXTURE.byteLength,
      async read (offset, length) {
        return FIXTURE.subarray(offset, offset + Math.min(length, 1))
      }
    }
    const { LasReader } = await import('../src/index.js')
    const slow = await LasReader.open(trickle)
    assert.equal((await slow.readPoint(0)).rawX, 23084422)
  })

  it('is bounded by the header, not by what a source claims', async () => {
    const { LasReader } = await import('../src/index.js')
    const liar = {
      byteLength: FIXTURE.byteLength * 4,
      async read (offset, length) {
        return FIXTURE.subarray(offset, offset + length)
      }
    }
    const reader = await LasReader.open(liar)
    // The header says 21932 points, so that is what gets read; the source
    // overstating its size cannot make the reader wander past the point data.
    assert.equal(reader.pointCount, 21932)
    assert.equal((await reader.readPoints(21000, 2000)).length, 932)
  })

  it('throws rather than inventing data when a source runs out mid-read', async () => {
    const { readExact } = await import('../src/index.js')
    const liar = {
      byteLength: FIXTURE.byteLength * 4,
      async read (offset, length) {
        return FIXTURE.subarray(offset, offset + length)
      }
    }
    await assert.rejects(() => readExact(liar, FIXTURE.byteLength - 10, 100), LasError)
  })
})
