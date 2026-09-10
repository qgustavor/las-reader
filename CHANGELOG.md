# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0]

Renamed to `@qgustavor/las-reader`. The 1.x API is gone; see the migration
table in the README.

### Added

- LAS 1.3 and 1.4 support, and point data record formats 0 through 10.
- Extended variable length records (EVLRs).
- Random access: `readPoint(n)`, `readPoints(n, count)` and
  `points({ start })` resume anywhere in the file for the cost of one read.
- Async iteration (`for await (const point of reader)`), block iteration
  (`reader.chunks()`) and a whatwg `ReadableStream` (`reader.stream()`).
- Subpath entry points: `/node` (`openFile`, `fileSource`,
  `fileHandleSource`) and `/browser` (`openBlob`, `openUrl`, `blobSource`,
  `httpRangeSource`). The root entry point is pure JavaScript with no
  dependencies and no Node built-ins.
- `ByteSource`, a two-method interface for supplying bytes.
- `LasError`, `LasFormatError` (carrying the byte `offset` of the problem)
  and `LasUnsupportedError`.
- Extra bytes past a format's own fields are exposed as `point.extraBytes`.

### Changed

- `LasStreamReader` is replaced by `LasReader`, which reads by address
  rather than by chunk.
- Point fields are camelCase. `point.scaled` becomes `point.x/y/z`,
  `point.raw` becomes `point.rawX/rawY/rawZ`, and `scanAngle` is degrees
  for every format.
- The library no longer reprojects. `reader.crs` reports the WKT string or
  the EPSG codes the file declares, and callers pass those to proj4 or
  whatever else they already use.
- 64-bit header fields are read as `BigInt` and narrowed with an explicit
  range check.

### Removed

- `proj4` and `int64-buffer` dependencies. The package has none.
- `src/epsg.json` (444 KB), `src/geotiff.json` (152 KB), the custom WKT
  parser and the `spatialreference.org` fetcher.

### Fixed

- Output no longer depends on the size of the chunks the reader is fed.
  Reading `Haystack_Rock.las` with 1 KiB reads produced 175086 records
  instead of 21932, and never signalled completion.
- The return-number byte was decoded with its sub-fields reversed, so a
  first-of-one return was reported as return 0 of 2 with the
  edge-of-flight-line flag set.
- `classification` was `byte << 4` rather than `byte & 0b11111`, and the
  synthetic, key-point and withheld flags read the wrong bits.
- `intensity` was read big-endian.
- The EPSG code in `ProjectedCSTypeGeoKey` was read off the key object
  rather than its value, so it was never recognised.
- GeoTIFF ASCII keys were sliced with an end index where a length was
  required, and the `|` terminator was never stripped.
- The point data record format byte was read without masking the LASzip
  compression bits, so every compressed file appeared to use a format id
  128 higher than it did.
- Reprojection never happened at all: both code paths built an identity
  transform, with the real one commented out.
- Malformed input is rejected with the byte offset of the problem instead
  of being read past.

## [1.0.19]

Released from the original repository without a changelog entry.

## [1.0.18]

- Updated to the then-latest version of the proj4 library.
- Markdown fixes, thanks @martinheidegger.
- Fixed a strict mode issue, thanks @sanoel.

## [1.0.15]

- Special handling for Florida datasets.

## [1.0.14]

- Fixed a bug where `CT_TransverseMercator` triggered an error.

## [1.0.12]

- Added support for `PROJCS` WKT and improved GeoTIFF handling.

## [1.0.5] — 2016-12-12

- Fixed a vertical unit projection problem.
- Added conversion of vertical units to meters.

## [1.0.2] — 2016-11-02

- Improved error handling when the projection is missing from the variable
  length records.

## [1.0.0] — 2016-09-03

- Initial release, focused on LAS 1.2 files from the USGS and the US Coast
  Guard. Vertical and horizontal measurements were expected to be in meters.

[neostandard]: https://github.com/neostandard/neostandard
