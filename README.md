# las-reader

Read [LAS] lidar point cloud files in JavaScript.

## Install

```sh
npm install las-reader
```

Requires Node.js 24 or newer. The package is ESM-only.

## Usage

```js
import fs from 'node:fs'
import { LasStreamReader } from 'las-reader'

const reader = new LasStreamReader({ transform_lnglat: true })

reader.on('onParseHeader', (header) => {
  console.log(`${header.points.number_of_points} points`)
})

reader.on('error', (error) => {
  console.error(error)
})

for await (const records of fs.createReadStream('cloud.las').pipe(reader)) {
  for (const point of records) {
    console.log(point.scaled)
  }
}
```

`LasStreamReader` is a `Transform` stream in object mode. It consumes the raw
bytes of a LAS file and emits arrays of point records.

## Options

| Option               | Default | Description                                                            |
| -------------------- | ------- | ---------------------------------------------------------------------- |
| `transform_lnglat`   | `true`  | Reproject each point to WGS84 longitude/latitude.                       |
| `parse_every_x_point`| `1`     | Emit only every _n_-th point.                                           |
| `projection`         | —       | `{ epsg_datum }` to force a projection instead of reading it from VLRs. |
| `ignore_projection`  | `false` | Skip projection handling entirely.                                      |

## Events

| Event                      | Argument   | Emitted when                                          |
| -------------------------- | ---------- | ----------------------------------------------------- |
| `onParseHeader`            | `Header`   | The 400-byte public header block has been read.       |
| `onParseVLR`               | `object`   | All variable length records have been read.           |
| `onGotProjection`          | `object`   | A coordinate reference system has been determined.    |
| `onGotLazInfo`             | `LazZipVlr`| A LASzip VLR was found.                               |
| `onFinishedReadingRecords` | `number`   | Every point record has been read.                     |
| `log`                      | `object`   | `{ level, message }` diagnostics.                     |
| `error`                    | `Error`    | Parsing failed.                                       |

## Point records

Each emitted record has `raw` and `scaled` coordinate arrays, plus `intensity`,
`return_number`, `number_of_returns`, `scan_direction_flag`,
`edge_of_flight_line`, `classification`, `is_synthetic`, `is_key_point`,
`is_withheld`, `scan_angle_rank`, `user_data` and `point_source_id`. When
reprojection is enabled, `lng_lat` and `elevation` are added.

For the meaning of each field, see the [LAS specification][LAS].

## Status

This is a modernization in progress. The reader currently supports LAS 1.2 and
point data record format 0 only, its output depends on the size of the chunks
it receives, and several bit fields are decoded incorrectly. Those defects are
recorded as `todo` entries in the test suite, each naming the step that fixes
it. See [CHANGELOG.md](CHANGELOG.md).

## License

Apache-2.0

[LAS]: https://www.ogc.org/publications/standard/las/
