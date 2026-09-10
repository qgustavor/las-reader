# Coordinate systems

This library does not reproject. It reports what the file declares and leaves
the transformation to whichever projection library you already use.

That is deliberate. Guessing a projection definition from GeoTIFF keys needs a
current EPSG database, which is a large, frequently revised dataset with no
business being frozen inside a parser. Version 1.x shipped a 2016 snapshot of
spatialreference.org — 444 KB in every install — and still got it wrong.

## What you get

```js
const {
  kind,              // 'wkt' | 'geotiff' | 'none' — what the file actually carries
  wkt,               // the WKT string, verbatim, or null
  horizontalEpsg,    // 3645
  verticalEpsg,      // 5703
  linearUnitsEpsg,   // 9001
  horizontalUnitToMetres,  // 1
  verticalUnitToMetres     // 1
} = reader.crs
```

Also available: `projectedEpsg` and `geographicEpsg` separately
(`horizontalEpsg` prefers the projected one), `mathTransformWkt`,
`angularUnitsEpsg`, `verticalUnitsEpsg`, `isProjected`, `isGeographic`,
`declaresWkt` (the header's global encoding bit), and `geoKeys`, the whole
GeoTIFF key directory as a `Map`.

WKT is read from record 2112 in either a VLR or an EVLR, so LAS 1.4 files that
put a long definition in an EVLR work.

## Reprojecting

```js
import proj4 from 'proj4'

const { wkt, horizontalEpsg } = reader.crs
const toWgs84 = proj4(wkt ?? `EPSG:${horizontalEpsg}`, 'EPSG:4326')

for await (const point of reader) {
  const [lon, lat] = toWgs84.forward([point.x, point.y])
}
```

Reprojecting every point is expensive. If you are filtering, filter first — the
query works in the file's own coordinates, so convert your centre point into
those once and transform only the results:

```js
const fromWgs84 = proj4('EPSG:4326', wkt ?? `EPSG:${horizontalEpsg}`)
const [x, y] = fromWgs84.forward([lon, lat])

for await (const point of pointsNear(reader, { x, y, radius: 25 })) { }
```

`proj4` needs a definition it recognises. Bare `EPSG:` codes other than a
handful of built-ins have to be registered first with `proj4.defs`, so if the
file carries WKT, prefer it.

## Units

Elevations are not always in metres. `verticalUnitToMetres` is the factor when
the file names a known EPSG linear unit, and `null` when it does not:

```js
const factor = reader.crs.verticalUnitToMetres ?? 1
const metres = point.z * factor
```

`linearUnitToMetres(epsgCode)` and the `LINEAR_UNITS` table are exported if you
want them directly. This is a fixed fifteen-entry table from the specification,
not fetched data.

## When the file says nothing

`kind === 'none'` means no WKT and no GeoTIFF keys. Plenty of files in the wild
are like this. The coordinates are still meaningful, you just have to be told
what they mean out of band — from the vendor, the survey report, or a sidecar
`.prj`.
