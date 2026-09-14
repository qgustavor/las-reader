import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ArithmeticBitModel,
  ArithmeticDecoder,
  ArithmeticModel
} from '../src/laz/arithmetic-decoder.js'
import { ArithmeticEncoder, encoderBitModel, encoderModel } from './helpers/arithmetic-encoder.js'
import { makeRandom } from './helpers/random.js'

/**
 * These tests encode a known sequence and check the decoder returns it. That
 * establishes the two halves agree, not that either matches LASzip; the
 * conformance check is the chunk table, whose sizes must sum to the compressed
 * byte range of a real file.
 *
 * What a round trip does catch, and catches sharply, is the arithmetic itself:
 * a missing `>>> 0`, a shift that should have been signed, a model updated at
 * the wrong moment. Those desynchronise the two intervals within a few symbols
 * and every later value comes back wrong.
 */

describe('ArithmeticDecoder', () => {
  describe('raw bits', () => {
    it('round-trips values of assorted widths', () => {
      const widths = [1, 3, 8, 9, 16, 19, 20, 24, 32]
      const values = [1, 5, 200, 300, 65535, 524287, 1048575, 16777215, 4294967295]

      const encoder = new ArithmeticEncoder()
      widths.forEach((width, index) => encoder.writeBits(width, values[index]))
      const bytes = encoder.done()

      const decoder = new ArithmeticDecoder(bytes)
      assert.deepEqual(widths.map((width) => decoder.readBits(width)), values)
    })

    it('round-trips a long random run', () => {
      const random = makeRandom(7)
      const items = Array.from({ length: 400 }, () => {
        const width = random.int(1, 32)
        return { width, value: random.int(0, 2 ** Math.min(width, 30) - 1) }
      })

      const encoder = new ArithmeticEncoder()
      for (const item of items) encoder.writeBits(item.width, item.value)
      const decoder = new ArithmeticDecoder(encoder.done())

      for (const [index, item] of items.entries()) {
        assert.equal(decoder.readBits(item.width), item.value, `item ${index}`)
      }
    })
  })

  describe('bit model', () => {
    it('round-trips a skewed sequence', () => {
      const bits = Array.from({ length: 1000 }, (_, index) => (index % 11 === 0 ? 1 : 0))

      const encoder = new ArithmeticEncoder()
      const writeModel = encoderBitModel()
      for (const bit of bits) encoder.encodeBit(writeModel, bit)
      const bytes = encoder.done()

      const decoder = new ArithmeticDecoder(bytes)
      const readModel = new ArithmeticBitModel()
      assert.deepEqual(bits.map(() => decoder.decodeBit(readModel)), bits)
    })

    it('spends fewer bytes on a predictable sequence than a random one', () => {
      const size = (bits) => {
        const encoder = new ArithmeticEncoder()
        const model = encoderBitModel()
        for (const bit of bits) encoder.encodeBit(model, bit)
        return encoder.done().byteLength
      }

      const random = makeRandom(3)
      const predictable = Array.from({ length: 2000 }, () => 0)
      const unpredictable = Array.from({ length: 2000 }, () => (random.bool() ? 1 : 0))

      assert.ok(size(predictable) < size(unpredictable) / 4)
    })
  })

  describe('symbol model', () => {
    // 16 is the boundary: above it the decoder builds a lookup table and takes
    // a different path through decodeSymbol, so both sides of it are tested.
    for (const alphabet of [2, 4, 16, 17, 33, 256]) {
      it(`round-trips an alphabet of ${alphabet}`, () => {
        const random = makeRandom(alphabet)
        const sequence = Array.from({ length: 3000 }, () => random.int(0, alphabet - 1))

        const encoder = new ArithmeticEncoder()
        const writeModel = encoderModel(alphabet)
        for (const symbol of sequence) encoder.encodeSymbol(writeModel, symbol)
        const bytes = encoder.done()

        const decoder = new ArithmeticDecoder(bytes)
        const readModel = new ArithmeticModel(alphabet)
        for (const [index, symbol] of sequence.entries()) {
          assert.equal(decoder.decodeSymbol(readModel), symbol, `symbol ${index}`)
        }
      })
    }

    it('round-trips a run long enough to force several model updates', () => {
      const random = makeRandom(99)
      // Skewed, so the model's counts move and then get halved at the ceiling.
      const sequence = Array.from({ length: 40000 }, () =>
        (random.next() < 0.9 ? 3 : random.int(0, 31)))

      const encoder = new ArithmeticEncoder()
      const writeModel = encoderModel(32)
      for (const symbol of sequence) encoder.encodeSymbol(writeModel, symbol)
      const bytes = encoder.done()

      const decoder = new ArithmeticDecoder(bytes)
      const readModel = new ArithmeticModel(32)
      for (const [index, symbol] of sequence.entries()) {
        assert.equal(decoder.decodeSymbol(readModel), symbol, `symbol ${index}`)
      }
    })

    it('builds a lookup table only above 16 symbols', () => {
      assert.equal(new ArithmeticModel(16).decoderTable, null)
      assert.notEqual(new ArithmeticModel(17).decoderTable, null)
      // An encoder never needs one.
      assert.equal(new ArithmeticModel(256, true).decoderTable, null)
    })
  })

  describe('mixed operations', () => {
    it('interleaves bits, symbols and raw reads', () => {
      const random = makeRandom(21)
      const operations = Array.from({ length: 1500 }, () => {
        const kind = random.pick(['bit', 'symbol', 'raw'])
        if (kind === 'bit') return { kind, value: random.bool() ? 1 : 0 }
        if (kind === 'symbol') return { kind, value: random.int(0, 39) }
        const width = random.int(1, 16)
        return { kind, width, value: random.int(0, 2 ** width - 1) }
      })

      const encoder = new ArithmeticEncoder()
      const writeBit = encoderBitModel()
      const writeSymbol = encoderModel(40)
      for (const operation of operations) {
        if (operation.kind === 'bit') encoder.encodeBit(writeBit, operation.value)
        else if (operation.kind === 'symbol') encoder.encodeSymbol(writeSymbol, operation.value)
        else encoder.writeBits(operation.width, operation.value)
      }
      const bytes = encoder.done()

      const decoder = new ArithmeticDecoder(bytes)
      const readBit = new ArithmeticBitModel()
      const readSymbol = new ArithmeticModel(40)
      for (const [index, operation] of operations.entries()) {
        const decoded = operation.kind === 'bit'
          ? decoder.decodeBit(readBit)
          : operation.kind === 'symbol'
            ? decoder.decodeSymbol(readSymbol)
            : decoder.readBits(operation.width)
        assert.equal(decoded, operation.value, `operation ${index} (${operation.kind})`)
      }
    })
  })

  describe('input handling', () => {
    it('starts at a given offset', () => {
      const encoder = new ArithmeticEncoder()
      encoder.writeBits(16, 4242)
      const coded = encoder.done()

      const padded = new Uint8Array(coded.byteLength + 9)
      padded.set(coded, 9)

      assert.equal(new ArithmeticDecoder(padded, 9).readBits(16), 4242)
    })

    it('reads zeroes past the end rather than throwing, and says so', () => {
      const decoder = new ArithmeticDecoder(new Uint8Array(2))
      assert.equal(decoder.overran, true)
      assert.doesNotThrow(() => decoder.readBits(8))
    })

    it('does not report an overrun on a stream with enough bytes', () => {
      const encoder = new ArithmeticEncoder()
      encoder.writeBits(8, 1)
      const decoder = new ArithmeticDecoder(encoder.done())
      decoder.readBits(8)
      assert.equal(decoder.overran, false)
    })

    it('refuses anything that is not a typed array', () => {
      assert.throws(() => new ArithmeticDecoder([1, 2, 3, 4]), TypeError)
    })
  })
})
