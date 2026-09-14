/**
 * The arithmetic decoder LASzip codes with.
 *
 * This is Amir Said's range coder, the same one LASzip uses, reimplemented in
 * JavaScript. It is here for one reason: the chunk table at the end of a LAZ
 * file is arithmetic-coded, and laz-perf's JavaScript build exposes no way to
 * read it. Without the chunk table there are no chunk offsets, and without
 * chunk offsets there is no random access — only decoding every point from the
 * start of the file, which is the thing this library exists to avoid.
 *
 * The point codecs stay in WASM. Only this much of the coder is needed on the
 * JavaScript side, and it runs once per file rather than once per point.
 *
 * Every value here is 32-bit unsigned. JavaScript numbers are doubles and `<<`
 * coerces to *signed* 32-bit, so every shift and add is followed by `>>> 0` to
 * put the value back in unsigned range. Dropping one of those does not throw;
 * it silently decodes the wrong symbol.
 */

/** Threshold below which the interval is renormalised. */
const MIN_LENGTH = 0x01000000

/** Initial interval length: the whole 32-bit range. */
const MAX_LENGTH = 0xffffffff

/** Interval bits discarded before multiplying, for bit models. */
const BM_LENGTH_SHIFT = 13
const BM_MAX_COUNT = 1 << BM_LENGTH_SHIFT

/** Interval bits discarded before multiplying, for symbol models. */
const DM_LENGTH_SHIFT = 15
const DM_MAX_COUNT = 1 << DM_LENGTH_SHIFT

/**
 * An adaptive binary model: one probability, updated as bits arrive.
 */
export class ArithmeticBitModel {
  constructor () {
    this.init()
  }

  init () {
    // Equiprobable until the data says otherwise.
    this.bit0Count = 1
    this.bitCount = 2
    this.bit0Prob = 1 << (BM_LENGTH_SHIFT - 1)
    // Update often at first, then progressively less often.
    this.updateCycle = 4
    this.bitsUntilUpdate = 4
  }

  update () {
    this.bitCount += this.updateCycle
    if (this.bitCount > BM_MAX_COUNT) {
      // Halve the counts so recent bits outweigh old ones.
      this.bitCount = (this.bitCount + 1) >>> 1
      this.bit0Count = (this.bit0Count + 1) >>> 1
      if (this.bit0Count === this.bitCount) this.bitCount++
    }

    const scale = Math.floor(0x80000000 / this.bitCount)
    this.bit0Prob = Math.floor((this.bit0Count * scale) / (2 ** (31 - BM_LENGTH_SHIFT)))

    this.updateCycle = (5 * this.updateCycle) >>> 2
    if (this.updateCycle > 64) this.updateCycle = 64
    this.bitsUntilUpdate = this.updateCycle
  }
}

/**
 * An adaptive model over `symbols` symbols.
 *
 * Above 16 symbols a lookup table is built alongside the cumulative
 * distribution so that decoding starts from a close guess rather than a binary
 * search over the whole alphabet. The table is decode-only; an encoder skips
 * building it, which is what the `compress` flag on `update` selects.
 */
export class ArithmeticModel {
  /**
   * @param {number} symbols size of the alphabet
   * @param {boolean} [compress] true for an encoder, which needs no lookup table
   */
  constructor (symbols, compress = false) {
    this.symbols = symbols
    this.compress = compress
    this.init()
  }

  init (table = null) {
    this.lastSymbol = this.symbols - 1

    if (!this.compress && this.symbols > 16) {
      let tableBits = 3
      while (this.symbols > (1 << (tableBits + 2))) tableBits++
      this.tableSize = 1 << tableBits
      this.tableShift = DM_LENGTH_SHIFT - tableBits
      this.decoderTable = new Uint32Array(this.tableSize + 2)
    } else {
      this.decoderTable = null
      this.tableSize = 0
      this.tableShift = 0
    }

    this.distribution = new Uint32Array(this.symbols)
    this.symbolCount = new Uint32Array(this.symbols)

    this.totalCount = 0
    this.updateCycle = this.symbols
    for (let index = 0; index < this.symbols; index++) {
      this.symbolCount[index] = table === null ? 1 : table[index]
    }

    this.update()
    this.updateCycle = (this.symbols + 6) >>> 1
    this.symbolsUntilUpdate = this.updateCycle
  }

