import { ArithmeticBitModel, ArithmeticModel } from '../../src/laz/arithmetic-decoder.js'

/**
 * The encoding half of LASzip's arithmetic coder.
 *
 * This ships with the tests, not the library: nothing here writes LAZ files.
 * It exists so the decoder can be exercised without a compressed fixture to
 * hand, by encoding a known sequence and checking it comes back.
 *
 * A round trip proves the two halves agree with each other. It does not prove
 * either agrees with LASzip — that check needs a real file, and belongs to the
 * chunk table, where a wrong decoder shows up as chunk sizes that do not sum to
 * the compressed byte range.
 */

const MIN_LENGTH = 0x01000000
const MAX_LENGTH = 0xffffffff
const BM_LENGTH_SHIFT = 13
const DM_LENGTH_SHIFT = 15

export class ArithmeticEncoder {
  constructor () {
    this.bytes = []
    this.base = 0
    this.length = MAX_LENGTH
  }

  #propagateCarry () {
    let index = this.bytes.length - 1
    while (this.bytes[index] === 0xff) {
      this.bytes[index] = 0
      index--
    }
    this.bytes[index]++
  }

  #renormalise () {
    do {
      this.bytes.push((this.base >>> 24) & 0xff)
      this.base = (this.base << 8) >>> 0
      this.length = (this.length << 8) >>> 0
    } while (this.length < MIN_LENGTH)
  }

  #addToBase (amount) {
    const before = this.base
    this.base = (this.base + amount) >>> 0
    if (this.base < before) this.#propagateCarry()
  }

  /**
   * @param {ArithmeticBitModel} model
   * @param {number} symbol 0 or 1
   */
  encodeBit (model, symbol) {
    const split = model.bit0Prob * (this.length >>> BM_LENGTH_SHIFT)

    if (symbol === 0) {
      this.length = split
      model.bit0Count++
    } else {
      this.#addToBase(split)
      this.length -= split
    }

    if (this.length < MIN_LENGTH) this.#renormalise()
    if (--model.bitsUntilUpdate === 0) model.update()
  }

  /**
   * @param {ArithmeticModel} model
   * @param {number} symbol
   */
  encodeSymbol (model, symbol) {
    if (symbol === model.lastSymbol) {
      // The interval runs to the top, so there is no upper edge to multiply.
      const low = model.distribution[symbol] * (this.length >>> DM_LENGTH_SHIFT)
      this.#addToBase(low)
      this.length -= low
    } else {
      this.length = this.length >>> DM_LENGTH_SHIFT
      const low = model.distribution[symbol] * this.length
      this.#addToBase(low)
      this.length = model.distribution[symbol + 1] * this.length - low
    }

    if (this.length < MIN_LENGTH) this.#renormalise()
    model.symbolCount[symbol]++
    if (--model.symbolsUntilUpdate === 0) model.update()
  }

  /**
   * @param {number} bits 1 to 32
   * @param {number} symbol
   */
  writeBits (bits, symbol) {
    if (symbol >= 2 ** bits) {
      // Silently encoding this would break the interval invariant and corrupt
      // everything downstream, including values already written.
      throw new RangeError(`${symbol} does not fit in ${bits} bits`)
    }
    if (bits > 19) {
      this.writeBits(16, symbol & 0xffff)
      this.writeBits(bits - 16, Math.floor(symbol / 65536))
      return
    }
    this.length = this.length >>> bits
    this.#addToBase(symbol * this.length)
    if (this.length < MIN_LENGTH) this.#renormalise()
  }

  /**
   * Flushes the coder and returns the encoded bytes.
   * @returns {Uint8Array}
   */
  done () {
    if (this.length > 2 * MIN_LENGTH) {
      this.#addToBase(MIN_LENGTH)
      this.length = MIN_LENGTH >>> 1
    } else {
      this.#addToBase(MIN_LENGTH >>> 1)
      this.length = MIN_LENGTH >>> 9
    }
    this.#renormalise()

    // Trailing bytes so the decoder, which reads slightly ahead, never has to
    // rely on its own read-past-the-end behaviour in these tests.
    this.bytes.push((this.base >>> 24) & 0xff, (this.base >>> 16) & 0xff, 0, 0)
    return Uint8Array.from(this.bytes)
  }
}

