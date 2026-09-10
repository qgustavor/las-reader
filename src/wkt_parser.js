// Convert a WKT string into a JSON structure.

const MATCH_TAG = /^(\w+)\[/
const MATCH_STRING = /^"([\w ]+)"?/

function isWkt (value) {
  return MATCH_TAG.test(value)
}

function wktString (value) {
  const matched = value.match(MATCH_STRING)
  if (matched) {
    return matched[1]
  }
  return false
}

function splitData (data) {
  const results = []
  let level = 0
  let item = ''
  for (const char of data) {
    if (char === '[') {
      level++
    } else if (char === ']') {
      level--
    }
    if (char === ',' && level === 0) {
      results.push(String(item))
      item = ''
    } else {
      item += char
    }
  }
  results.push(item)
  return results
}

function extractKeyAndValues (wkt) {
  if (!wkt) {
    return false
  }
  if (!isWkt(wkt)) {
    return false
  }
  const value = wkt.match(MATCH_TAG)
  const key = value[1]
  let data = wkt.substring(value[0].length)
  if (data.includes(']')) {
    data = data.substring(0, data.lastIndexOf(']') - 1)
  }
  const result = {}
  if (key !== 'PARAMETER') {
    result[String(key)] = { name: '' }
  }
  const items = splitData(data)
  let i = 0
  let k2
  for (const item of items) {
    const asString = wktString(item)
    if (isWkt(item)) {
      const itemResult = extractKeyAndValues(item)
      for (const itemKey of Object.keys(itemResult)) {
        result[key][itemKey] = itemResult[itemKey]
      }
    } else if (asString) {
      if (i === 0) {
        if (key === 'PARAMETER') {
          k2 = asString
        } else {
          result[key].name = asString
        }
      } else {
        if (key === 'PARAMETER') {
          result[k2] = asString
        } else {
          result[key].value = asString
        }
      }
    } else {
      if (key === 'PARAMETER') {
        result[k2] = Number(item)
      } else {
        result[key].value = Number(item)
      }
    }
    i++
  }
  return result
}

export default function parseWkt (wkt) {
  wkt = wkt.replace(/\n*/mg, '')
  wkt = wkt.replace(/,\s+/g, ',')
  wkt = wkt.trim()
  return extractKeyAndValues(wkt)
}
