import { BinaryReader } from './binary-reader.js'
import { findRecord, KNOWN_RECORDS } from './vlr.js'

/**
 * GeoTIFF key ids that appear in LAS files. Anything not listed here is still
 * returned in the `geoKeys` map, just without a name.
 */
export const GEO_KEYS = Object.freeze({
  GTModelType: 1024,
  GTRasterType: 1025,
  GTCitation: 1026,
  GeographicType: 2048,
  GeogCitation: 2049,
  GeogGeodeticDatum: 2050,
  GeogLinearUnits: 2052,
  GeogAngularUnits: 2054,
  ProjectedCSType: 3072,
  PCSCitation: 3073,
  ProjLinearUnits: 3076,
  VerticalCSType: 4096,
  VerticalCitation: 4097,
  VerticalDatum: 4098,
  VerticalUnits: 4099
})

/** GeoTIFF's "the value is not one of the enumerated ones" sentinel. */
const USER_DEFINED = 32767

/**
 * Metres per unit for the EPSG linear unit codes, from the EPSG geodetic
 * parameter dataset. Small, fixed, and defined by the specification, so it is
 * kept here rather than fetched.
 */
export const LINEAR_UNITS = Object.freeze({
  9001: { name: 'metre', toMetres: 1 },
  9002: { name: 'foot', toMetres: 0.3048 },
  9003: { name: 'US survey foot', toMetres: 1200 / 3937 },
  9004: { name: 'modified American foot', toMetres: 1200.005 / 3937 },
  9005: { name: 'Clarke foot', toMetres: 0.3047972654 },
  9006: { name: 'Indian foot', toMetres: 0.30479951 },
  9007: { name: 'link', toMetres: 0.201168 },
  9008: { name: 'Benoit link', toMetres: 0.201167824 },
  9009: { name: 'Sears link', toMetres: 0.20116765121553 },
  9010: { name: 'Benoit chain', toMetres: 20.1167824 },
  9011: { name: 'Sears chain', toMetres: 20.116765121553 },
  9012: { name: 'Sears yard', toMetres: 0.91439841461603 },
  9013: { name: 'Indian yard', toMetres: 0.91439853 },
  9014: { name: 'fathom', toMetres: 1.8288 },
  9015: { name: 'nautical mile', toMetres: 1852 }
})

/**
 * Metres per unit for an EPSG linear unit code, or null when the code is not a
 * known linear unit.
 *
 * @param {number | null | undefined} epsgCode
 * @returns {number | null}
 */
export function linearUnitToMetres (epsgCode) {
  return LINEAR_UNITS[epsgCode]?.toMetres ?? null
}

function normaliseCode (value) {
  if (typeof value !== 'number') return null
  if (value === 0 || value === USER_DEFINED) return null
  return value
}

/**
 * Decodes the GeoKeyDirectoryTag, resolving each key against the double and
 * ASCII parameter records it points at.
 *
 * @param {import('./vlr.js').LasRecord[]} records
 * @returns {{ version: object, keys: Map<number, { id: number, count: number, value: number | string | number[] }> } | null}
 */
export function parseGeoKeys (records) {
  const directory = findRecord(records, KNOWN_RECORDS.PROJECTION, KNOWN_RECORDS.GEO_KEY_DIRECTORY)
  if (!directory) return null

  const doublesRecord = findRecord(records, KNOWN_RECORDS.PROJECTION, KNOWN_RECORDS.GEO_DOUBLE_PARAMS)
  const asciiRecord = findRecord(records, KNOWN_RECORDS.PROJECTION, KNOWN_RECORDS.GEO_ASCII_PARAMS)

  const doubles = doublesRecord ? readDoubles(doublesRecord.data) : []
  const ascii = asciiRecord ? new TextDecoder().decode(asciiRecord.data) : ''

  const reader = new BinaryReader(directory.data, { origin: directory.fileOffset + 54 })
  const version = {
    directory: reader.u16(),
    revision: reader.u16(),
    minorRevision: reader.u16()
  }
  const count = reader.u16()

  const keys = new Map()
  for (let index = 0; index < count; index++) {
    if (reader.remaining < 8) break
    const id = reader.u16()
    const tiffTagLocation = reader.u16()
    const valueCount = reader.u16()
    const valueOffset = reader.u16()

    let value
    if (tiffTagLocation === 0) {
      value = valueOffset
    } else if (tiffTagLocation === KNOWN_RECORDS.GEO_DOUBLE_PARAMS) {
      const slice = doubles.slice(valueOffset, valueOffset + valueCount)
      value = valueCount === 1 ? slice[0] : slice
    } else if (tiffTagLocation === KNOWN_RECORDS.GEO_ASCII_PARAMS) {
      // GeoTIFF terminates ASCII values with '|' and counts the terminator.
      value = ascii.slice(valueOffset, valueOffset + valueCount).replace(/[|\0]+$/, '')
    } else {
      value = valueOffset
    }

    keys.set(id, { id, count: valueCount, value })
  }

  return { version, keys }
}

