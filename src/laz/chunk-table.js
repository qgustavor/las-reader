import { readExact } from '../byte-source.js'
import { LasFormatError, LasUnsupportedError } from '../errors.js'
import { ArithmeticDecoder } from './arithmetic-decoder.js'
import { IntegerDecompressor } from './integer-decompressor.js'

/**
 * The chunk table.
 *
 * A chunked LAZ file restarts the arithmetic coder every `chunkSize` points, so
 * any chunk can be decoded without decoding the ones before it. What makes that
 * usable is the chunk table: a list of compressed chunk sizes, written at the
 * end of the file, from which the byte offset of every chunk follows. Without
 * it a reader can only start at point zero and walk forwards.
 *
 * The table is itself arithmetic-coded, as deltas against the previous entry,
 * because consecutive chunks compress to similar sizes.
 *
 * Layout: an int64 at `offsetToPointData` giving the table's position, then at
 * that position a u32 version and a u32 chunk count, then the coded entries.
 */

/** The only chunk table version LASzip has written. */
export const CHUNK_TABLE_VERSION = 0

/** Contexts the integer decompressor keeps: point counts, then byte counts. */
const CONTEXT_POINT_COUNT = 0
const CONTEXT_BYTE_COUNT = 1

/**
 * @typedef {object} LazChunk
 * @property {number} index position of this chunk in the file
 * @property {number} firstPoint index of its first point
 * @property {number} pointCount how many points it holds
 * @property {number} offset byte offset of its compressed data
 * @property {number} byteLength size of its compressed data
 */

/**
 * @typedef {object} LazChunkTable
 * @property {number} version
 * @property {number} chunkCount
 * @property {number} pointsPerChunk points per chunk, or null when variable
 * @property {boolean} variableChunks
 * @property {number} tableOffset byte offset of the table itself
 * @property {number} firstChunkOffset byte offset of the first chunk
 * @property {number} compressedByteLength bytes of compressed point data
 * @property {LazChunk[]} chunks
 */

/**
 * Decodes the entries of a chunk table.
 *
 * Separate from the I/O so it can be tested against bytes directly.
 *
 * @param {Uint8Array} bytes the table, starting at its version field
 * @param {{ variableChunks?: boolean, origin?: number }} [options]
 * @returns {{ version: number, chunkCount: number, sizes: number[], counts: number[] | null }}
 */
