import { assertByteSource, readExact } from './byte-source.js'
import { readCrs } from './crs.js'
import { LasFormatError, LasUnsupportedError } from './errors.js'
import { BinaryReader } from './binary-reader.js'
import { MAX_HEADER_SIZE, parseHeader } from './header.js'
import { decodePoint, getPointFormat } from './point-format.js'
import { parseEvlrs, parseVlrs } from './vlr.js'

/** Bytes read per block while iterating points, rounded down to whole records. */
const DEFAULT_CHUNK_BYTES = 1 << 20

/**
 * Reads a LAS file from any random-access ByteSource.
 *
 * There is no streaming state machine. The header says where everything is, so
 * the reader addresses the file directly: that removes any dependence on how
 * the bytes happen to be delivered, makes seeking free, and means nothing here
 * imports node:stream.
 */
export class LasReader {
  #source
  #options
  #format
  #pointsEnd

  /**
   * @param {import('./byte-source.js').ByteSource} source
   * @param {object} parts
   * @param {object} [options]
   */
  constructor (source, parts, options = {}) {
    this.#source = source
    this.#options = options
    this.header = parts.header
    this.vlrs = parts.vlrs
    this.evlrs = parts.evlrs
    /** VLRs and EVLRs together, in file order. */
    this.records = [...parts.vlrs, ...parts.evlrs]
    this.crs = readCrs(this.records, parts.header)
    this.#format = getPointFormat(parts.header.pointDataRecordFormat)
    this.#pointsEnd = parts.pointsEnd
  }

  /**
   * Opens a source and reads its header, variable length records and extended
   * variable length records.
   *
   * @param {import('./byte-source.js').ByteSource} source
   * @param {{ allowTruncated?: boolean }} [options]
   * @returns {Promise<LasReader>}
   */
  static async open (source, options = {}) {
    assertByteSource(source)

    const headerBytes = await readExact(source, 0, Math.min(MAX_HEADER_SIZE, source.byteLength))
    const header = parseHeader(headerBytes)

    if (header.compressed) {
      throw new LasUnsupportedError(
        'this file is LASzip compressed; open it with @qgustavor/las-reader/laz instead'
      )
    }

    if (header.offsetToPointData > source.byteLength) {
      throw new LasFormatError(
        `point data starts at ${header.offsetToPointData} but the file is ${source.byteLength} bytes`,
        { offset: 96 }
      )
    }

    const vlrs = header.numberOfVariableLengthRecords > 0
      ? parseVlrs(
        await readExact(source, header.headerSize, header.offsetToPointData - header.headerSize),
        header.numberOfVariableLengthRecords,
        header.headerSize
      )
      : []

    const evlrs = header.numberOfEvlrs > 0 && header.startOfFirstEvlr > 0 &&
      header.startOfFirstEvlr < source.byteLength
      ? parseEvlrs(
        await readExact(source, header.startOfFirstEvlr, source.byteLength - header.startOfFirstEvlr),
        header.numberOfEvlrs,
        header.startOfFirstEvlr
      )
      : []

    const declaredEnd = header.offsetToPointData + header.pointCount * header.pointDataRecordLength
    let pointsEnd = declaredEnd
    if (declaredEnd > source.byteLength) {
      if (!options.allowTruncated) {
        const available = Math.floor(
          (source.byteLength - header.offsetToPointData) / header.pointDataRecordLength
        )
        throw new LasFormatError(
          `header declares ${header.pointCount} points, but the file only holds ${available}; ` +
          'pass { allowTruncated: true } to read what is there',
          { offset: 107 }
        )
      }
      pointsEnd = header.offsetToPointData +
        Math.floor((source.byteLength - header.offsetToPointData) / header.pointDataRecordLength) *
        header.pointDataRecordLength
    }

    return new LasReader(source, { header, vlrs, evlrs, pointsEnd }, options)
  }

  /** How many point records this reader will actually produce. */
  get pointCount () {
    return Math.floor(
      (this.#pointsEnd - this.header.offsetToPointData) / this.header.pointDataRecordLength
    )
  }

  /** The point data record format descriptor. */
  get pointFormat () {
    return this.#format
  }

  #resolveRange (start, count) {
    const total = this.pointCount
    if (!Number.isInteger(start) || start < 0) {
      throw new RangeError(`start must be a non-negative integer, got ${start}`)
    }
    const from = Math.min(start, total)
    const to = count === undefined ? total : Math.min(from + Math.max(0, count), total)
    return { from, to }
  }

