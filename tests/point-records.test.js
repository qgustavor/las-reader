import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'
import { readSample } from './helpers/read-sample.js'

describe('Point records', () => {
  let result

  before(async () => {
    result = await readSample()
  })

  it('emits one record per point in the file', () => {
    assert.equal(result.points.length, 21932)
    assert.equal(result.finishedCount, 21932)
  })

  it('emits records in file order, as arrays', () => {
    assert.ok(result.chunks > 0)
    assert.deepEqual(result.points[0].raw, [23084422, 5208093, -26])
    assert.deepEqual(result.points[1].raw, [23081793, 5208206, 226])
    assert.deepEqual(result.points.at(-1).raw, [23100792, 5239942, 1196])
  })

  it('applies scale and offset from the header', () => {
    const [x, y, z] = result.points[0].scaled
    assert.equal(x, 2230844.22)
    assert.equal(y, 252080.93)
    assert.ok(Math.abs(z - -0.026) < 1e-9)
  })

  it('keeps every scaled point inside the header bounding box', () => {
    const [[maxX, minX], [maxY, minY], [maxZ, minZ]] = result.header.max_min
    for (const point of result.points) {
      const [x, y, z] = point.scaled
      assert.ok(x >= minX && x <= maxX, `x ${x} out of bounds`)
      assert.ok(y >= minY && y <= maxY, `y ${y} out of bounds`)
      assert.ok(z >= minZ && z <= maxZ, `z ${z} out of bounds`)
    }
  })

  it('reads the trailing scalar fields', () => {
    const point = result.points[0]
    assert.equal(point.scan_angle_rank, 0)
    assert.equal(point.user_data, 0)
    assert.equal(point.point_source_id, 0)
  })

  it('does not attach lng_lat when reprojection is switched off', async () => {
    const { points } = await readSample({
      readerOptions: { transform_lnglat: false, ignore_projection: true }
    })
    assert.equal(points[0].lng_lat, undefined)
  })

  it('parses the same points regardless of source chunk size', {
    todo: '_do_read_records reads from `data.buffer`, the whole pooled ArrayBuffer ' +
          'behind the chunk, rather than the chunk itself. With 64 KiB reads the two ' +
          'happen to coincide; with 1 KiB reads the reader yields 175086 garbage ' +
          'records instead of 21932. Fixed by steps 3.1 and 3.2.'
  }, async () => {
    const small = await readSample({ highWaterMark: 1024 })
    assert.equal(small.points.length, 21932)
    assert.deepEqual(small.points[0].raw, result.points[0].raw)
    assert.equal(small.finishedCount, 21932)
  })

  it('decodes the return-number bit field', {
    todo: 'The return byte is decoded with the sub-fields in reverse order ' +
          '(return_number = bit >> 5 instead of bit & 0b111), and the scan ' +
          'direction / edge flags read the wrong bits. Fixed by step 3.3.'
  }, () => {
    const point = result.points[0] // raw byte 0b00001001
    assert.equal(point.return_number, 1)
    assert.equal(point.number_of_returns, 1)
    assert.equal(point.scan_direction_flag, 0)
    assert.equal(point.edge_of_flight_line, 0)
  })

  it('decodes the classification byte', {
    todo: 'classification is computed as `byte << 4` rather than `byte & 0b11111`, ' +
          'and the synthetic/key-point/withheld flags read bits 3, 6 and 7 instead ' +
          'of 5, 6 and 7. Fixed by step 3.3.'
  }, () => {
    const point = result.points[0]
    assert.equal(point.classification, 0)
    assert.equal(point.is_synthetic, false)
    assert.equal(point.is_key_point, false)
    assert.equal(point.is_withheld, false)
  })

  it('reads intensity as little-endian', {
    todo: 'PointRecord reads intensity with getUint16(position) — big-endian, ' +
          'because the littleEndian argument is omitted. Every intensity in this ' +
          'fixture is 0 so the fixture cannot catch it; step 4.3 adds a synthetic ' +
          'fixture that can. Fixed by step 3.3.'
  }, () => {
    assert.equal(result.points[0].intensity, 0)
  })

  it('honours transform_lnglat by default, as the README documents', {
    todo: 'The constructor sets `this.point_record_options.transform_latlng` ' +
          '(note the transposed lnglat/latlng) before the options block, so the ' +
          'documented default of true never takes effect and no lng_lat is ' +
          'attached unless options are passed explicitly. Fixed by step 3.6.'
  }, () => {
    assert.ok(Array.isArray(result.points[0].lng_lat))
  })
})