export function decodeChunkTable (bytes, { variableChunks = false, origin = 0 } = {}) {
  if (bytes.byteLength < 8) {
    throw new LasFormatError(
      `chunk table needs 8 bytes of header, found ${bytes.byteLength}`,
      { offset: origin }
    )
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = view.getUint32(0, true)
  const chunkCount = view.getUint32(4, true)

  if (version !== CHUNK_TABLE_VERSION) {
    throw new LasUnsupportedError(
      `chunk table version ${version} is not supported; only version ${CHUNK_TABLE_VERSION} is`
    )
  }

  if (chunkCount === 0) {
    return { version, chunkCount, sizes: [], counts: variableChunks ? [] : null }
  }

  const decoder = new ArithmeticDecoder(bytes, 8)
  const integers = new IntegerDecompressor(decoder, 32, 2)

  const sizes = new Array(chunkCount)
  const counts = variableChunks ? new Array(chunkCount) : null

  let previousCount = 0
  let previousSize = 0
  for (let index = 0; index < chunkCount; index++) {
    // Counts come first when present, because that is the order they were
    // written in; the two contexts share one coded stream.
    if (variableChunks) {
      previousCount = integers.decompress(previousCount, CONTEXT_POINT_COUNT)
      if (previousCount < 0) {
        throw new LasFormatError(
          `chunk ${index} decoded a negative point count (${previousCount}), ` +
          'which means the chunk table did not decode correctly',
          { offset: origin }
        )
      }
      counts[index] = previousCount
    }

    previousSize = integers.decompress(previousSize, CONTEXT_BYTE_COUNT)
    if (previousSize <= 0) {
      throw new LasFormatError(
        `chunk ${index} decoded a size of ${previousSize}, ` +
        'which means the chunk table did not decode correctly',
        { offset: origin }
      )
    }
    sizes[index] = previousSize
  }

  if (decoder.overran) {
    throw new LasFormatError(
      `chunk table ran out of bytes decoding ${chunkCount} chunks`,
      { offset: origin }
    )
  }

  return { version, chunkCount, sizes, counts }
}

/**
 * Reads the chunk table from a source.
 *
 * @param {import('../byte-source.js').ByteSource} source
 * @param {import('../header.js').LasHeader} header
 * @param {import('./laszip-vlr.js').LaszipVlr} vlr
 * @param {{ allowTruncated?: boolean }} [options] keep the chunks that are
 *   present in a file that ends early, instead of refusing it
 * @returns {Promise<LazChunkTable>}
 */
export async function readChunkTable (source, header, vlr, options = {}) {
  if (!vlr.chunked) {
    throw new LasUnsupportedError(
      `this file uses the ${vlr.compressorName} scheme, which has no chunk table; ` +
      'only chunked LAZ files can be read'
    )
  }

  const pointerOffset = header.offsetToPointData
  if (pointerOffset + 8 > source.byteLength) {
    throw new LasFormatError(
      'the file ends before the chunk table pointer that should follow the header',
      { offset: pointerOffset }
    )
  }

  const pointerBytes = await readExact(source, pointerOffset, 8)
  const tableOffset = Number(
    new DataView(pointerBytes.buffer, pointerBytes.byteOffset, 8).getBigInt64(0, true)
  )

  // LASzip writes -1 when the table was never filled in, which happens when the
  // writer died partway. The points are still there but nothing says where.
  if (tableOffset <= 0) {
    throw new LasUnsupportedError(
      'this file has no chunk table, so its chunks cannot be located; ' +
      'it was probably written by a process that did not finish'
    )
  }
  if (tableOffset + 8 > source.byteLength) {
    throw new LasFormatError(
      `the chunk table is at ${tableOffset} but the file is ${source.byteLength} bytes`,
      { offset: pointerOffset }
    )
  }

  const firstChunkOffset = pointerOffset + 8
  const compressedByteLength = tableOffset - firstChunkOffset
  if (compressedByteLength < 0) {
    throw new LasFormatError(
      `the chunk table at ${tableOffset} precedes the point data at ${firstChunkOffset}`,
      { offset: pointerOffset }
    )
  }

  const { chunkCount, version, sizes, counts } = await readTableBytes(
    source, tableOffset, vlr.variableChunks
  )

  const total = sizes.reduce((sum, size) => sum + size, 0)
  if (total !== compressedByteLength && !options.allowTruncated) {
    // This is the integrity check that matters. The sizes are deltas decoded
    // from an adaptive model, so a coder that is even slightly wrong produces
    // plausible-looking numbers that do not add up. Nothing downstream would
    // notice; it would just decompress garbage.
    throw new LasFormatError(
      `chunk sizes add up to ${total} bytes but there are ${compressedByteLength} ` +
      'bytes of compressed point data; the chunk table did not decode correctly, ' +
      'or the file is truncated — pass { allowTruncated: true } to read the chunks ' +
      'that are there',
      { offset: tableOffset }
    )
  }

  let chunks = buildChunks({
    chunkCount, sizes, counts, firstChunkOffset, header, vlr
  })

  if (total > compressedByteLength) {
    // Keep only chunks whose compressed bytes are all present. A chunk that
    // ends past the data cannot be decompressed, and a partial one decodes to
    // garbage rather than to fewer points.
    chunks = chunks.filter((chunk) => chunk.offset + chunk.byteLength <= tableOffset)
  }

  return Object.freeze({
    version,
    chunkCount,
    pointsPerChunk: vlr.variableChunks ? null : vlr.chunkSize,
    variableChunks: vlr.variableChunks,
    tableOffset,
    firstChunkOffset,
    compressedByteLength,
    chunks: Object.freeze(chunks)
  })
}

/**
 * Reads enough of the tail to decode the table, without reading to the end of
 * the file: a LAS 1.4 file can carry gigabytes of waveform EVLRs after it.
 */
async function readTableBytes (source, tableOffset, variableChunks) {
  const limit = source.byteLength - tableOffset
  const headerBytes = await readExact(source, tableOffset, Math.min(8, limit))
  const chunkCount = new DataView(
    headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength
  ).getUint32(4, true)

  // An entry costs a handful of bytes; this is a generous ceiling, and falling
  // short only costs one more read.
  const estimate = Math.min(limit, 8 + chunkCount * (variableChunks ? 24 : 12) + 128)

  try {
    return decodeChunkTable(
      await readExact(source, tableOffset, estimate),
      { variableChunks, origin: tableOffset }
    )
  } catch (error) {
    if (estimate >= limit) throw error
    return decodeChunkTable(
      await readExact(source, tableOffset, limit),
      { variableChunks, origin: tableOffset }
    )
  }
}

function buildChunks ({ chunkCount, sizes, counts, firstChunkOffset, header, vlr }) {
  const chunks = new Array(chunkCount)
  let offset = firstChunkOffset
  let firstPoint = 0

  for (let index = 0; index < chunkCount; index++) {
    // With a fixed chunk size only the last chunk is short, and the header is
    // the only thing that says by how much.
    const pointCount = vlr.variableChunks
      ? counts[index]
      : Math.min(vlr.chunkSize, Math.max(0, header.pointCount - firstPoint))

    chunks[index] = Object.freeze({
      index,
      firstPoint,
      pointCount,
      offset,
      byteLength: sizes[index]
    })

    offset += sizes[index]
    firstPoint += pointCount
  }

  return chunks
}

/**
 * Finds the chunk holding a point.
 *
 * @param {LazChunkTable} table
 * @param {number} pointIndex
 * @returns {LazChunk | undefined}
 */
export function chunkForPoint (table, pointIndex) {
  if (pointIndex < 0) return undefined

  if (!table.variableChunks && table.pointsPerChunk > 0) {
    const chunk = table.chunks[Math.floor(pointIndex / table.pointsPerChunk)]
    // The last chunk is short, so landing inside it arithmetically is not
    // enough: the point still has to exist.
    if (chunk === undefined || pointIndex >= chunk.firstPoint + chunk.pointCount) {
      return undefined
    }
    return chunk
  }

  // Variable chunks need a search, but the table is sorted by first point.
  let low = 0
  let high = table.chunks.length - 1
  while (low <= high) {
    const middle = (low + high) >>> 1
    const chunk = table.chunks[middle]
    if (pointIndex < chunk.firstPoint) high = middle - 1
    else if (pointIndex >= chunk.firstPoint + chunk.pointCount) low = middle + 1
    else return chunk
  }
  return undefined
}

/**
 * The chunks a run of points touches, in file order.
 *
 * @param {LazChunkTable} table
 * @param {number} start
 * @param {number} count
 * @returns {LazChunk[]}
 */
export function chunksForRange (table, start, count) {
  if (count <= 0) return []
  const first = chunkForPoint(table, start)
  if (first === undefined) return []

  const end = start + count
  const selected = []
  for (let index = first.index; index < table.chunks.length; index++) {
    const chunk = table.chunks[index]
    if (chunk.firstPoint >= end) break
    selected.push(chunk)
  }
  return selected
}