/** A symbol model configured for encoding, which needs no lookup table. */
export const encoderModel = (symbols) => new ArithmeticModel(symbols, true)

/** A bit model. Bit models are the same on both sides. */
export const encoderBitModel = () => new ArithmeticBitModel()

/**
 * The encoding half of the integer compressor, mirroring IntegerDecompressor.
 *
 * @see {import('../../src/laz/integer-decompressor.js').IntegerDecompressor}
 */
export class IntegerCompressor {
  constructor (encoder, bits = 16, contexts = 1, bitsHigh = 8, range = 0) {
    this.encoder = encoder
    this.bits = bits
    this.contexts = contexts
    this.bitsHigh = bitsHigh

    if (range !== 0) {
      this.correctorBits = 0
      this.correctorRange = range
      let remaining = range
      while (remaining !== 0) {
        remaining = remaining >>> 1
        this.correctorBits++
      }
      if (this.correctorRange === (1 << (this.correctorBits - 1))) this.correctorBits--
    } else if (bits !== 0 && bits < 32) {
      this.correctorBits = bits
      this.correctorRange = 2 ** bits
    } else {
      this.correctorBits = 32
      this.correctorRange = 0
    }

    if (this.correctorRange === 0) {
      this.correctorMin = -2147483648
      this.correctorMax = 2147483647
    } else {
      this.correctorMin = -(this.correctorRange / 2)
      this.correctorMax = this.correctorMin + this.correctorRange - 1
    }

    this.bitModels = Array.from(
      { length: contexts },
      () => encoderModel(this.correctorBits + 1)
    )
    this.correctorModels = [encoderBitModel()]
    for (let index = 1; index <= this.correctorBits; index++) {
      this.correctorModels.push(encoderModel(2 ** Math.min(index, this.bitsHigh)))
    }
  }

  /**
   * @param {number} prediction
   * @param {number} value
   * @param {number} [context]
   */
  compress (prediction, value, context = 0) {
    let corrector = (value - prediction) | 0
    if (corrector < this.correctorMin) corrector += this.correctorRange
    else if (corrector > this.correctorMax) corrector -= this.correctorRange
    this.#writeCorrector(corrector, this.bitModels[context])
  }

  #writeCorrector (corrector, bitModel) {
    // Mirror of IntegerDecompressor#readCorrector: pick the number of
    // significant bits that puts the corrector in one of the two intervals
    // that `k` describes, then code its position within them.
    let k
    if (corrector === 0 || corrector === 1) k = 0
    else if (corrector > 1) k = bitLength(corrector - 1)
    else k = bitLength(-corrector)

    this.encoder.encodeSymbol(bitModel, k)

    if (k === 0) {
      this.encoder.encodeBit(this.correctorModels[0], corrector)
      return
    }
    if (k >= 32) return

    let coded = corrector > 0 ? corrector - 1 : corrector + (2 ** k - 1)

    if (k <= this.bitsHigh) {
      this.encoder.encodeSymbol(this.correctorModels[k], coded)
    } else {
      const lowBits = k - this.bitsHigh
      const low = coded % (2 ** lowBits)
      coded = Math.floor(coded / (2 ** lowBits))
      this.encoder.encodeSymbol(this.correctorModels[k], coded)
      this.encoder.writeBits(lowBits, low)
    }
  }
}

function bitLength (value) {
  let bits = 0
  let remaining = value
  while (remaining > 0) {
    remaining = Math.floor(remaining / 2)
    bits++
  }
  return bits
}
