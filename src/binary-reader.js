import { LasFormatError } from './errors.js'

const decoder = new TextDecoder('utf-8', { fatal: false })

/**
 * A bounds-checked little-endian cursor over a byte range.
 *
 * Every read is validated before it happens, so a truncated or malformed file
 * produces a LasFormatError naming the offset instead of an undefined value, a
 * silently wrapped index, or a RangeError from DataView with no context.
 *
 * `fileOffset` lets a reader over a slice of a file report offsets in terms of
 * the whole file, which is what makes error messages actionable.
 */
export class BinaryReader {
  #bytes
  #view
  #offset
  #origin

  /**
   * @param {Uint8Array} bytes
   * @param {{ origin?: number }} [options] byte offset of `bytes` within the file
   */
  constructor (bytes, { origin = 0 } = {}) {
    if (!ArrayBuffer.isView(bytes)) {
      throw new TypeError('BinaryReader expects a typed array')
    }
    this.#bytes = bytes
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    this.#offset = 0
    this.#origin = origin
  }

  /** Cursor position relative to the start of this reader. */
  get offset () {
    return this.#offset
  }

  /** Cursor position relative to the start of the file. */
  get fileOffset () {
    return this.#origin + this.#offset
  }

  /** Total size of the region this reader covers. */
  get byteLength () {
    return this.#bytes.byteLength
  }

  /** Bytes left between the cursor and the end of the region. */
  get remaining () {
    return this.#bytes.byteLength - this.#offset
  }

  /** True while there is at least one byte left. */
  get hasMore () {
    return this.#offset < this.#bytes.byteLength
  }

  #check (size, what) {
    if (this.#offset + size > this.#bytes.byteLength) {
      throw new LasFormatError(
        `unexpected end of data reading ${what}: needed ${size} bytes, ${this.remaining} available`,
        { offset: this.fileOffset }
      )
    }
  }

  /**
   * Moves the cursor to an absolute position within the region.
   * @param {number} offset
   */
  seek (offset) {
    if (!Number.isInteger(offset) || offset < 0 || offset > this.#bytes.byteLength) {
      throw new LasFormatError(
        `cannot seek to ${offset}: region is ${this.#bytes.byteLength} bytes`,
        { offset: this.#origin + Math.max(0, offset) }
      )
    }
    this.#offset = offset
    return this
  }

  /**
   * Advances the cursor.
   * @param {number} count
   */
  skip (count) {
    return this.seek(this.#offset + count)
  }

  u8 () {
    this.#check(1, 'u8')
    return this.#view.getUint8(this.#offset++)
  }

  i8 () {
    this.#check(1, 'i8')
    return this.#view.getInt8(this.#offset++)
  }

  u16 () {
    this.#check(2, 'u16')
    const value = this.#view.getUint16(this.#offset, true)
    this.#offset += 2
    return value
  }

  i16 () {
    this.#check(2, 'i16')
    const value = this.#view.getInt16(this.#offset, true)
    this.#offset += 2
    return value
  }

  u32 () {
    this.#check(4, 'u32')
    const value = this.#view.getUint32(this.#offset, true)
    this.#offset += 4
    return value
  }

  i32 () {
    this.#check(4, 'i32')
    const value = this.#view.getInt32(this.#offset, true)
    this.#offset += 4
    return value
  }

  /** @returns {bigint} */
  u64 () {
    this.#check(8, 'u64')
    const value = this.#view.getBigUint64(this.#offset, true)
    this.#offset += 8
    return value
  }

  /** @returns {bigint} */
  i64 () {
    this.#check(8, 'i64')
    const value = this.#view.getBigInt64(this.#offset, true)
    this.#offset += 8
    return value
  }

  /**
   * Reads a u64 and narrows it to a Number, which every offset and count in
   * this library is expressed as. Throws rather than silently losing precision.
   * @param {string} what name used in the error message
   */
  u64AsNumber (what = 'value') {
    const offset = this.fileOffset
    const value = this.u64()
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new LasFormatError(
        `${what} is ${value}, which exceeds the largest exactly representable integer`,
        { offset }
      )
    }
    return Number(value)
  }

  f32 () {
    this.#check(4, 'f32')
    const value = this.#view.getFloat32(this.#offset, true)
    this.#offset += 4
    return value
  }

  f64 () {
    this.#check(8, 'f64')
    const value = this.#view.getFloat64(this.#offset, true)
    this.#offset += 8
    return value
  }

  /**
   * Reads `count` bytes as a view onto the same buffer. No copy is made, so the
   * result stays valid only as long as the underlying buffer does.
   * @param {number} count
   */
  bytes (count) {
    this.#check(count, `${count} bytes`)
    const value = this.#bytes.subarray(this.#offset, this.#offset + count)
    this.#offset += count
    return value
  }

  /**
   * Reads a fixed-width character field. LAS pads these with NULs; anything
   * from the first NUL onwards is discarded, and the result is trimmed.
   * @param {number} count
   */
  string (count) {
    const raw = this.bytes(count)
    const end = raw.indexOf(0)
    return decoder.decode(end === -1 ? raw : raw.subarray(0, end)).trim()
  }

  /**
   * Returns an independent reader over the next `count` bytes and advances past
   * them. Used to give each record a cursor that cannot read its neighbours.
   * @param {number} count
   */
  subreader (count) {
    const origin = this.fileOffset
    return new BinaryReader(this.bytes(count), { origin })
  }
}
