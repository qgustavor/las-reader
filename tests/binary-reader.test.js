import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BinaryReader } from '../src/binary-reader.js'
import { LasFormatError } from '../src/errors.js'

function reader (bytes, options) {
  return new BinaryReader(Uint8Array.from(bytes), options)
}

describe('BinaryReader', () => {
  it('reads unsigned integers little-endian', () => {
    const r = reader([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07])
    assert.equal(r.u8(), 0x01)
    assert.equal(r.u16(), 0x0302)
    assert.equal(r.u32(), 0x07060504)
    assert.equal(r.remaining, 0)
  })

  it('reads signed integers', () => {
    const r = reader([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
    assert.equal(r.i8(), -1)
    assert.equal(r.i16(), -1)
    assert.equal(r.i32(), -1)
  })

  it('reads 64-bit integers as BigInt', () => {
    const r = reader([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
    assert.equal(r.u64(), 18446744073709551615n)
    r.seek(0)
    assert.equal(r.i64(), -1n)
  })

  it('reads floats', () => {
    const bytes = new Uint8Array(12)
    const view = new DataView(bytes.buffer)
    view.setFloat32(0, 0.5, true)
    view.setFloat64(4, -1234.5678, true)
    const r = new BinaryReader(bytes)
    assert.equal(r.f32(), 0.5)
    assert.equal(r.f64(), -1234.5678)
  })

  it('narrows a u64 to a Number when it is exactly representable', () => {
    const bytes = new Uint8Array(8)
    new DataView(bytes.buffer).setBigUint64(0, 4294967296n, true)
    assert.equal(new BinaryReader(bytes).u64AsNumber('point count'), 4294967296)
  })

  it('refuses to narrow a u64 that would lose precision', () => {
    const bytes = new Uint8Array(8)
    new DataView(bytes.buffer).setBigUint64(0, 2n ** 60n, true)
    assert.throws(
      () => new BinaryReader(bytes).u64AsNumber('point count'),
      (error) => error instanceof LasFormatError && /point count/.test(error.message)
    )
  })

  it('trims character fields at the first NUL', () => {
    const bytes = new Uint8Array(32)
    bytes.set(new TextEncoder().encode('LAStools  '))
    assert.equal(new BinaryReader(bytes).string(32), 'LAStools')
  })

  it('throws past the end of the region, naming the offset', () => {
    const r = reader([1, 2, 3])
    r.u16()
    assert.throws(() => r.u32(), (error) => {
      assert.ok(error instanceof LasFormatError)
      assert.equal(error.offset, 2)
      assert.match(error.message, /needed 4 bytes, 1 available/)
      return true
    })
  })

  it('reports offsets relative to the file when given an origin', () => {
    const r = reader([1, 2, 3], { origin: 1000 })
    assert.equal(r.fileOffset, 1000)
    r.u16()
    assert.equal(r.fileOffset, 1002)
    assert.throws(() => r.u32(), (error) => error.offset === 1002)
  })

  it('rejects seeking outside the region', () => {
    const r = reader([1, 2, 3])
    assert.throws(() => r.seek(4), LasFormatError)
    assert.throws(() => r.seek(-1), LasFormatError)
    assert.throws(() => r.skip(10), LasFormatError)
    assert.equal(r.offset, 0, 'a rejected seek leaves the cursor alone')
  })

  it('hands out subreaders that cannot read their neighbours', () => {
    const r = reader([1, 2, 3, 4, 5, 6], { origin: 100 })
    const first = r.subreader(2)
    assert.equal(first.byteLength, 2)
    assert.equal(first.fileOffset, 100)
    assert.equal(first.u16(), 0x0201)
    assert.throws(() => first.u8(), LasFormatError)
    assert.equal(r.offset, 2, 'the parent advanced past the subregion')
    assert.equal(r.u8(), 3)
  })

  it('does not copy when handing out bytes', () => {
    const bytes = Uint8Array.from([1, 2, 3, 4])
    const view = new BinaryReader(bytes).bytes(4)
    view[0] = 9
    assert.equal(bytes[0], 9)
  })
})
