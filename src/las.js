import * as models from './models.js'
import epsg from './epsg.json' with { type: 'json' }
import proj4Module from 'proj4'
import stream from 'node:stream'
import parseWkt from './wkt_parser.js'

const proj4 = proj4Module.default ?? proj4Module

const linearUnitDefs = {
  9001: function (value) {
    // Linear_Meter
    return Number(value)
  },
  9002: function (value) {
    // Linear_Foot
    return Number(value) * 0.3048
  },
  9003: function (value) {
    // Linear_Foot_US_Survey
    return Number(value) * (1200 / 3937)
  },
  9004: function (value) {
    // Linear_Foot_Modified_American
    return Number(value) * (1200 / 3937)
  },
  9005: function (value) {
    // Linear_Foot_Clarke
    return value * 0.3047972654
  },
  9006: function (value) {
    // Linear_Foot_Indian
    return value * 0.3047995
  },
  9007: function (value) {
    // Linear_Link
    return value * 0.201168
  }
  /* TODO add these mostly unused units of measure.
  Linear_Link_Benoit = 9008
  Linear_Link_Sears = 9009
  Linear_Chain_Benoit = 9010
  Linear_Chain_Sears = 9011
  Linear_Yard_Sears = 9012
  Linear_Yard_Indian = 9013
  Linear_Fathom = 9014
  Linear_Mile_International_Nautical = 9015
  */
}

class LasStreamReader extends stream.Transform {
  constructor (options) {
    super({ readableObjectMode: true })
    this.point_record_options = {}
    this.read_header = false
    this.read_vlr = false
    this.got_projection = false
    this.bytes_read = 0
    this.header_buffer = Buffer.alloc(400)
    this.header_bytes_read = 0
    this.point_record_options.transform_latlng = true
    this.is_laz = false
    this.check_laz = false
    this.check_classification_lookup = false
    this.has_classification_lookup_table = false
    this.parse_every_x_point = 1
    if (options) {
      // transform_lnglat, parse_every_x_point, projection, ignore_projection
      this.point_record_options.transform_lnglat = options.transform_lnglat !== false // raw | scaled | wgs
      this.parse_every_x_point = options.parse_every_x_point || 1

      if (options.projection && options.projection.epsg_datum && !options.ignore_projection) {
        const epsgCode = epsg[String(options.projection.epsg_datum)]
        this.projection = {
          epsg_datum: options.projection.epsg_datum,
          epsg_code: epsgCode,
          convert_to_wgs84: new proj4(epsgCode, proj4.defs('EPSG:4326')),
          convert_elevation_to_meters: function (value) { return value }
        }
        // ignore VLR projection data and use this one instead.
        this.got_projection = true
      }

      if (options.ignore_projection) {
        this.got_projection = true
      }
    }
  }

  _transform (data, encoding, callback) {
    const size = data.length
    const records = []
    this.bytes_read += size
    const chunkStart = this.bytes_read - size
    if (!this.read_header) {
      this._do_read_header(data, chunkStart)
    }

    if (this.read_header && !this.read_vlr) {
      this._do_read_vlr(data, chunkStart)
    }
    if (this.read_header && this.read_vlr) {
      if (this.is_laz) {
        callback('laszip is not supported yet')
      } else {
        this._do_read_records(data, chunkStart, callback)
      }
    } else {
      callback(null, records)
    }
  }

  _flush (callback) {
    callback()
  }

  _do_read_header (data, chunkStart) {
    this.header_bytes_read = fillToBuffer(data, this.header_buffer, this.header_bytes_read)
    if (this.header_bytes_read === 400) {
      this.header = new models.Header(data.buffer)
      const offset = this.header.header_size
      const startPointData = this.header.offset_to_point_data
      this.vlr_buffer = Buffer.alloc(parseInt(startPointData) - parseInt(offset))
      this.vlr_bytes_read = 0
      this.read_header = true
      this.points_data_size = this.header.point_data_record.length * this.header.points.number_of_points
      this.points_data_read = 0
      this.emit('onParseHeader', this.header)
    }
  }

