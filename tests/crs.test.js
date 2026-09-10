import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import fs from 'node:fs'
import { GEO_KEYS, linearUnitToMetres, parseGeoKeys, readCrs } from '../src/crs.js'
import { parseHeader } from '../src/header.js'
import { parseEvlrs, parseVlrs } from '../src/vlr.js'
import { buildLas } from './helpers/build-las.js'

const FIXTURE = new Uint8Array(
  fs.readFileSync(new URL('sample_data/Haystack_Rock.las', import.meta.url))
)

function readFixture () {
  const header = parseHeader(FIXTURE)
  const vlrs = parseVlrs(
    FIXTURE.subarray(header.headerSize, header.offsetToPointData),
    header.numberOfVariableLengthRecords,
    header.headerSize
  )
  return { header, vlrs }
}

/** Encodes a GeoKeyDirectoryTag payload. */
function geoKeyDirectory (entries) {
  const bytes = new Uint8Array(8 + entries.length * 8)
  const view = new DataView(bytes.buffer)
  view.setUint16(0, 1, true)
  view.setUint16(2, 1, true)
  view.setUint16(4, 0, true)
  view.setUint16(6, entries.length, true)
  entries.forEach(([id, location, count, offset], index) => {
    const at = 8 + index * 8
    view.setUint16(at, id, true)
    view.setUint16(at + 2, location, true)
    view.setUint16(at + 4, count, true)
    view.setUint16(at + 6, offset, true)
  })
  return bytes
}

function crsFromVlrs (vlrs, options = {}) {
  const bytes = buildLas({ points: [{}], vlrs, ...options })
  const header = parseHeader(bytes)
  const parsed = parseVlrs(
    bytes.subarray(header.headerSize, header.offsetToPointData), vlrs.length, header.headerSize
  )
  return readCrs(parsed, header)
}

describe('parseGeoKeys', () => {
  it('reads the directory of the checked-in fixture', () => {
    const { vlrs } = readFixture()
    const geo = parseGeoKeys(vlrs)
    assert.deepEqual(geo.version, { directory: 1, revision: 1, minorRevision: 0 })
    assert.deepEqual([...geo.keys.keys()], [1024, 3072, 3076, 4096, 4099])
    assert.equal(geo.keys.get(GEO_KEYS.ProjectedCSType).value, 3645)
    assert.equal(geo.keys.get(GEO_KEYS.VerticalCSType).value, 5703)
  })

  it('returns null when there is no directory', () => {
    assert.equal(parseGeoKeys([]), null)
  })

  it('resolves values stored in the double parameters record', () => {
    const doubles = new Uint8Array(16)
    const view = new DataView(doubles.buffer)
    view.setFloat64(0, 6378137, true)
    view.setFloat64(8, 298.257223563, true)

    const geo = parseGeoKeys(parseVlrsOf([
      { userId: 'LASF_Projection', recordId: 34735, data: geoKeyDirectory([[2057, 34736, 1, 0], [2059, 34736, 1, 1]]) },
      { userId: 'LASF_Projection', recordId: 34736, data: doubles }
    ]))

    assert.equal(geo.keys.get(2057).value, 6378137)
    assert.equal(geo.keys.get(2059).value, 298.257223563)
  })

  it('resolves values stored in the ascii parameters record, dropping the terminator', () => {
    const ascii = new TextEncoder().encode('NAD83 / Oregon North|WGS 84|')
    const geo = parseGeoKeys(parseVlrsOf([
      { userId: 'LASF_Projection', recordId: 34735, data: geoKeyDirectory([[1026, 34737, 21, 0], [2049, 34737, 7, 21]]) },
      { userId: 'LASF_Projection', recordId: 34737, data: ascii }
    ]))

    assert.equal(geo.keys.get(1026).value, 'NAD83 / Oregon North')
    assert.equal(geo.keys.get(2049).value, 'WGS 84')
  })

  it('stops rather than reading past a directory that overstates its key count', () => {
    const truncated = geoKeyDirectory([[1024, 0, 1, 1]])
    new DataView(truncated.buffer).setUint16(6, 40, true)
    const geo = parseGeoKeys(parseVlrsOf([
      { userId: 'LASF_Projection', recordId: 34735, data: truncated }
    ]))
    assert.equal(geo.keys.size, 1)
  })
})

function parseVlrsOf (vlrs) {
  const bytes = buildLas({ points: [{}], vlrs })
  const header = parseHeader(bytes)
  return parseVlrs(
    bytes.subarray(header.headerSize, header.offsetToPointData), vlrs.length, header.headerSize
  )
}

