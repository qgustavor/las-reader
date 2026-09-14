import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { LasFormatError, LasUnsupportedError } from '../src/errors.js'
import { parseRecords } from '../src/vlr.js'
import {
  COMPRESSORS,
  DEFAULT_CHUNK_SIZE,
  ITEM_TYPES,
  VARIABLE_CHUNK_SIZE,
  assertVlrMatchesHeader,
  findLaszipVlr,
  parseLaszipVlr
} from '../src/laz/laszip-vlr.js'
import { buildLaszipVlr, buildLaszipVlrPayload, itemsForFormat } from './helpers/build-laz.js'

const parse = (options) => parseLaszipVlr(buildLaszipVlrPayload(options))

describe('parseLaszipVlr', () => {
  it('reads the fixed fields', () => {
    const vlr = parse({
      pointFormat: 1,
      compressor: COMPRESSORS.POINTWISE_CHUNKED,
      chunkSize: 1234,
      versionMajor: 3,
      versionMinor: 4,
      versionRevision: 3
    })

    assert.equal(vlr.compressor, COMPRESSORS.POINTWISE_CHUNKED)
    assert.equal(vlr.compressorName, 'pointwise chunked')
    assert.equal(vlr.coder, 0)
    assert.deepEqual({ ...vlr.version }, { major: 3, minor: 4, revision: 3 })
    assert.equal(vlr.options, 0)
    assert.equal(vlr.chunkSize, 1234)
    assert.equal(vlr.chunked, true)
    assert.equal(vlr.layered, false)
    assert.equal(vlr.variableChunks, false)
  })

  it('defaults to 50000 points per chunk, as LASzip does', () => {
    assert.equal(parse().chunkSize, DEFAULT_CHUNK_SIZE)
  })

  it('reports unused special EVLR fields as -1 rather than a huge unsigned value', () => {
    const vlr = parse()
    assert.equal(vlr.numberOfSpecialEvlrs, -1)
    assert.equal(vlr.offsetToSpecialEvlrs, -1)
  })

  it('reads special EVLR fields when they are set', () => {
    const vlr = parse({ numberOfSpecialEvlrs: 2, offsetToSpecialEvlrs: 987654321 })
    assert.equal(vlr.numberOfSpecialEvlrs, 2)
    assert.equal(vlr.offsetToSpecialEvlrs, 987654321)
  })

  it('flags the variable chunk size sentinel', () => {
    const vlr = parse({ chunkSize: VARIABLE_CHUNK_SIZE })
    assert.equal(vlr.chunkSize, VARIABLE_CHUNK_SIZE)
    assert.equal(vlr.variableChunks, true)
  })

  it('flags the layered scheme used by point formats 6 and up', () => {
    const vlr = parse({ pointFormat: 6, compressor: COMPRESSORS.LAYERED_CHUNKED })
    assert.equal(vlr.layered, true)
    assert.equal(vlr.chunked, true)
    assert.equal(vlr.compressorName, 'layered chunked')
  })

  it('does not call the unchunked pointwise scheme chunked', () => {
    const vlr = parse({ compressor: COMPRESSORS.POINTWISE })
    assert.equal(vlr.chunked, false)
    assert.equal(vlr.layered, false)
  })

  describe('items', () => {
    it('reads a format 0 layout', () => {
      const vlr = parse({ pointFormat: 0 })
      assert.deepEqual(vlr.items.map((item) => item.name), ['POINT10'])
      assert.equal(vlr.pointSize, 20)
    })

    it('reads a format 3 layout', () => {
      const vlr = parse({ pointFormat: 3 })
      assert.deepEqual(vlr.items.map((item) => item.name), ['POINT10', 'GPSTIME11', 'RGB12'])
      assert.equal(vlr.pointSize, 34)
    })

    it('reads a format 8 layout', () => {
      const vlr = parse({ pointFormat: 8 })
      assert.deepEqual(vlr.items.map((item) => item.name), ['POINT14', 'RGBNIR14'])
      assert.equal(vlr.pointSize, 38)
    })

    it('counts extra bytes towards the point size', () => {
      const vlr = parse({ pointFormat: 1, extraByteCount: 5 })
      const last = vlr.items.at(-1)
      assert.equal(last.name, 'BYTE')
      assert.equal(last.size, 5)
      assert.equal(vlr.pointSize, 33)
    })

    it('carries the version each item was compressed with', () => {
      const vlr = parse({ pointFormat: 1 })
      assert.deepEqual(vlr.items.map((item) => item.version), [2, 2])
    })
  })

  describe('rejections', () => {
    it('refuses a payload too short to hold the fixed fields', () => {
      assert.throws(
        () => parseLaszipVlr(new Uint8Array(20)),
        (error) => error instanceof LasFormatError && /34 bytes/.test(error.message)
      )
    })

    it('refuses an item count that runs past the payload', () => {
      assert.throws(
        () => parse({ pointFormat: 0, declaredItemCount: 9 }),
        (error) => error instanceof LasFormatError && /declares 9 items/.test(error.message)
      )
    })

    it('refuses a record describing no items at all', () => {
      assert.throws(
        () => parse({ items: [] }),
        (error) => error instanceof LasFormatError && /no items/.test(error.message)
      )
    })

    it('refuses an unknown compressor', () => {
      assert.throws(() => parse({ compressor: 4 }), LasUnsupportedError)
    })

    it('refuses a coder other than arithmetic', () => {
      assert.throws(
        () => parse({ coder: 1 }),
        (error) => error instanceof LasUnsupportedError && /arithmetic/.test(error.message)
      )
    })

    it('refuses an undefined item type', () => {
      assert.throws(
        () => parse({ items: [{ type: 99, size: 4, version: 1 }] }),
        (error) => error instanceof LasUnsupportedError && /type 99/.test(error.message)
      )
    })

    it('refuses an item version it cannot decode', () => {
      assert.throws(
        () => parse({ items: [{ type: ITEM_TYPES.POINT10, size: 20, version: 7 }] }),
        (error) => error instanceof LasUnsupportedError && /version 1 and 2/.test(error.message)
      )
    })

    it('refuses a fixed-width item whose declared size is wrong', () => {
      assert.throws(
        () => parse({ items: [{ type: ITEM_TYPES.POINT10, size: 24, version: 2 }] }),
        (error) => error instanceof LasFormatError && /20 bytes, but declares 24/.test(error.message)
      )
    })

    it('refuses a zero-length BYTE item', () => {
      assert.throws(
        () => parse({
          items: [
            { type: ITEM_TYPES.POINT10, size: 20, version: 2 },
            { type: ITEM_TYPES.BYTE, size: 0, version: 2 }
          ]
        }),
        (error) => error instanceof LasFormatError && /zero bytes/.test(error.message)
      )
    })

    it('points at the offending item, not the start of the record', () => {
      try {
        parseLaszipVlr(
          buildLaszipVlrPayload({
            items: [
              { type: ITEM_TYPES.POINT10, size: 20, version: 2 },
              { type: ITEM_TYPES.GPSTIME11, size: 9, version: 2 }
            ]
          }),
          { origin: 1000 }
        )
        assert.fail('expected a rejection')
      } catch (error) {
        // Fixed fields, one item, then the size field of the second item.
        assert.equal(error.offset, 1000 + 34 + 6 + 2)
      }
    })
  })
})