  _do_read_vlr (data, chunkStart) {
    if (chunkStart < this.header.header_size) {
      this.vlr_bytes_read = fillToBuffer(
        data.slice(this.header.header_size), this.vlr_buffer, this.vlr_bytes_read
      )
    } else {
      this.vlr_bytes_read = fillToBuffer(data, this.vlr_buffer, this.vlr_bytes_read)
    }
    const vlrRemain = this.vlr_buffer.length - this.vlr_bytes_read
    if (vlrRemain === 0) {
      this.vlr = {}
      let lastVlrOffset = 0
      for (let i = 0; i < this.header.number_of_variable_length_records; i++) {
        const d = this.vlr_buffer.buffer.slice(lastVlrOffset)
        const vlr = new models.VariableLengthRecordHeader(d)

        lastVlrOffset += vlr.record_length
        if (!this.vlr[String(vlr.user_id)]) {
          this.vlr[String(vlr.user_id)] = {}
        }
        this.vlr[vlr.user_id][String(vlr.record_id)] = vlr
      }
      this.read_vlr = true
      if (!this.check_laz) {
        if (this.vlr['laszip encoded'] && this.vlr['laszip encoded']['22204']) {
          this.vlr['laszip encoded'].laz_info =
            new models.LazZipVlr(this.vlr['laszip encoded']['22204'].data)
          this.is_laz = this.emit('onGotLazInfo', this.vlr['laszip encoded'].laz_info)
        }
        this.check_laz = true
      }

      if (!this.check_classification_lookup) {
        checkClassificationLookup(this)
      }
      this.emit('onParseVLR', this.vlr)
      if (!this.got_projection) {
        if (!this.vlr.LASF_Projection) {
          this.emit('error', new Error('Unable to determine projection from variable length records'))
        } else {
          this.projection = computeProjection(this, this.vlr)
          if (this.projection && this.projection.convert_to_wgs84) {
            try {
              const ne = this.projection.convert_to_wgs84.forward(
                [this.header.max_min[0][1], this.header.max_min[1][1]]
              )
              const sw = this.projection.convert_to_wgs84.forward(
                [this.header.max_min[0][1], this.header.max_min[1][1]]
              )
              this.projection.bounds = [sw, ne]
              this.emit('onGotProjection', this.projection)
            } catch (error) {
              this.emit('error', error)
            }
          } else {
            this.emit('error', new Error(
              'invalid projection\n' + JSON.stringify(this.projection, null, ' ')
            ))
          }
        }
      }
    }
  }

  _do_read_records (data, chunkStart, callback) {
    let localBuffer
    const recSize = this.header.point_data_record.length
    if (chunkStart < this.header.offset_to_point_data) {
      localBuffer = data.buffer.slice(this.header.offset_to_point_data)
    } else {
      if (this.save_buffer) {
        const tmpBuffer = Buffer.concat([Buffer.from(this.save_buffer), data])
        localBuffer = tmpBuffer.buffer
      } else {
        localBuffer = data.buffer
      }
    }
    const remainder = localBuffer.byteLength % recSize
    const end = localBuffer.byteLength - remainder
    const procBuffer = localBuffer.slice(0, end)
    this.points_data_read += procBuffer.byteLength
    if (remainder) {
      this.save_buffer = localBuffer.slice(end)
    } else {
      this.save_buffer = null
    }
    const numRecords = parseInt(procBuffer.byteLength / recSize)
    const records = []
    for (let i = 0; i < numRecords; i += this.parse_every_x_point) {
      const startRec = i * recSize
      const endRec = (i + 1) * recSize
      records.push(new models.PointRecord(
        procBuffer.slice(startRec, endRec), this.header, this.point_record_options, this.projection
      ))
    }
    if (this.points_data_read === this.points_data_size) {
      this.emit('onFinishedReadingRecords', this.header.points.number_of_points)
    }
    this.push(records)
    callback()
  }
}

function fillToBuffer (inBuffer, fillBuffer, filled) {
  const remain = fillBuffer.length - filled
  if (inBuffer.length >= remain) {
    fillBuffer.fill(inBuffer.slice(0, remain), filled)
    filled += remain
  } else {
    fillBuffer.fill(inBuffer, filled)
    filled += inBuffer.length
  }
  return filled
}

function computeProjection (obj, records) { // variable length records
  if (records.LASF_Projection) {
    if (records.LASF_Projection['34735']) {
      return computeProjectionWithGeoTag(obj, records.LASF_Projection)
    } else if (records.LASF_Projection['2111']) {
      obj.emit('error', new Error('Math WKT transform not supported'))
    } else if (records.LASF_Projection['2112']) {
      const projection = {
        target_proj: proj4.defs('EPSG:4326'),
        got_projection: true,
        wkt: records.LASF_Projection['2112'].ascii_data,
        parse_wkt: parseWkt(records.LASF_Projection['2112'].ascii_data),
        convert_to_wgs84: null,
        convert_elevation_to_meters: function (value) { return value },
        convert_linear_to_meters: function (value) { return value }
      }
      if (
        projection.parse_wkt.PROJCS &&
        projection.parse_wkt.PROJCS.UNIT &&
        projection.parse_wkt.PROJCS.UNIT.name !== 'meter'
      ) {
        projection.convert_elevation_to_meters = function (value) {
          return value * Number(projection.parse_wkt.PROJCS.UNIT.value)
        }
      }
      try {
        // ORIGINAL projection.convert_to_wgs84 = new proj4(projection.wkt, projection.target_proj)
        projection.convert_to_wgs84 = new proj4(projection.target_proj, projection.target_proj)
        projection.got_projection = true
        return projection
      } catch (error) {
        obj.emit('log', {
          level: 'error',
          message: 'error building projection: ' + JSON.stringify(projection, null, ' ')
        })
        obj.emit('error', new Error(`error building projection from wkt ${error}`))
      }
    }
  }
}

