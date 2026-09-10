import { BinaryReader } from './binary-reader.js'
import { assertIndexMatches, candidateRuns } from './block-index.js'
import { decodePoint } from './point-format.js'

/**
 * @typedef {object} Box
 * @property {number} [minX] omit for unbounded
 * @property {number} [maxX]
 * @property {number} [minY]
 * @property {number} [maxY]
 * @property {number} [minZ]
 * @property {number} [maxZ]
 */

/**
 * Converts a box in world coordinates into the integer range the file actually
 * stores, so that rejecting a point costs three integer comparisons instead of
 * three multiplies, three adds and a full record decode.
 *
 * Returns null when the box cannot contain anything, which lets a caller skip
 * the file entirely.
 *
 * @param {import('./header.js').LasHeader} header
 * @param {Box} box
 * @param {{ useHeaderBounds?: boolean }} [options]
 */
export function boxToRawRange (header, box = {}, { useHeaderBounds = true } = {}) {
  const world = [
    [box.minX ?? -Infinity, box.maxX ?? Infinity],
    [box.minY ?? -Infinity, box.maxY ?? Infinity],
    [box.minZ ?? -Infinity, box.maxZ ?? Infinity]
  ]

  if (useHeaderBounds) {
    for (let axis = 0; axis < 3; axis++) {
      if (world[axis][0] > header.bounds.max[axis] || world[axis][1] < header.bounds.min[axis]) {
        return null
      }
    }
  }

  const min = [0, 0, 0]
  const max = [0, 0, 0]
  for (let axis = 0; axis < 3; axis++) {
    const scale = header.scale[axis]
    const offset = header.offset[axis]
    let lo = (world[axis][0] - offset) / scale
    let hi = (world[axis][1] - offset) / scale
    // A negative scale factor is legal and flips the direction of the axis.
    if (scale < 0) [lo, hi] = [hi, lo]
    min[axis] = Math.ceil(lo)
    max[axis] = Math.floor(hi)
    if (min[axis] > max[axis]) return null
  }

  return { minX: min[0], maxX: max[0], minY: min[1], maxY: max[1], minZ: min[2], maxZ: max[2] }
}


/**
 * Yields the blocks a query needs to look at: every block in the window, or
 * only the ones a block index says can overlap the range.
 *
 * @param {import('./reader.js').LasReader} reader
 * @param {{ minX: number, maxX: number, minY: number, maxY: number, minZ: number, maxZ: number }} range
 * @param {object} options
 */
async function * candidateBlocks (reader, range, options) {
  const { index, start, count, chunkSize } = options

  if (!index) {
    yield * reader.blocks({ start, count, chunkSize })
    return
  }

  assertIndexMatches(index, reader)
  for (const run of candidateRuns(index, range, { start, count })) {
    yield * reader.blocks({ start: run.start, count: run.count, chunkSize })
  }
}

/**
 * Yields the points inside an axis-aligned box.
 *
 * Each record's three coordinates are read straight out of the block and tested
 * against the box in raw integer space; only the points that survive are
 * decoded. On a selective query that is most of the work avoided.
 *
 * @param {import('./reader.js').LasReader} reader
 * @param {Box} box in the file's own coordinates
 * @param {{ index?: import('./block-index.js').BlockIndex, start?: number, count?: number, chunkSize?: number, useHeaderBounds?: boolean, where?: (point: object) => boolean }} [options]
 */
export async function * pointsInBox (reader, box, options = {}) {
  const range = boxToRawRange(reader.header, box, options)
  if (range === null) return

  const { where } = options
  const format = reader.pointFormat
  const header = reader.header

  for await (const block of candidateBlocks(reader, range, options)) {
    const view = new DataView(block.bytes.buffer, block.bytes.byteOffset, block.bytes.byteLength)
    const cursor = new BinaryReader(block.bytes, { origin: block.fileOffset })

    for (let slot = 0; slot < block.count; slot++) {
      const at = slot * block.recordLength
      const rawX = view.getInt32(at, true)
      if (rawX < range.minX || rawX > range.maxX) continue
      const rawY = view.getInt32(at + 4, true)
      if (rawY < range.minY || rawY > range.maxY) continue
      const rawZ = view.getInt32(at + 8, true)
      if (rawZ < range.minZ || rawZ > range.maxZ) continue

      cursor.seek(at)
      const point = decodePoint(cursor, format, header, block.recordLength)
      point.index = block.firstIndex + slot
      if (where === undefined || where(point)) yield point
    }
  }
}

