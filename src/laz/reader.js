import { assertByteSource, readExact } from '../byte-source.js'
import { LasFormatError, LasUnsupportedError } from '../errors.js'
import { MAX_HEADER_SIZE, parseHeader } from '../header.js'
import { LasReader } from '../reader.js'
import { readRecords } from '../vlr.js'
import { assertLazBackend, lazPerfBackend } from './backend.js'
import { chunksForRange, readChunkTable } from './chunk-table.js'
import { assertVlrMatchesHeader, findLaszipVlr } from './laszip-vlr.js'

/**
 * Reads a LASzip-compressed file.
 *
 * Everything a LAZ file holds besides the points themselves is ordinary LAS: a
 * public header block, VLRs, EVLRs. So this subclasses the uncompressed reader
 * and replaces exactly one thing — where the bytes of a run of point records
 * come from. Decoding, seeking, block iteration, filtering and streaming are
 * inherited unchanged, and a point read from a .laz file is indistinguishable
 * from the same point read from the .las it was made from.
 *
 * Random access survives compression because of the chunk table: a point's
 * chunk can be located and decompressed on its own, without touching the ones
 * before it. Reading one point in the middle of a 200 million point file costs
 * one chunk, not the whole file.
 */
export class LazReader extends LasReader {
  #source
  #vlr
  #chunkTable
  #backend
  #backendOptions
  #ownsBackend
  #cache = new Map()
  #cacheLimit
  #pointCount

  constructor (source, parts, options = {}) {
    super(source, parts, options)
    this.#source = source
    this.#vlr = parts.laszipVlr
    this.#chunkTable = parts.chunkTable
    this.#backend = options.backend === undefined ? null : assertLazBackend(options.backend)
    this.#ownsBackend = options.backend === undefined
    this.#backendOptions = options.lazPerf
    this.#cacheLimit = Math.max(1, options.cacheChunks ?? 1)
    this.#pointCount = parts.chunkTable.chunks.reduce((sum, chunk) => sum + chunk.pointCount, 0)
  }

  /**
   * Opens a compressed source.
   *
   * The WASM module is not created here. Compiling it costs more than reading
   * the header, and a caller that only wants the bounds, the point count or the
   * coordinate system never needs it.
   *
   * @param {import('../byte-source.js').ByteSource} source
   * @param {{ backend?: import('./backend.js').LazBackend, lazPerf?: object,
   *   cacheChunks?: number, allowTruncated?: boolean, maxRecordPayload?: number }} [options]
   * @returns {Promise<LazReader>}
   */
  static async open (source, options = {}) {
    assertByteSource(source)

    const headerBytes = await readExact(source, 0, Math.min(MAX_HEADER_SIZE, source.byteLength))
    const header = parseHeader(headerBytes)

    if (!header.compressed) {
      throw new LasFormatError(
        'this file is not compressed; open it with LasReader, which reads it directly'
      )
    }
    if (header.offsetToPointData > source.byteLength) {
      throw new LasFormatError(
        `point data starts at ${header.offsetToPointData} but the file is ${source.byteLength} bytes`,
        { offset: 96 }
      )
    }

    const vlrs = header.numberOfVariableLengthRecords > 0
      ? await readRecords(
        source, header.headerSize, header.offsetToPointData,
        header.numberOfVariableLengthRecords, { maxPayload: options.maxRecordPayload }
      )
      : []

    const laszipVlr = findLaszipVlr(vlrs)
    if (laszipVlr === undefined) {
      throw new LasFormatError(
        'the point data record format is marked compressed but the file carries no ' +
        'LASzip VLR, so nothing describes how to decompress it'
      )
    }
    assertVlrMatchesHeader(laszipVlr, header)

    // laz-perf picks its codec from the point format alone, so it assumes the
    // modern item versions. A file using the original pointwise scheme would
    // decode into noise rather than failing, which is worth refusing outright.
    if (!laszipVlr.chunked) {
      throw new LasUnsupportedError(
        `this file uses the ${laszipVlr.compressorName} LASzip scheme, which has no ` +
        'chunk table; only chunked files can be read'
      )
    }

    const evlrs = header.numberOfEvlrs > 0 && header.startOfFirstEvlr > 0 &&
      header.startOfFirstEvlr < source.byteLength
      ? await readRecords(
        source, header.startOfFirstEvlr, source.byteLength,
        header.numberOfEvlrs, { extended: true, maxPayload: options.maxRecordPayload }
      )
      : []

    const chunkTable = await readChunkTable(source, header, laszipVlr, options)

    const declared = chunkTable.chunks.reduce((sum, chunk) => sum + chunk.pointCount, 0)
    if (declared !== header.pointCount && !options.allowTruncated) {
      throw new LasFormatError(
        `the chunk table accounts for ${declared} points but the header declares ` +
        `${header.pointCount}; pass { allowTruncated: true } to read the ${declared} ` +
        'that are there'
      )
    }

    return new LazReader(
      source,
      { header, vlrs, evlrs, laszipVlr, chunkTable, pointsEnd: 0 },
      options
    )
  }

