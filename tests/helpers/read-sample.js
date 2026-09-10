import fs from 'node:fs'
import { Writable } from 'node:stream'
import { LasStreamReader } from '../../src/las.js'

export const SAMPLE_LAS = new URL('../sample_data/Haystack_Rock.las', import.meta.url)

/**
 * Pipes the sample file through a LasStreamReader and resolves once the
 * pipeline has finished, returning everything the reader emitted.
 *
 * @param {object} [opts]
 * @param {object} [opts.readerOptions] passed to the LasStreamReader constructor
 * @param {number} [opts.highWaterMark] chunk size of the source stream
 * @param {URL|string} [opts.file] file to read, defaults to the sample
 */
export function readSample ({ readerOptions, highWaterMark, file = SAMPLE_LAS } = {}) {
  return new Promise((resolve, reject) => {
    const reader = new LasStreamReader(readerOptions)
    const result = {
      header: null,
      vlr: null,
      projection: null,
      lazInfo: null,
      finishedCount: null,
      errors: [],
      logs: [],
      points: [],
      chunks: 0
    }

    reader.on('error', (error) => result.errors.push(error))
    reader.on('log', (entry) => result.logs.push(entry))
    reader.on('onParseHeader', (header) => { result.header = header })
    reader.on('onParseVLR', (vlr) => { result.vlr = vlr })
    reader.on('onGotProjection', (projection) => { result.projection = projection })
    reader.on('onGotLazInfo', (info) => { result.lazInfo = info })
    reader.on('onFinishedReadingRecords', (count) => { result.finishedCount = count })

    const sink = new Writable({
      objectMode: true,
      write (records, _encoding, callback) {
        result.chunks++
        for (const record of records) result.points.push(record)
        callback()
      }
    })

    sink.on('finish', () => resolve(result))
    sink.on('error', reject)

    const source = fs.createReadStream(file, highWaterMark ? { highWaterMark } : undefined)
    source.on('error', reject)
    source.pipe(reader).pipe(sink)
  })
}