function readDoubles (bytes) {
  const reader = new BinaryReader(bytes)
  const values = []
  while (reader.remaining >= 8) values.push(reader.f64())
  return values
}

/**
 * Extracts everything the file says about its coordinate reference system,
 * without interpreting it.
 *
 * This library does not reproject. It hands back the WKT string the file
 * carries, or the EPSG codes its GeoTIFF keys name, and leaves the choice of
 * transformation library to the caller:
 *
 *     import proj4 from 'proj4'
 *     const toWgs84 = proj4(crs.wkt ?? `EPSG:${crs.horizontalEpsg}`, 'EPSG:4326')
 *     const [lon, lat] = toWgs84.forward([point.x, point.y])
 *
 * @param {import('./vlr.js').LasRecord[]} records VLRs and EVLRs together
 * @param {import('./header.js').LasHeader} header
 */
export function readCrs (records, header) {
  const wktRecord = findRecord(records, KNOWN_RECORDS.PROJECTION, KNOWN_RECORDS.COORDINATE_SYSTEM_WKT)
  const mathRecord = findRecord(records, KNOWN_RECORDS.PROJECTION, KNOWN_RECORDS.MATH_TRANSFORM_WKT)
  const geo = parseGeoKeys(records)

  const decoder = new TextDecoder()
  const wkt = wktRecord ? decoder.decode(wktRecord.data).replace(/\0+$/, '').trim() || null : null
  const mathTransformWkt = mathRecord ? decoder.decode(mathRecord.data).replace(/\0+$/, '').trim() || null : null

  const keys = geo?.keys ?? new Map()
  const keyValue = (id) => normaliseCode(keys.get(id)?.value)

  const modelType = keys.get(GEO_KEYS.GTModelType)?.value ?? null
  const projected = keyValue(GEO_KEYS.ProjectedCSType)
  const geographic = keyValue(GEO_KEYS.GeographicType)

  return {
    /**
     * Which of the two representations the file actually carries. The header's
     * WKT bit says which one a writer intended; this says what is present.
     */
    kind: wkt ? 'wkt' : geo ? 'geotiff' : 'none',
    /** True when the header's global encoding sets the WKT bit. */
    declaresWkt: header.globalEncoding.wkt,
    wkt,
    mathTransformWkt,
    geoKeys: geo?.keys ?? null,
    geoKeyDirectoryVersion: geo?.version ?? null,
    /** EPSG code of the horizontal CRS, projected in preference to geographic. */
    horizontalEpsg: projected ?? geographic,
    projectedEpsg: projected,
    geographicEpsg: geographic,
    verticalEpsg: keyValue(GEO_KEYS.VerticalCSType),
    linearUnitsEpsg: keyValue(GEO_KEYS.ProjLinearUnits) ?? keyValue(GEO_KEYS.GeogLinearUnits),
    angularUnitsEpsg: keyValue(GEO_KEYS.GeogAngularUnits),
    verticalUnitsEpsg: keyValue(GEO_KEYS.VerticalUnits),
    isProjected: modelType === null ? null : modelType === 1,
    isGeographic: modelType === null ? null : modelType === 2,
    /** Metres per horizontal unit, when the file names a known linear unit. */
    get horizontalUnitToMetres () {
      return linearUnitToMetres(this.linearUnitsEpsg)
    },
    /** Metres per vertical unit, when the file names a known linear unit. */
    get verticalUnitToMetres () {
      return linearUnitToMetres(this.verticalUnitsEpsg)
    }
  }
}