  /**
   * Reads a contiguous run of points into an array.
   *
   * This is the seeking primitive: it costs one read regardless of where in the
   * file the run is, so a caller that stopped at point 4 000 000 last time can
   * pick up exactly there.
   *
   * @param {number} [start] index of the first point
   * @param {number} [count] how many to read, defaulting to the rest
   */
  async readPoints (start = 0, count = undefined) {
    const { from, to } = this.#resolveRange(start, count)
    if (to <= from) return []

    const recordLength = this.header.pointDataRecordLength
    const offset = this.header.offsetToPointData + from * recordLength
    const bytes = await readExact(this.#source, offset, (to - from) * recordLength)
    const reader = new BinaryReader(bytes, { origin: offset })

    const points = new Array(to - from)
    for (let index = 0; index < points.length; index++) {
      reader.seek(index * recordLength)
      points[index] = decodePoint(reader, this.#format, this.header, recordLength)
    }
    return points
  }

  /**
   * Reads a single point.
   * @param {number} index
   */
  async readPoint (index) {
    const [point] = await this.readPoints(index, 1)
    return point
  }

  /**
   * Yields raw record blocks: the bytes of a run of points, with enough
   * context to address any record inside them.
   *
   * This is the primitive `chunks()` and the filter helpers are built on. It is
   * public because a caller that wants to reject points on their coordinates
   * alone should not have to decode every field first.
   *
   * @param {{ start?: number, count?: number, chunkSize?: number }} [options]
   * @yields {{ bytes: Uint8Array, firstIndex: number, count: number, recordLength: number, fileOffset: number }}
   */
  async * blocks ({ start = 0, count, chunkSize = DEFAULT_CHUNK_BYTES } = {}) {
    const { from, to } = this.#resolveRange(start, count)
    const recordLength = this.header.pointDataRecordLength
    const perBlock = Math.max(1, Math.floor(chunkSize / recordLength))

    for (let index = from; index < to; index += perBlock) {
      const size = Math.min(perBlock, to - index)
      const fileOffset = this.header.offsetToPointData + index * recordLength
      yield {
        bytes: await readExact(this.#source, fileOffset, size * recordLength),
        firstIndex: index,
        count: size,
        recordLength,
        fileOffset
      }
    }
  }

  /**
   * Yields blocks of points, each an array. Reading in blocks is what keeps the
   * number of source reads proportional to file size rather than point count.
   *
   * @param {{ start?: number, count?: number, chunkSize?: number, reuse?: boolean }} [options]
   */
  async * chunks ({ reuse = false, ...options } = {}) {
    let scratch = null

    for await (const block of this.blocks(options)) {
      const reader = new BinaryReader(block.bytes, { origin: block.fileOffset })
      if (reuse && (scratch === null || scratch.length < block.count)) {
        scratch = Array.from({ length: block.count }, () => ({}))
      }

      const points = reuse ? scratch : new Array(block.count)
      for (let slot = 0; slot < block.count; slot++) {
        reader.seek(slot * block.recordLength)
        points[slot] = decodePoint(
          reader, this.#format, this.header, block.recordLength, reuse ? scratch[slot] : undefined
        )
      }
      yield reuse && points.length !== block.count ? points.slice(0, block.count) : points
    }
  }

  /**
   * Yields points one at a time.
   *
   * With `reuse: true` the same object is handed back every iteration, which
   * removes the per-point allocation but means the caller must copy anything it
   * intends to keep.
   *
   * @param {{ start?: number, count?: number, chunkSize?: number, reuse?: boolean }} [options]
   */
  async * points (options = {}) {
    for await (const block of this.chunks(options)) {
      yield * block
    }
  }

  /**
   * A whatwg ReadableStream of point blocks, for callers that want
   * backpressure, `pipeThrough` or `tee`. Web Streams exist in Node and in
   * browsers, so this adds nothing to a bundle.
   *
   * @param {{ start?: number, count?: number, chunkSize?: number }} [options]
   * @returns {ReadableStream<object[]>}
   */
  stream (options = {}) {
    const iterator = this.chunks(options)[Symbol.asyncIterator]()
    return new ReadableStream({
      async pull (controller) {
        const { value, done } = await iterator.next()
        if (done) controller.close()
        else controller.enqueue(value)
      },
      async cancel (reason) {
        await iterator.return?.(reason)
      }
    })
  }

  /** Iterating the reader iterates its points. */
  [Symbol.asyncIterator] () {
    return this.points()
  }

  /** Releases the underlying source, if it holds anything. */
  async close () {
    await this.#source.close?.()
  }
}
