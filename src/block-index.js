import { LasFormatError } from './errors.js'

/** Points per index block. 65536 blocks a 20 GB file into ~15000 entries. */
export const DEFAULT_BLOCK_SIZE = 65536

const INDEX_VERSION = 1

/**
 * Builds a coarse spatial index over a file's point blocks.
 *
 * Points in a LAS file are in whatever order the scanner wrote them, so a
 * spatial query has to look at every record. This walks the file once and
 * records the bounding box of each run of `blockSize` points, in raw integer
 * coordinates. A later query tests the box against those and reads only the
 * blocks that can contain a match.
 *
 * It costs one pass and almost nothing to keep: at the default block size, a
 * billion points produce about 360 KB of Int32Arrays. The result is plain data
 * and structured-cloneable, so it can be handed to a worker or stored in
 * IndexedDB against the file's name, size and lastModified, and reused every
 * time the same file is opened.
 *
 * Nothing is decoded while building; only the three coordinates of each record
 * are read.
 *
 * @param {import('./reader.js').LasReader} reader
 * @param {{ blockSize?: number, signal?: AbortSignal, onProgress?: (progress: { blocksDone: number, blockCount: number, pointsDone: number, pointCount: number }) => void }} [options]
 * @returns {Promise<BlockIndex>}
 */
export async function buildBlockIndex (reader, options = {}) {
  const { blockSize = DEFAULT_BLOCK_SIZE, signal, onProgress } = options
  if (!Number.isInteger(blockSize) || blockSize < 1) {
    throw new RangeError(`blockSize must be a positive integer, got ${blockSize}`)
  }

  const pointCount = reader.pointCount
  const recordLength = reader.header.pointDataRecordLength
  const blockCount = Math.ceil(pointCount / blockSize)

  const index = {
    version: INDEX_VERSION,
    pointCount,
    recordLength,
    blockSize,
    blockCount,
    minX: new Int32Array(blockCount),
    maxX: new Int32Array(blockCount),
    minY: new Int32Array(blockCount),
    maxY: new Int32Array(blockCount),
    minZ: new Int32Array(blockCount),
    maxZ: new Int32Array(blockCount)
  }

  let blocksDone = 0
  let pointsDone = 0

  for await (const block of reader.blocks({ chunkSize: blockSize * recordLength })) {
    signal?.throwIfAborted()

    const view = new DataView(block.bytes.buffer, block.bytes.byteOffset, block.bytes.byteLength)
    let minX = 2147483647
    let maxX = -2147483648
    let minY = 2147483647
    let maxY = -2147483648
    let minZ = 2147483647
    let maxZ = -2147483648

    for (let slot = 0; slot < block.count; slot++) {
      const at = slot * recordLength
      const x = view.getInt32(at, true)
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      const y = view.getInt32(at + 4, true)
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      const z = view.getInt32(at + 8, true)
      if (z < minZ) minZ = z
      if (z > maxZ) maxZ = z
    }

    index.minX[blocksDone] = minX
    index.maxX[blocksDone] = maxX
    index.minY[blocksDone] = minY
    index.maxY[blocksDone] = maxY
    index.minZ[blocksDone] = minZ
    index.maxZ[blocksDone] = maxZ

    blocksDone++
    pointsDone += block.count
    onProgress?.({ blocksDone, blockCount, pointsDone, pointCount })
  }

  return index
}

/**
 * Throws unless the index was built from this file. An index is only valid for
 * the exact point block it was built over, so a cached one has to be checked
 * before it is trusted.
 *
 * @param {BlockIndex} index
 * @param {import('./reader.js').LasReader} reader
 */
export function assertIndexMatches (index, reader) {
  if (index?.version !== INDEX_VERSION) {
    throw new LasFormatError(`unknown block index version ${index?.version}`)
  }
  if (index.pointCount !== reader.pointCount || index.recordLength !== reader.header.pointDataRecordLength) {
    throw new LasFormatError(
      `block index was built for ${index.pointCount} points of ${index.recordLength} bytes, ` +
      `but this file has ${reader.pointCount} of ${reader.header.pointDataRecordLength}`
    )
  }
  return index
}

/**
 * Yields runs of consecutive points whose blocks overlap the given raw range,
 * merging neighbours so that a query costs few large reads rather than many
 * small ones.
 *
 * @param {BlockIndex} index
 * @param {{ minX: number, maxX: number, minY: number, maxY: number, minZ: number, maxZ: number }} range
 * @param {{ start?: number, count?: number }} [window] restrict to a point range
 * @yields {{ start: number, count: number }}
 */
export function * candidateRuns (index, range, window = {}) {
  const from = window.start ?? 0
  const to = window.count === undefined ? index.pointCount : Math.min(from + window.count, index.pointCount)

  let runStart = -1
  let runEnd = -1

  for (let block = Math.floor(from / index.blockSize); block < index.blockCount; block++) {
    const blockStart = block * index.blockSize
    if (blockStart >= to) break

    const overlaps =
      index.maxX[block] >= range.minX && index.minX[block] <= range.maxX &&
      index.maxY[block] >= range.minY && index.minY[block] <= range.maxY &&
      index.maxZ[block] >= range.minZ && index.minZ[block] <= range.maxZ

    if (!overlaps) continue

    const start = Math.max(blockStart, from)
    const end = Math.min(blockStart + index.blockSize, to)
    if (end <= start) continue

    if (runStart === -1) {
      runStart = start
      runEnd = end
    } else if (start === runEnd) {
      runEnd = end
    } else {
      yield { start: runStart, count: runEnd - runStart }
      runStart = start
      runEnd = end
    }
  }

  if (runStart !== -1) yield { start: runStart, count: runEnd - runStart }
}

/**
 * How much of the file a query would have to read, as a fraction. Useful for
 * deciding whether building an index is worth it, and for showing progress.
 *
 * @param {BlockIndex} index
 * @param {{ minX: number, maxX: number, minY: number, maxY: number, minZ: number, maxZ: number }} range
 */
export function selectivity (index, range) {
  let selected = 0
  for (const run of candidateRuns(index, range)) selected += run.count
  return index.pointCount === 0 ? 0 : selected / index.pointCount
}

/**
 * @typedef {Awaited<ReturnType<typeof buildBlockIndex>>} BlockIndex
 */