  update () {
    this.totalCount += this.updateCycle
    if (this.totalCount > DM_MAX_COUNT) {
      this.totalCount = 0
      for (let index = 0; index < this.symbols; index++) {
        this.symbolCount[index] = (this.symbolCount[index] + 1) >>> 1
        this.totalCount += this.symbolCount[index]
      }
    }

    // 0x80000000 / totalCount, then scaled down by 2^16 below: the product
    // stays under 2^31 so it never leaves the range a double represents exactly.
    const scale = Math.floor(0x80000000 / this.totalCount)
    let sum = 0
    let slot = 0

    if (this.decoderTable === null) {
      for (let index = 0; index < this.symbols; index++) {
        this.distribution[index] = Math.floor((scale * sum) / 65536)
        sum += this.symbolCount[index]
      }
    } else {
      for (let index = 0; index < this.symbols; index++) {
        this.distribution[index] = Math.floor((scale * sum) / 65536)
        sum += this.symbolCount[index]
        const bucket = this.distribution[index] >>> this.tableShift
        while (slot < bucket) this.decoderTable[++slot] = index - 1
      }
      this.decoderTable[0] = 0
      while (slot <= this.tableSize) this.decoderTable[++slot] = this.symbols - 1
    }

    this.updateCycle = (5 * this.updateCycle) >>> 2
    const maxCycle = (this.symbols + 6) << 3
    if (this.updateCycle > maxCycle) this.updateCycle = maxCycle
    this.symbolsUntilUpdate = this.updateCycle
  }
}

/**
 * Decodes symbols from a byte range.
 *
 * Reads past the end of `bytes` yield zero rather than throwing. The coder
 * legitimately reads a few bytes beyond the last one it needs when finishing a
 * stream, and a chunk table sitting at the very end of a file has nothing after
 * it to supply them.
 */
export class ArithmeticDecoder {
  #bytes
  #cursor
  #end

  /**
   * @param {Uint8Array} bytes
   * @param {number} [offset] where in `bytes` the coded stream begins
   */
  constructor (bytes, offset = 0) {
    if (!ArrayBuffer.isView(bytes)) {
      throw new TypeError('ArithmeticDecoder expects a typed array')
    }
    this.#bytes = bytes
    this.#cursor = offset
    this.#end = bytes.byteLength
    this.overran = false

    this.length = MAX_LENGTH
    this.value = (
      (this.#byte() << 24) | (this.#byte() << 16) | (this.#byte() << 8) | this.#byte()
    ) >>> 0
  }

  /** How many bytes have been consumed, including any read past the end. */
  get bytesRead () {
    return this.#cursor
  }

  #byte () {
    if (this.#cursor >= this.#end) {
      this.overran = true
      this.#cursor++
      return 0
    }
    return this.#bytes[this.#cursor++]
  }

  #renormalise () {
    do {
      this.value = ((this.value << 8) >>> 0) + this.#byte()
      this.length = (this.length << 8) >>> 0
    } while (this.length < MIN_LENGTH)
  }

  /**
   * @param {ArithmeticBitModel} model
   * @returns {number} 0 or 1
   */
  decodeBit (model) {
    const split = model.bit0Prob * (this.length >>> BM_LENGTH_SHIFT)
    const symbol = this.value >= split ? 1 : 0

    if (symbol === 0) {
      this.length = split
      model.bit0Count++
    } else {
      this.value -= split
      this.length -= split
    }

    if (this.length < MIN_LENGTH) this.#renormalise()
    if (--model.bitsUntilUpdate === 0) model.update()

    return symbol
  }

  /**
   * @param {ArithmeticModel} model
   * @returns {number} the decoded symbol
   */
  decodeSymbol (model) {
    let symbol
    let low
    let high = this.length

    if (model.decoderTable !== null) {
      this.length = this.length >>> DM_LENGTH_SHIFT
      const scaled = Math.floor(this.value / this.length)

      // The table gives a starting bracket; the search only refines it.
      const slot = scaled >>> model.tableShift
      symbol = model.decoderTable[slot]
      let bound = model.decoderTable[slot + 1] + 1
      while (bound > symbol + 1) {
        const middle = (symbol + bound) >>> 1
        if (model.distribution[middle] > scaled) bound = middle
        else symbol = middle
      }

      low = model.distribution[symbol] * this.length
      if (symbol !== model.lastSymbol) high = model.distribution[symbol + 1] * this.length
    } else {
      symbol = 0
      low = 0
      this.length = this.length >>> DM_LENGTH_SHIFT
      let bound = model.symbols
      let middle = bound >>> 1
      do {
        const edge = this.length * model.distribution[middle]
        if (edge > this.value) {
          bound = middle
          high = edge
        } else {
          symbol = middle
          low = edge
        }
        middle = (symbol + bound) >>> 1
      } while (middle !== symbol)
    }

    this.value -= low
    this.length = high - low

    if (this.length < MIN_LENGTH) this.#renormalise()
    model.symbolCount[symbol]++
    if (--model.symbolsUntilUpdate === 0) model.update()

    return symbol
  }

  /**
   * Reads `bits` raw bits, bypassing any model.
   * @param {number} bits 1 to 32
   */
  readBits (bits) {
    if (bits > 19) {
      const low = this.readBits(16)
      const high = this.readBits(bits - 16)
      return ((high * 65536) + low) >>> 0
    }
    this.length = this.length >>> bits
    const symbol = Math.floor(this.value / this.length)
    this.value -= symbol * this.length
    if (this.length < MIN_LENGTH) this.#renormalise()
    return symbol
  }
}
