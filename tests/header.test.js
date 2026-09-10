import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'
import { readSample } from './helpers/read-sample.js'

describe('Header', () => {
  let header

  before(async () => {
    ({ header } = await readSample())
  })

  it('reads the LASF file signature', () => {
    assert.equal(header.file_signature, 'LASF')
  })

  it('reads the version as 1.2', () => {
    assert.deepEqual(header.version, { major: 1, minor: 2 })
  })

  it('reads the identification strings', () => {
    assert.equal(header.system_identifier, 'LAStools (c) by rapidlasso GmbH')
    assert.equal(header.generating_software, 'lasduplicate (160730) commercia')
  })

  it('reads the offsets and record layout', () => {
    assert.equal(header.header_size, 227)
    assert.equal(header.offset_to_point_data, 331)
    assert.equal(header.number_of_variable_length_records, 1)
    assert.equal(header.point_data_record.format, 0)
    assert.equal(header.point_data_record.length, 20)
  })

  it('reads the point count', () => {
    assert.equal(header.points.number_of_points, 21932)
    assert.equal(header.points.points_x_return.length, 5)
  })

  it('reads scale and offset', () => {
    assert.deepEqual(header.scale, [0.01, 0.01, 0.001])
    assert.deepEqual(header.offset, [2000000, 200000, -0])
  })

  it('reads the bounding box as [max, min] pairs per axis', () => {
    assert.deepEqual(header.max_min, [
      [2231104.52, 2230738.84],
      [252410.1, 252070.78],
      [80.815, -1.316]
    ])
  })

  it('exposes the global encoding bit helpers', () => {
    assert.equal(header.global_encoding, 0)
    assert.ok(!header.is_gps_time_type())
    assert.ok(!header.is_waveform_data_packets_internal())
    assert.ok(!header.is_waveform_data_packets_external())
    assert.ok(!header.is_return_numbers_synthetic())
    assert.ok(!header.is_wkt())
  })

  it('does not populate the LAS 1.4-only fields for a 1.2 file', () => {
    assert.equal(header.start_waveform_packet_record, undefined)
    assert.equal(header.variable_length_records, undefined)
    assert.equal(header.legacy, undefined)
  })
})
