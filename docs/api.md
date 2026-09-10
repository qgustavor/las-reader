# API reference

Everything is exported from `@qgustavor/las-reader`. The `/node` and `/browser`
entry points re-export all of it and add their own sources.

## Opening

### `openBytes(bytes, options?)` — core
### `openFile(path, options?)` — `/node`
### `openBlob(blob, options?)` — `/browser`
### `openUrl(url, options?)` — `/browser`
### `LasReader.open(source, options?)` — core

All return `Promise<LasReader>`.

Options:

| Option | Default | Meaning |
| --- | --- | --- |
| `allowTruncated` | `false` | Read what is present in a file shorter than its header claims, instead of throwing |
| `maxRecordPayload` | `16 MiB` | Record payloads larger than this are not read at open |

`openUrl` also takes `fetch`, `headers` and `requireRanges`.

## `LasReader`

### Properties

| | |
| --- | --- |
| `header` | [`LasHeader`](#lasheader) |
| `vlrs` | `LasRecord[]` — variable length records |
| `evlrs` | `LasRecord[]` — extended variable length records |
| `records` | Both, in file order |
| `crs` | [`Crs`](#crs) |
| `pointCount` | Points this reader will produce |
| `pointFormat` | Descriptor for the file's point data record format |

### `points(options?)`

Async generator of points. `reader[Symbol.asyncIterator]()` is this with no
options, so `for await (const point of reader)` works.

| Option | Default | Meaning |
| --- | --- | --- |
| `start` | `0` | First point index |
| `count` | rest | How many |
| `chunkSize` | `1 MiB` | Bytes read per block |
| `reuse` | `false` | Yield the same objects each time; copy what you keep |

### `chunks(options?)`

The same, yielding arrays of points instead of individual points.

### `blocks(options?)`

The raw primitive: yields `{ bytes, firstIndex, count, recordLength, fileOffset }`
without decoding. Use it when you want to reject records on a few bytes rather
than decode them all — which is what the filters do.

### `readPoints(start?, count?)`

`Promise<object[]>`. One read wherever the run is. Clamps to the end of the
file; throws `RangeError` on a negative or fractional `start`.

### `readPoint(index)`

`Promise<object | undefined>`.

### `readRecordData(record)`

`Promise<Uint8Array>`. Fetches the payload of a record whose payload was too
large to load at open. Records already loaded return their `data` unchanged.

### `stream(options?)`

A whatwg `ReadableStream` of point blocks. Cancelling it stops reading.

### `close()`

Releases the underlying source. Harmless on sources that hold nothing.

## Points

See [Getting started](getting-started.md#what-a-point-looks-like) for the field
table.

## `LasHeader`

`signature`, `fileSourceId`, `globalEncoding`, `projectId`, `version`
(`{ major, minor }`), `versionString`, `systemIdentifier`, `generatingSoftware`,
`fileCreationDayOfYear`, `fileCreationYear`, `headerSize`, `offsetToPointData`,
`numberOfVariableLengthRecords`, `pointDataRecordFormat`,
`pointDataRecordFormatRaw`, `compressed`, `pointDataRecordLength`,
`legacyPointCount`, `legacyPointCountByReturn`, `pointCount`,
`pointCountByReturn`, `scale`, `offset`, `bounds` (`{ min, max }`),
`startOfWaveformDataPacketRecord`, `startOfFirstEvlr`, `numberOfEvlrs`.

`globalEncoding` is `{ raw, adjustedStandardGpsTime, waveformDataInternal,
waveformDataExternal, syntheticReturnNumbers, wkt }`.

`compressed` is the LASzip bit taken off the format byte, so
`pointDataRecordFormat` is the real format id either way.

## `LasRecord`

`userId`, `recordId`, `description`, `reserved`, `data` (`Uint8Array`, or `null`
when the payload was too large to load), `dataOffset`, `dataLength`, `extended`,
`fileOffset`, `byteLength`.

### `findRecord(records, userId, recordId)`

First match, or `undefined`. `KNOWN_RECORDS` holds the ids the specification
reserves.

### `parseVlrs(bytes, count, origin?)` / `parseEvlrs(bytes, count, origin?)`

Synchronous, for bytes already in hand.

### `readRecords(source, start, end, count, options?)`

Asynchronous and incremental, for a region you do not want to buffer.

## `Crs`

See [Coordinate systems](coordinate-systems.md).

`kind`, `declaresWkt`, `wkt`, `mathTransformWkt`, `geoKeys`,
`geoKeyDirectoryVersion`, `horizontalEpsg`, `projectedEpsg`, `geographicEpsg`,
`verticalEpsg`, `linearUnitsEpsg`, `angularUnitsEpsg`, `verticalUnitsEpsg`,
`isProjected`, `isGeographic`, `horizontalUnitToMetres`, `verticalUnitToMetres`.

### `readCrs(records, header)` · `parseGeoKeys(records)` · `linearUnitToMetres(code)`

Also `GEO_KEYS` and `LINEAR_UNITS`.

## Filters

See [Finding points](filtering.md).

`pointsNear(reader, centre, options?)`, `pointsInBox(reader, box, options?)`,
`countInBox(reader, box, options?)`, `matching(spec?)`,
`toColumns(points, fields?)`, `boxToRawRange(header, box, options?)`.

## Block indexes

See [Working with large files](large-files.md).

`buildBlockIndex(reader, options?)`, `assertIndexMatches(index, reader)`,
`candidateRuns(index, range, window?)`, `selectivity(index, range)`,
`DEFAULT_BLOCK_SIZE`.

## Byte sources

See [Byte sources](byte-sources.md).

`bytesSource`, `fileSource`, `fileHandleSource`, `blobSource`,
`httpRangeSource`, `assertByteSource`, `readExact`, `checkRange`.

## Errors

`LasError`, `LasFormatError` (with `.offset`), `LasUnsupportedError`.

## Low level

`BinaryReader` — a bounds-checked little-endian cursor. `parseHeader`,
`validateHeader`, `decodePoint`, `getPointFormat`, `POINT_FORMATS`,
`HEADER_SIZES`, `MAX_HEADER_SIZE`, `FILE_SIGNATURE`,
`EXTENDED_SCAN_ANGLE_STEP`, `VLR_HEADER_BYTES`, `EVLR_HEADER_BYTES`,
`DEFAULT_MAX_PAYLOAD`.

## Point formats

| Format | Bytes | GPS time | RGB | NIR | Waveform | Since |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 20 | | | | | 1.0 |
| 1 | 28 | ● | | | | 1.0 |
| 2 | 26 | | ● | | | 1.2 |
| 3 | 34 | ● | ● | | | 1.2 |
| 4 | 57 | ● | | | ● | 1.3 |
| 5 | 63 | ● | ● | | ● | 1.3 |
| 6 | 30 | ● | | | | 1.4 |
| 7 | 36 | ● | ● | | | 1.4 |
| 8 | 38 | ● | ● | ● | | 1.4 |
| 9 | 59 | ● | | | ● | 1.4 |
| 10 | 67 | ● | ● | ● | ● | 1.4 |

Formats 6–10 widen the return numbers to four bits, promote classification to a
full byte, add the overlap flag and scanner channel, and store the scan angle as
0.006° steps. `point.scanAngle` is degrees for all of them.
