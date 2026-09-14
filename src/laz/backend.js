import { createLazPerf } from 'laz-perf'
import { LasError } from '../errors.js'

/**
 * The WASM decompression backend.
 *
 * Everything about a LAZ file except the compressed points themselves is read
 * in JavaScript: the header, the VLRs, the chunk table. This is the one piece
 * that crosses into WASM, and it is deliberately narrow — give it the bytes of
 * one chunk, get back the uncompressed point records, which are then decoded by
 * exactly the same code that reads an uncompressed LAS file.
 *
 * The boundary is crossed once per chunk rather than once per point. A chunk
 * holds 50 000 points by default, so the copy in and the copy out are amortised
 * over the whole chunk and the hot loop stays inside WASM.
 *
 * @typedef {object} LazBackend
 * @property {(chunk: { bytes: Uint8Array, pointCount: number, pointFormat: number, recordLength: number }) => Uint8Array} decodeChunk
 * @property {() => void} close
 */

/**
 * ChunkDecoder.open() takes a pointer but no length, so it has no idea where
 * the chunk ends and will read past it if the stream is malformed. Padding the
 * allocation means such a read stays inside memory we own rather than running
 * into the next allocation.
 */
const OVERRUN_PADDING = 1024

/**
 * Creates a backend backed by laz-perf.
 *
 * Creating the module compiles the WASM, which is slow enough to be worth
 * doing once and sharing between readers.
 *
 * @param {object} [options]
 * @param {object} [options.module] an already-created laz-perf module, to share
 *   one instance across readers or to substitute another implementation
 * @param {(path: string, prefix: string) => string} [options.locateFile] tells
 *   Emscripten where the .wasm file is; browsers usually need this
 * @returns {Promise<LazBackend>}
 */
export async function lazPerfBackend (options = {}) {
  const module = options.module ?? await (
    options.locateFile === undefined
      ? createLazPerf()
      : createLazPerf({ locateFile: options.locateFile })
  )
  return new LazPerfBackend(module)
}

class LazPerfBackend {
  #module
  #chunkPtr = 0
  #chunkCapacity = 0
  #pointPtr = 0
  #pointCapacity = 0
  #closed = false

  constructor (module) {
    if (module === null || typeof module !== 'object' ||
        typeof module._malloc !== 'function' || typeof module.ChunkDecoder !== 'function') {
      throw new TypeError(
        'expected a laz-perf module with _malloc, _free, HEAPU8 and ChunkDecoder'
      )
    }
    this.#module = module
  }

  /**
   * Decompresses one chunk.
   *
   * @param {{ bytes: Uint8Array, pointCount: number, pointFormat: number, recordLength: number }} chunk
   * @returns {Uint8Array} `pointCount * recordLength` bytes of point records
   */
  decodeChunk ({ bytes, pointCount, pointFormat, recordLength }) {
    if (this.#closed) throw new LasError('this backend has been closed')
    if (pointCount === 0) return new Uint8Array(0)

    this.#reserveChunk(bytes.byteLength + OVERRUN_PADDING)
    this.#reservePoint(recordLength)

    // HEAPU8 is re-read after every allocation: growing the Emscripten heap
    // replaces the backing ArrayBuffer and detaches any view taken before it.
    this.#module.HEAPU8.set(bytes, this.#chunkPtr)
    this.#module.HEAPU8.fill(
      0, this.#chunkPtr + bytes.byteLength, this.#chunkPtr + bytes.byteLength + OVERRUN_PADDING
    )

    const output = new Uint8Array(pointCount * recordLength)
    const decoder = new this.#module.ChunkDecoder()
    try {
      // A decoder is good for exactly one chunk: it decodes forwards from the
      // pointer it was opened with and does not know where the chunk ends.
      decoder.open(pointFormat, recordLength, this.#chunkPtr)

      for (let index = 0; index < pointCount; index++) {
        decoder.getPoint(this.#pointPtr)
        output.set(
          this.#module.HEAPU8.subarray(this.#pointPtr, this.#pointPtr + recordLength),
          index * recordLength
        )
      }
    } finally {
      decoder.delete()
    }

    return output
  }

  #reserveChunk (size) {
    if (size <= this.#chunkCapacity) return
    if (this.#chunkPtr !== 0) this.#module._free(this.#chunkPtr)
    this.#chunkPtr = this.#module._malloc(size)
    if (this.#chunkPtr === 0) {
      this.#chunkCapacity = 0
      throw new LasError(`laz-perf could not allocate ${size} bytes for a chunk`)
    }
    this.#chunkCapacity = size
  }

  #reservePoint (size) {
    if (size <= this.#pointCapacity) return
    if (this.#pointPtr !== 0) this.#module._free(this.#pointPtr)
    this.#pointPtr = this.#module._malloc(size)
    if (this.#pointPtr === 0) {
      this.#pointCapacity = 0
      throw new LasError(`laz-perf could not allocate ${size} bytes for a point`)
    }
    this.#pointCapacity = size
  }

  /** Releases the heap allocations. Safe to call more than once. */
  close () {
    if (this.#closed) return
    this.#closed = true
    if (this.#chunkPtr !== 0) this.#module._free(this.#chunkPtr)
    if (this.#pointPtr !== 0) this.#module._free(this.#pointPtr)
    this.#chunkPtr = 0
    this.#pointPtr = 0
    this.#chunkCapacity = 0
    this.#pointCapacity = 0
  }
}

/**
 * Throws unless `value` looks like a backend.
 *
 * @param {unknown} value
 * @returns {LazBackend}
 */
export function assertLazBackend (value) {
  if (typeof value !== 'object' || value === null ||
      typeof (/** @type {LazBackend} */ (value).decodeChunk) !== 'function') {
    throw new TypeError('expected a backend: an object with a decodeChunk(chunk) method')
  }
  return /** @type {LazBackend} */ (value)
}
