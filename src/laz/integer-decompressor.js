import { ArithmeticBitModel, ArithmeticModel } from './arithmetic-decoder.js'

/**
 * LASzip's integer decompressor.
 *
 * Nothing in a LAZ file is coded as a plain integer. Everything is coded as a
 * *correction* to a prediction the decoder can make for itself, which is what
 * makes the format small: successive chunk sizes, like successive coordinates,
 * are close to each other, so the correction is usually a handful of bits.
 *
 * The correction is coded in two parts. First the number of significant bits
 * `k`, from a model chosen by `context` — this is what lets one decompressor
 * keep separate statistics for separate fields. Then the value itself, from a
 * model chosen by `k`, so small corrections and large ones do not pollute each
 * other's statistics. Corrections wider than `bitsHigh` have their low bits
 * read raw, because modelling them buys nothing.
 *
 * Only the decode half is here. This library does not write LAZ.
 */
export class IntegerDecompressor {
  /**
   * @param {import('./arithmetic-decoder.js').ArithmeticDecoder} decoder
   * @param {number} [bits] width of the values being coded
   * @param {number} [contexts] how many independent statistics to keep
   * @param {number} [bitsHigh] widest correction still coded with a model
   * @param {number} [range] explicit value range, when not a power of two
   */
  constructor (decoder, bits = 16, contexts = 1, bitsHigh = 8, range = 0) {
    this.decoder = decoder
    this.bits = bits
    this.contexts = contexts
    this.bitsHigh = bitsHigh
    this.range = range

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
      // A 32-bit value has no range to wrap into, which the zero signals.
      this.correctorBits = 32
      this.correctorRange = 0
    }

    this.#initModels()
  }

  #initModels () {
    this.bitModels = Array.from(
      { length: this.contexts },
      () => new ArithmeticModel(this.correctorBits + 1)
    )

    // Index 0 is a single bit (the correction is 0 or 1); the rest are models
    // over corrections of exactly that many significant bits.
    this.correctorModels = [new ArithmeticBitModel()]
    for (let index = 1; index <= this.correctorBits; index++) {
      const symbols = 2 ** Math.min(index, this.bitsHigh)
      this.correctorModels.push(new ArithmeticModel(symbols))
    }
  }

  /**
   * Decodes one value.
   *
   * @param {number} prediction what the caller expects the value to be near
   * @param {number} [context] which set of statistics to use
   * @returns {number}
   */
  decompress (prediction, context = 0) {
    if (context >= this.contexts) {
      throw new RangeError(`context ${context} is outside the ${this.contexts} configured`)
    }

    let value = (prediction + this.#readCorrector(this.bitModels[context])) | 0

    if (this.correctorRange !== 0) {
      if (value < 0) value += this.correctorRange
      else if (value >= this.correctorRange) value -= this.correctorRange
    }

    return value
  }

  #readCorrector (bitModel) {
    const k = this.decoder.decodeSymbol(bitModel)
    this.k = k

    if (k === 0) {
      // The correction is one bit wide: either 0 or 1.
      return this.decoder.decodeBit(this.correctorModels[0])
    }

    if (k >= 32) {
      // The whole range, which only happens at 32 bits wide.
      return -2147483648
    }

    let corrector
    if (k <= this.bitsHigh) {
      corrector = this.decoder.decodeSymbol(this.correctorModels[k])
    } else {
      // Model the top `bitsHigh` bits, read the rest raw.
      const lowBits = k - this.bitsHigh
      const high = this.decoder.decodeSymbol(this.correctorModels[k])
      const low = this.decoder.readBits(lowBits)
      corrector = (high * (2 ** lowBits)) + low
    }

    // `k` says the correction has k significant bits, which describes two
    // intervals: the positive one just above 2^(k-1) and the negative one just
    // below -(2^(k-1)). The coded value covers both, so shift it back into
    // whichever it belongs to.
    if (corrector >= 2 ** (k - 1)) return corrector + 1
    return corrector - (2 ** k - 1)
  }
}
