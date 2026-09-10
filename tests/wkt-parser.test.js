import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import parse from '../src/wkt_parser.js'

const STATE_PLANE_WKT = `PROJCS["NAD_1983_StatePlane_Michigan_South_FIPS_2113_Feet_Intl",
  GEOGCS["NAD83",
   DATUM["North_American_Datum_1983",
   SPHEROID["GRS 1980",6378137,298.2572221010002, AUTHORITY["EPSG","7019"]
 ],
 AUTHORITY["EPSG","6269"]],
 PRIMEM["Greenwich",0],
 UNIT["degree",0.0174532925199433], AUTHORITY["EPSG","4269"]],
PROJECTION["Lambert_Conformal_Conic_2SP"],
PARAMETER["standard_parallel_1",42.1],
PARAMETER["standard_parallel_2",43.66666666666666],
PARAMETER["latitude_of_origin",41.5],
PARAMETER["central_meridian",-84.36666666666666],
PARAMETER["false_easting",13123359.58005249],
PARAMETER["false_northing",0],
UNIT["foot",0.3048, AUTHORITY["EPSG","9002"]]]`

describe('wkt_parser', () => {
  it('returns false for input that is not a WKT tag', () => {
    assert.equal(parse('not wkt at all'), false)
    assert.equal(parse(''), false)
  })

  it('reads the name of the outermost tag', () => {
    const result = parse(STATE_PLANE_WKT)
    assert.equal(
      result.PROJCS.name,
      'NAD_1983_StatePlane_Michigan_South_FIPS_2113_Feet_Intl'
    )
  })

  it('nests child tags under their parent', () => {
    const { PROJCS } = parse(STATE_PLANE_WKT)
    assert.equal(PROJCS.GEOGCS.name, 'NAD83')
    assert.equal(PROJCS.GEOGCS.DATUM.name, 'North_American_Datum_1983')
    assert.equal(PROJCS.PROJECTION.name, 'Lambert_Conformal_Conic_2SP')
  })

  it('reads the linear unit and its conversion factor', () => {
    const { PROJCS } = parse(STATE_PLANE_WKT)
    assert.equal(PROJCS.UNIT.name, 'foot')
    assert.equal(PROJCS.UNIT.value, 0.3048)
  })

  it('lifts PARAMETER entries onto the enclosing tag', () => {
    const { PROJCS } = parse(STATE_PLANE_WKT)
    assert.equal(PROJCS.false_northing, 0)
    assert.ok('central_meridian' in PROJCS)
    assert.ok('standard_parallel_1' in PROJCS)
  })

  it('keeps the last character of a numeric value', {
    todo: 'extract_key_and_values trims the closing bracket with ' +
          'substring(0, lastIndexOf("]") - 1), which is one character too many, ' +
          'so the final item of every tag loses its last character: 42.1 parses ' +
          'as 42 and -84.36666666666666 as -84.3666666666666. The parser is ' +
          'deleted in step 3.7.'
  }, () => {
    const { PROJCS } = parse(STATE_PLANE_WKT)
    assert.equal(PROJCS.standard_parallel_1, 42.1)
    assert.equal(PROJCS.latitude_of_origin, 41.5)
    assert.equal(PROJCS.central_meridian, -84.36666666666666)
    assert.equal(PROJCS.false_easting, 13123359.58005249)
  })

  it('keeps every value of a multi-valued tag', {
    todo: 'Each unnamed value is written to the same `value` property, so ' +
          'SPHEROID["GRS 1980",6378137,298.2572221010002] keeps only the ' +
          'inverse flattening and silently drops the semi-major axis. The ' +
          'parser is deleted in step 3.7.'
  }, () => {
    const { SPHEROID } = parse(STATE_PLANE_WKT).PROJCS.GEOGCS.DATUM
    assert.equal(SPHEROID.name, 'GRS 1980')
    assert.deepEqual(SPHEROID.values, [6378137, 298.2572221010002])
  })
})
