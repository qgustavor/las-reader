import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'
import { readSample } from './helpers/read-sample.js'

describe('Variable length records', () => {
  let vlr
  let projection

  before(async () => {
    ({ vlr, projection } = await readSample())
  })

  it('indexes records by user id and then record id', () => {
    assert.deepEqual(Object.keys(vlr), ['LASF_Projection'])
    assert.deepEqual(Object.keys(vlr.LASF_Projection), ['34735'])
  })

  it('parses the record header of the GeoKeyDirectoryTag', () => {
    const record = vlr.LASF_Projection['34735']
    assert.equal(record.reserved, 43707)
    assert.equal(record.user_id, 'LASF_Projection')
    assert.equal(record.record_id, 34735)
    assert.equal(record.length_after_header, 48)
    assert.equal(record.record_length, 102)
    assert.equal(record.description, 'Projection Parameters')
    assert.equal(record.data.byteLength, 48)
  })

  it('classifies records via the predicate helpers', () => {
    const record = vlr.LASF_Projection['34735']
    assert.ok(record.is_projection())
    assert.ok(!record.is_classification_lookup())
    assert.ok(!record.is_text_area_description())
    assert.ok(!record.is_extra_bytes())
  })

  it('extracts the five GeoTIFF keys from the directory', () => {
    const { geokey } = projection
    assert.equal(geokey.wKeyDirectoryVersion, 1)
    assert.equal(geokey.wKeyRevision, 1)
    assert.equal(geokey.wMinorRevision, 0)
    assert.equal(geokey.wNumberOfKeys, 5)
    assert.deepEqual(Object.keys(geokey.key), ['1024', '3072', '3076', '4096', '4099'])
  })

  it('reads the key values', () => {
    const { geokey } = projection
    assert.equal(geokey.getKey(1024).value, 1) // GTModelTypeGeoKey = ModelTypeProjected
    assert.equal(geokey.getKey(3072).value, 3645) // ProjectedCSTypeGeoKey = EPSG:3645
    assert.equal(geokey.getKey(3076).value, 9001) // ProjLinearUnitsGeoKey = metre
    assert.equal(geokey.getKey(4096).value, 5703) // VerticalCSTypeGeoKey = NAVD88
    assert.equal(geokey.getKey(4099).value, 9001) // VerticalUnitsGeoKey = metre
    assert.ok(geokey.hasKey(3072))
    assert.ok(!geokey.hasKey(2048))
  })

  it('maps the keys to their GeoTIFF names', () => {
    const { geotiff } = projection.geokey
    assert.equal(geotiff.GTModelTypeGeoKey, 'ModelTypeProjected')
    assert.equal(geotiff.ProjectedCSTypeGeoKey, 3645)
    assert.equal(geotiff.ProjLinearUnitsGeoKey, 'Linear_Meter')
    assert.equal(geotiff.VerticalCSTypeGeoKey, 5703)
    assert.equal(geotiff.VerticalUnitsGeoKey, 'Linear_Meter')
    assert.equal(geotiff.GeographicTypeGeoKey, 'NOT_PROVIDED')
  })

  it('records the vertical datum on the projection', () => {
    assert.equal(projection.epsg_vertical_datum, 5703)
    assert.equal(projection.vertical_unit_key, '9001')
    assert.equal(projection.convert_elevation_to_meters(12.5), 12.5)
  })

  it('recognises EPSG:3645 from ProjectedCSTypeGeoKey', {
    todo: 'GeoKey.extractKeys does Number(this.getKey(3072)) on the key object ' +
          'instead of its .value, so has_epsg_projection is never set and the ' +
          'proj4 string is built from scratch. Fixed by step 3.6.'
  }, () => {
    assert.equal(projection.epsg_datum, 3645)
    assert.equal(projection.got_projection, true)
  })
})