function checkClassificationLookup (self) {
  if (self.vlr.LASF_Spec && self.vlr.LASF_Spec['0']) {
    self.classification_table = new models.ClassificationTable(self.vlr.LASF_Spec['0'])
  }
  self.check_classification_lookup = true
}

function computeProjectionWithGeoTag (obj, projectionRecords) {
  const projection = {
    codes: {},
    got_projection: false,
    convert_to_wgs84: null,
    target_proj: proj4.defs('EPSG:4326'),
    convert_elevation_to_meters: function (value) { return value },
    convert_linear_to_meters: function (value) { return value }
  }
  const geokey = new models.GeoKey(projectionRecords)
  projection.geokey = geokey
  // Get the EPSG code held in key 3072 or throw an error because this file
  // lacks common decency.
  // See http://gis.stackexchange.com/questions/173111/converting-geotiff-projection-definition-to-proj4
  // todo: other projection options.
  // http://www.remotesensing.org/geotiff/spec/geotiff6.html#6.3.3.1
  let epsgCode
  // check for Unit code
  if (geokey.has_epsg_projection) {
    epsgCode = String(epsg[String(geokey.epsg_projection_code)])
    if (epsgCode && epsgCode !== 'unknown') {
      projection.epsg_proj4 = epsgCode
      projection.epsg_datum = geokey.epsg_projection_code
      if (projection.geokey.proj4_values['+units'] !== 'm') {
        projection.epsg_proj4 = projection.epsg_proj4.replace(
          '+units=m', '+units=' + projection.geokey.proj4_values['+units']
        )
      }
      projection.got_projection = true
    } else {
      obj.emit('log', {
        level: 'info',
        message: 'failed to determine epsg_projection from code: ' + geokey.epsg_projection_code
      })
    }
  }
  if (!projection.got_projection && geokey.hasKey(3076)) {
    if (Number(geokey.getKey(3076).value) > 9015) {
      epsgCode = String(epsg[String(geokey.getKey(3076).value)])
      if (epsgCode && epsgCode !== 'unknown') {
        projection.epsg_proj4 = epsgCode
        if (geokey.hasKey(2052) && geokey.getKey(2052).value) {
          projection.epsg_proj4 = projection.epsg_proj4.replace(
            '+units=m', '+units=' + geokey.getProjValueForKey(2052)
          )
        }
        projection.got_projection = true
      } else {
        obj.emit('log', {
          level: 'info',
          message: 'failed to determine epsg_projection from ProjLinearUnits custom value: ' +
            geokey.getKey(3076).value
        })
      }
    }
  }
  if (!projection.got_projection) {
    projection.epsg_proj4 = geokey.computeProj4Args()
    projection.got_projection = true
  }
  try {
    // ORIGINAL projection.convert_to_wgs84 = new proj4(projection.epsg_proj4, projection.target_proj)
    projection.convert_to_wgs84 = new proj4(projection.target_proj, projection.target_proj)
    projection.got_projection = true
  } catch (error) {
    obj.emit('log', {
      level: 'error',
      message: 'error building projection: ' + JSON.stringify(projection, null, ' ')
    })
    obj.emit('error', new Error(`error building projection ${error}`))
    return
  }

  // VerticalCSTypeGeoKey
  // http://www.remotesensing.org/geotiff/spec/geotiff6.html#6.3.4.1

  if (geokey.key['4096']) {
    const key = geokey.key['4096']
    projection.epsg_vertical_datum = key.wValue_Offset
  }
  if (geokey.key['4099']) {
    const key = geokey.key['4099']
    projection.vertical_unit_key = String(key.wValue_Offset)
    projection.convert_elevation_to_meters = linearUnitDefs[projection.vertical_unit_key]
  }
  return projection
}

export { models, LasStreamReader }
