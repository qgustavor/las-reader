/**
 * A small deterministic generator, so a failing property or fuzz case can be
 * reproduced from its seed instead of being a one-off.
 */
export function makeRandom (seed = 1) {
  let state = seed >>> 0
  const next = () => {
    // mulberry32
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  return {
    next,
    /** Integer in [min, max]. */
    int (min, max) {
      return min + Math.floor(next() * (max - min + 1))
    },
    float (min, max) {
      return min + next() * (max - min)
    },
    bool () {
      return next() < 0.5
    },
    pick (items) {
      return items[Math.floor(next() * items.length)]
    }
  }
}

/**
 * Random points valid for a given point format.
 *
 * @param {ReturnType<typeof makeRandom>} random
 * @param {{ extended: boolean, gpsTime: boolean, color: boolean, nir: boolean, waveform: boolean }} format
 * @param {number} count
 */
export function randomPoints (random, format, count) {
  return Array.from({ length: count }, () => {
    const point = {
      rawX: random.int(-2147483648, 2147483647),
      rawY: random.int(-2147483648, 2147483647),
      rawZ: random.int(-2147483648, 2147483647),
      intensity: random.int(0, 65535),
      returnNumber: random.int(0, format.extended ? 15 : 7),
      numberOfReturns: random.int(0, format.extended ? 15 : 7),
      scanDirectionFlag: random.int(0, 1),
      edgeOfFlightLine: random.int(0, 1),
      classification: random.int(0, format.extended ? 255 : 31),
      synthetic: random.bool(),
      keyPoint: random.bool(),
      withheld: random.bool(),
      userData: random.int(0, 255),
      pointSourceId: random.int(0, 65535),
      scanAngleRaw: format.extended ? random.int(-30000, 30000) : random.int(-128, 127)
    }
    if (format.extended) {
      point.overlap = random.bool()
      point.scannerChannel = random.int(0, 3)
    }
    if (format.gpsTime) point.gpsTime = random.float(-1e6, 1e6)
    if (format.color) {
      point.red = random.int(0, 65535)
      point.green = random.int(0, 65535)
      point.blue = random.int(0, 65535)
    }
    if (format.nir) point.nir = random.int(0, 65535)
    if (format.waveform) {
      point.waveform = {
        descriptorIndex: random.int(0, 255),
        byteOffset: random.int(0, 2 ** 40),
        packetSize: random.int(0, 4294967295),
        returnPointLocation: Math.fround(random.float(0, 1)),
        xT: Math.fround(random.float(-10, 10)),
        yT: Math.fround(random.float(-10, 10)),
        zT: Math.fround(random.float(-10, 10))
      }
    }
    return point
  })
}