  /** The parsed LASzip VLR. */
  get laszipVlr () {
    return this.#vlr
  }

  /** The chunk table, which says where every chunk starts and how big it is. */
  get chunkTable () {
    return this.#chunkTable
  }

  /**
   * How many points this reader will produce.
   *
   * Counted from the chunk table rather than the header, for the same reason
   * the uncompressed reader counts from the bytes actually present: on a
   * truncated file the header still claims the points that were meant to be
   * there. The inherited getter cannot be used because it divides a byte range
   * by the record length, which on a compressed file measures compressed bytes.
   */
  get pointCount () {
    return this.#pointCount
  }

  async #decompress (chunk) {
    const cached = this.#cache.get(chunk.index)
    if (cached !== undefined) {
      // Refresh its position: a Map iterates in insertion order, so deleting
      // and re-adding is what makes the eviction below least-recently-used.
      this.#cache.delete(chunk.index)
      this.#cache.set(chunk.index, cached)
      return cached
    }

    if (this.#backend === null) this.#backend = await lazPerfBackend(this.#backendOptions)

    const compressed = await readExact(this.#source, chunk.offset, chunk.byteLength)
    const bytes = this.#backend.decodeChunk({
      bytes: compressed,
      pointCount: chunk.pointCount,
      pointFormat: this.header.pointDataRecordFormat,
      recordLength: this.header.pointDataRecordLength
    })

    const expected = chunk.pointCount * this.header.pointDataRecordLength
    if (bytes.byteLength !== expected) {
      throw new LasFormatError(
        `decompressing chunk ${chunk.index} produced ${bytes.byteLength} bytes, ` +
        `not the ${expected} its ${chunk.pointCount} points need`
      )
    }

    this.#cache.set(chunk.index, bytes)
    while (this.#cache.size > this.#cacheLimit) {
      this.#cache.delete(this.#cache.keys().next().value)
    }
    return bytes
  }

  /**
   * Decompresses whatever chunks a run of points falls in and returns their
   * records, joined.
   *
   * @param {number} from
   * @param {number} to
   * @returns {Promise<Uint8Array>}
   * @override
   */
  async readPointBytes (from, to) {
    const recordLength = this.header.pointDataRecordLength
    const output = new Uint8Array((to - from) * recordLength)

    for (const chunk of chunksForRange(this.#chunkTable, from, to - from)) {
      const bytes = await this.#decompress(chunk)

      // The overlap between what the caller asked for and what this chunk holds.
      const start = Math.max(from, chunk.firstPoint)
      const end = Math.min(to, chunk.firstPoint + chunk.pointCount)
      if (end <= start) continue

      output.set(
        bytes.subarray(
          (start - chunk.firstPoint) * recordLength,
          (end - chunk.firstPoint) * recordLength
        ),
        (start - from) * recordLength
      )
    }

    return output
  }

  /** Releases the decompressor and the underlying source. */
  async close () {
    this.#cache.clear()
    if (this.#backend !== null && this.#ownsBackend) this.#backend.close?.()
    this.#backend = null
    await super.close()
  }
}
