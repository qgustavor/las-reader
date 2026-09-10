# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The package is ESM-only. `require('las-reader')` no longer works; use
  `import`.
- Node.js 24 or newer is required.
- Sources are linted and formatted with [neostandard].

### Removed

- `request` is no longer a dependency. The EPSG sync script uses the global
  `fetch`.
- `nodeunit`, `sinon`, `chai-eventemitter`, `mocha` and `chai` are no longer
  devDependencies. Tests run on the built-in Node test runner.

### Fixed

- The "failed to determine epsg_projection from ProjLinearUnits custom value"
  log path referenced an undefined `getkey` binding and threw a
  `ReferenceError` instead of logging.

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
