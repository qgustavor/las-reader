import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ArithmeticDecoder } from '../src/laz/arithmetic-decoder.js'
import { IntegerDecompressor } from '../src/laz/integer-decompressor.js'
import { ArithmeticEncoder, IntegerCompressor } from './helpers/arithmetic-encoder.js'
import { makeRandom } from './helpers/random.js'

/**
 * @param {number[]} values
 * @param {object} [options]
 * @returns {number[]} what the decompressor gives back
 */
function roundTrip (values, { bits = 32, contexts = 1, bitsHigh = 8, contextOf = () => 0 } = {}) {
  const encoder = new ArithmeticEncoder()
  const compressor = new IntegerCompressor(encoder, bits, contexts, bitsHigh)

  const predictions = new Array(contexts).fill(0)
  for (const [index, value] of values.entries()) {
    const context = contextOf(index)
    compressor.compress(predictions[context], value, context)
    predictions[context] = value
  }
  const bytes = encoder.done()

  const decoder = new ArithmeticDecoder(bytes)
  const decompressor = new IntegerDecompressor(decoder, bits, contexts, bitsHigh)

  const decoded = new Array(contexts).fill(0)
  return values.map((_, index) => {
    const context = contextOf(index)
    decoded[context] = decompressor.decompress(decoded[context], context)
    return decoded[context]
  })
}

describe('IntegerDecompressor', () => {
  it('round-trips values that sit exactly on the corrector boundaries', () => {
    // 0 and 1 take the bit-model path; the rest straddle the point where the
    // corrector switches between its positive and negative intervals.
    const values = [0, 1, 2, 3, 4, 5, 8, 9, 16, 17, 0, 1, 0, -1, -2, -3, -4, -8, -9]
    assert.deepEqual(roundTrip(values), values)
  })

  it('round-trips the extremes of a 32-bit value', () => {
    const values = [0, 2147483647, -2147483648, 0, -2147483648, 2147483647]
    assert.deepEqual(roundTrip(values), values)
  })

  it('round-trips corrections wider than bitsHigh, whose low bits are read raw', () => {
    const values = [0, 1000000, 2, 999999999, 5, -999999999]
    assert.deepEqual(roundTrip(values), values)
  })

  it('keeps contexts independent', () => {
    const random = makeRandom(11)
    // Two interleaved series with very different shapes. If the contexts
    // shared statistics, the models would desynchronise between the halves.
    const values = Array.from({ length: 2000 }, (_, index) =>
      (index % 2 === 0 ? random.int(0, 4) : random.int(0, 2 ** 30)))

    assert.deepEqual(
      roundTrip(values, { contexts: 2, contextOf: (index) => index % 2 }),
      values
    )
  })

  it('rejects a context it was not configured for', () => {
    const decompressor = new IntegerDecompressor(
      new ArithmeticDecoder(new Uint8Array(16)), 32, 2
    )
    assert.throws(() => decompressor.decompress(0, 2), RangeError)
  })

  describe('narrower widths', () => {
    for (const bits of [8, 10, 16, 20]) {
      it(`round-trips ${bits}-bit values, wrapping into range`, () => {
        const random = makeRandom(bits)
        const values = Array.from({ length: 500 }, () => random.int(0, 2 ** bits - 1))
        assert.deepEqual(roundTrip(values, { bits }), values)
      })
    }
  })

  describe('the chunk table configuration', () => {
    // 32 bits, two contexts: point counts in one, byte counts in the other.
    const options = { bits: 32, contexts: 2, contextOf: (index) => index % 2 }

    it('round-trips plausible chunk sizes', () => {
      const random = makeRandom(5)
      const values = []
      for (let chunk = 0; chunk < 500; chunk++) {
        values.push(50000)
        values.push(random.int(180000, 260000))
      }
      assert.deepEqual(roundTrip(values, options), values)
    })

    it('costs little when every chunk holds the same point count', () => {
      const encoder = new ArithmeticEncoder()
      const compressor = new IntegerCompressor(encoder, 32, 2)
      let previous = 0
      for (let chunk = 0; chunk < 1000; chunk++) {
        compressor.compress(previous, 50000, 0)
        previous = 50000
      }
      // A constant series predicts perfectly, so it should cost far less than
      // the four bytes per entry an uncompressed table would.
      assert.ok(encoder.done().byteLength < 1000)
    })
  })

  describe('exhaustive small range', () => {
    it('round-trips every value a 10-bit field can hold, against a fixed prediction', () => {
      const encoder = new ArithmeticEncoder()
      const compressor = new IntegerCompressor(encoder, 10, 1)
      const values = Array.from({ length: 1024 }, (_, index) => index)
      for (const value of values) compressor.compress(512, value, 0)
      const bytes = encoder.done()

      const decoder = new ArithmeticDecoder(bytes)
      const decompressor = new IntegerDecompressor(decoder, 10, 1)
      assert.deepEqual(values.map(() => decompressor.decompress(512, 0)), values)
    })
  })
})