describe('findLaszipVlr', () => {
  const records = (...vlrs) => {
    const encoded = vlrs.map((vlr) => {
      const bytes = new Uint8Array(54 + vlr.data.byteLength)
      const view = new DataView(bytes.buffer)
      new TextEncoder().encodeInto(vlr.userId, bytes.subarray(2, 18))
      view.setUint16(18, vlr.recordId, true)
      view.setUint16(20, vlr.data.byteLength, true)
      bytes.set(vlr.data, 54)
      return bytes
    })
    const total = encoded.reduce((sum, bytes) => sum + bytes.byteLength, 0)
    const joined = new Uint8Array(total)
    let cursor = 0
    for (const bytes of encoded) {
      joined.set(bytes, cursor)
      cursor += bytes.byteLength
    }
    return parseRecords(joined, vlrs.length, { origin: 300 })
  }

  it('finds the record among others', () => {
    const other = { userId: 'LASF_Projection', recordId: 34735, data: new Uint8Array(8) }
    const found = findLaszipVlr(records(other, buildLaszipVlr({ pointFormat: 2 })))
    assert.equal(found.pointSize, 26)
  })

  it('returns undefined when the file carries no LASzip record', () => {
    const other = { userId: 'LASF_Projection', recordId: 34735, data: new Uint8Array(8) }
    assert.equal(findLaszipVlr(records(other)), undefined)
  })

  it('reports offsets relative to the payload, not the record header', () => {
    const broken = buildLaszipVlr({ items: [{ type: ITEM_TYPES.POINT10, size: 24, version: 2 }] })
    try {
      findLaszipVlr(records(broken))
      assert.fail('expected a rejection')
    } catch (error) {
      // Record at 300, payload at 300 + 54, then past the fixed fields to the size field.
      assert.equal(error.offset, 300 + 54 + 34 + 2)
    }
  })
})

describe('assertVlrMatchesHeader', () => {
  const header = (pointDataRecordFormat, pointDataRecordLength) =>
    ({ pointDataRecordFormat, pointDataRecordLength })

  it('accepts a record whose items add up to the declared record length', () => {
    const vlr = parse({ pointFormat: 3 })
    assert.equal(assertVlrMatchesHeader(vlr, header(3, 34)), vlr)
  })

  it('accepts extra bytes counted on both sides', () => {
    const vlr = parse({ pointFormat: 1, extraByteCount: 4 })
    assert.equal(assertVlrMatchesHeader(vlr, header(1, 32)), vlr)
  })

  it('refuses a record that disagrees with the header about the point size', () => {
    const vlr = parse({ pointFormat: 3 })
    assert.throws(
      () => assertVlrMatchesHeader(vlr, header(3, 40)),
      (error) => error instanceof LasFormatError && /34 bytes per point/.test(error.message)
    )
  })

  it('refuses an extended format described with legacy items', () => {
    const vlr = parseLaszipVlr(buildLaszipVlrPayload({ items: itemsForFormat(0) }))
    assert.throws(
      () => assertVlrMatchesHeader(vlr, header(6, 20)),
      (error) => error instanceof LasFormatError && /POINT14/.test(error.message)
    )
  })

  it('refuses a legacy format described with extended items', () => {
    const vlr = parse({ pointFormat: 6 })
    assert.throws(
      () => assertVlrMatchesHeader(vlr, header(1, 30)),
      (error) => error instanceof LasFormatError && /POINT10/.test(error.message)
    )
  })
})