describe('readCrs, GeoTIFF keys', () => {
  it('reports the EPSG codes the fixture actually declares', () => {
    const { header, vlrs } = readFixture()
    const crs = readCrs(vlrs, header)

    assert.equal(crs.kind, 'geotiff')
    assert.equal(crs.horizontalEpsg, 3645)
    assert.equal(crs.projectedEpsg, 3645)
    assert.equal(crs.geographicEpsg, null)
    assert.equal(crs.verticalEpsg, 5703)
    assert.equal(crs.isProjected, true)
    assert.equal(crs.isGeographic, false)
    assert.equal(crs.linearUnitsEpsg, 9001)
    assert.equal(crs.horizontalUnitToMetres, 1)
    assert.equal(crs.verticalUnitToMetres, 1)
    assert.equal(crs.wkt, null)
  })

  it('falls back to the geographic code when there is no projected one', () => {
    const crs = crsFromVlrs([
      { userId: 'LASF_Projection', recordId: 34735, data: geoKeyDirectory([[1024, 0, 1, 2], [2048, 0, 1, 4326]]) }
    ])
    assert.equal(crs.horizontalEpsg, 4326)
    assert.equal(crs.isGeographic, true)
    assert.equal(crs.isProjected, false)
  })

  it('treats 0 and the user-defined sentinel as absent', () => {
    const crs = crsFromVlrs([
      { userId: 'LASF_Projection', recordId: 34735, data: geoKeyDirectory([[3072, 0, 1, 32767], [2048, 0, 1, 0], [4096, 0, 1, 32767]]) }
    ])
    assert.equal(crs.horizontalEpsg, null)
    assert.equal(crs.verticalEpsg, null)
  })

  it('reports feet when the file is in feet', () => {
    const crs = crsFromVlrs([
      { userId: 'LASF_Projection', recordId: 34735, data: geoKeyDirectory([[3076, 0, 1, 9003], [4099, 0, 1, 9002]]) }
    ])
    assert.equal(crs.linearUnitsEpsg, 9003)
    assert.equal(crs.horizontalUnitToMetres, 1200 / 3937)
    assert.equal(crs.verticalUnitToMetres, 0.3048)
  })
})

describe('readCrs, WKT', () => {
  const WKT = 'PROJCS["NAD83 / UTM zone 10N",GEOGCS["NAD83"],AUTHORITY["EPSG","26910"]]'

  it('hands back the WKT string verbatim', () => {
    const crs = crsFromVlrs(
      [{ userId: 'LASF_Projection', recordId: 2112, data: new TextEncoder().encode(WKT + '\0') }],
      { globalEncoding: 0b10000 }
    )
    assert.equal(crs.kind, 'wkt')
    assert.equal(crs.wkt, WKT)
    assert.equal(crs.declaresWkt, true)
  })

  it('finds WKT carried in an EVLR', () => {
    const bytes = buildLas({
      versionMinor: 4,
      pointFormat: 6,
      globalEncoding: 0b10000,
      points: [{}],
      evlrs: [{ userId: 'LASF_Projection', recordId: 2112, data: new TextEncoder().encode(WKT) }]
    })
    const header = parseHeader(bytes)
    const evlrs = parseEvlrs(bytes.subarray(header.startOfFirstEvlr), header.numberOfEvlrs, header.startOfFirstEvlr)
    const crs = readCrs(evlrs, header)
    assert.equal(crs.wkt, WKT)
  })

  it('prefers WKT over GeoTIFF keys when both are present', () => {
    const crs = crsFromVlrs([
      { userId: 'LASF_Projection', recordId: 34735, data: geoKeyDirectory([[3072, 0, 1, 3645]]) },
      { userId: 'LASF_Projection', recordId: 2112, data: new TextEncoder().encode(WKT) }
    ])
    assert.equal(crs.kind, 'wkt')
    assert.equal(crs.wkt, WKT)
    assert.equal(crs.horizontalEpsg, 3645, 'the GeoTIFF keys are still reported')
  })

  it('reports no CRS at all when the file carries none', () => {
    const crs = crsFromVlrs([])
    assert.equal(crs.kind, 'none')
    assert.equal(crs.wkt, null)
    assert.equal(crs.horizontalEpsg, null)
    assert.equal(crs.geoKeys, null)
  })
})

describe('linearUnitToMetres', () => {
  it('knows the EPSG linear units', () => {
    assert.equal(linearUnitToMetres(9001), 1)
    assert.equal(linearUnitToMetres(9002), 0.3048)
    assert.equal(linearUnitToMetres(9003), 1200 / 3937)
  })

  it('returns null for anything else', () => {
    assert.equal(linearUnitToMetres(4326), null)
    assert.equal(linearUnitToMetres(null), null)
    assert.equal(linearUnitToMetres(undefined), null)
  })
})