/**
 * Yields the points within `radius` of a coordinate, nearest first if you sort
 * them; `point.distance` is the planimetric distance from the centre.
 *
 * The box around the circle does the cheap rejection, then survivors get an
 * exact distance test. Pass `minZ`/`maxZ` to make it a cylinder.
 *
 * @param {import('./reader.js').LasReader} reader
 * @param {{ x: number, y: number, radius: number, minZ?: number, maxZ?: number }} centre
 * @param {{ index?: import('./block-index.js').BlockIndex, start?: number, count?: number, chunkSize?: number, useHeaderBounds?: boolean, where?: (point: object) => boolean }} [options]
 */
export async function * pointsNear (reader, { x, y, radius, minZ, maxZ }, options = {}) {
  if (!(radius >= 0)) throw new RangeError(`radius must be a non-negative number, got ${radius}`)
  const limit = radius * radius

  const box = { minX: x - radius, maxX: x + radius, minY: y - radius, maxY: y + radius, minZ, maxZ }
  const { where, ...rest } = options

  for await (const point of pointsInBox(reader, box, rest)) {
    const dx = point.x - x
    const dy = point.y - y
    const squared = dx * dx + dy * dy
    if (squared > limit) continue
    point.distance = Math.sqrt(squared)
    if (where === undefined || where(point)) yield point
  }
}

/**
 * Counts the points inside a box without decoding any of them. Useful for
 * sizing a buffer, or for deciding whether a query is worth running.
 *
 * @param {import('./reader.js').LasReader} reader
 * @param {Box} box
 * @param {{ index?: import('./block-index.js').BlockIndex, start?: number, count?: number, chunkSize?: number, useHeaderBounds?: boolean }} [options]
 */
export async function countInBox (reader, box, options = {}) {
  const range = boxToRawRange(reader.header, box, options)
  if (range === null) return 0

  let total = 0
  for await (const block of candidateBlocks(reader, range, options)) {
    const view = new DataView(block.bytes.buffer, block.bytes.byteOffset, block.bytes.byteLength)
    for (let slot = 0; slot < block.count; slot++) {
      const at = slot * block.recordLength
      const rawX = view.getInt32(at, true)
      if (rawX < range.minX || rawX > range.maxX) continue
      const rawY = view.getInt32(at + 4, true)
      if (rawY < range.minY || rawY > range.maxY) continue
      const rawZ = view.getInt32(at + 8, true)
      if (rawZ < range.minZ || rawZ > range.maxZ) continue
      total++
    }
  }
  return total
}

/**
 * Builds a predicate over the decoded fields, for the `where` option.
 *
 *     where: matching({ classification: [2, 9], returnNumber: 1 })
 *
 * A field given an array matches any of its values; anything else matches by
 * equality. `minZ`/`maxZ` and `minIntensity`/`maxIntensity` are ranges.
 *
 * @param {object} spec
 * @returns {(point: object) => boolean}
 */
export function matching (spec = {}) {
  const { minZ, maxZ, minIntensity, maxIntensity, ...fields } = spec
  const entries = Object.entries(fields).map(([key, value]) => [
    key,
    Array.isArray(value) ? new Set(value) : value
  ])

  return (point) => {
    if (minZ !== undefined && point.z < minZ) return false
    if (maxZ !== undefined && point.z > maxZ) return false
    if (minIntensity !== undefined && point.intensity < minIntensity) return false
    if (maxIntensity !== undefined && point.intensity > maxIntensity) return false
    for (const [key, value] of entries) {
      if (value instanceof Set ? !value.has(point[key]) : point[key] !== value) return false
    }
    return true
  }
}

/**
 * Turns an array of points into parallel typed arrays, which is the shape most
 * geometry code wants: convex hulls, triangulations, areas and volumes all read
 * coordinates far more than they read anything else.
 *
 * @param {object[]} points
 * @param {string[]} [fields] extra fields to pull out alongside x, y and z
 */
export function toColumns (points, fields = []) {
  const count = points.length
  const columns = {
    count,
    x: new Float64Array(count),
    y: new Float64Array(count),
    z: new Float64Array(count)
  }
  for (const field of fields) columns[field] = new Float64Array(count)

  for (let index = 0; index < count; index++) {
    const point = points[index]
    columns.x[index] = point.x
    columns.y[index] = point.y
    columns.z[index] = point.z
    for (const field of fields) columns[field][index] = Number(point[field])
  }
  return columns
}
