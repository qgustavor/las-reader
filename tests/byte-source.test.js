import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { assertByteSource, bytesSource, readExact } from '../src/byte-source.js'
import { LasFormatError } from '../src/errors.js'

describe('bytesSource', () => {
  const bytes = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7])

  it('exposes its length and reads ranges', async () => {
    const source = bytesSource(bytes)
    assert.equal(source.byteLength, 8)
    assert.deepEqual([...await source.read(2, 3)], [2, 3, 4])
  })

  it('accepts an ArrayBuffer', async () => {
    const source = bytesSource(bytes.buffer)
    assert.equal(source.byteLength, 8)
  })

  it('rejects reads past the end', async () => {
    const source = bytesSource(bytes)
    await assert.rejects(() => source.read(6, 4), LasFormatError)
    await assert.rejects(() => source.read(-1, 1), LasFormatError)
    await assert.rejects(() => source.read(0, 1.5), LasFormatError)
  })
})

describe('assertByteSource', () => {
  it('accepts anything with byteLength and read', () => {
    const source = { byteLength: 0, read: async () => new Uint8Array() }
    assert.equal(assertByteSource(source), source)
  })

  it('rejects everything else', () => {
    assert.throws(() => assertByteSource(null), TypeError)
    assert.throws(() => assertByteSource({ byteLength: 4 }), TypeError)
    assert.throws(() => assertByteSource({ read: async () => {} }), TypeError)
  })
})

describe('readExact', () => {
  it('reassembles short reads', async () => {
    const bytes = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7])
    let calls = 0
    const dribbling = {
      byteLength: bytes.byteLength,
      async read (offset, length) {
        calls++
        return bytes.subarray(offset, offset + Math.min(length, 3))
      }
    }
    assert.deepEqual([...await readExact(dribbling, 1, 6)], [1, 2, 3, 4, 5, 6])
    assert.equal(calls, 2)
  })

  it('gives back the original view when the source is cooperative', async () => {
    const source = bytesSource(Uint8Array.from([1, 2, 3, 4]))
    assert.deepEqual([...await readExact(source, 0, 4)], [1, 2, 3, 4])
  })

  it('throws instead of looping forever on a source that returns nothing', async () => {
    const stuck = { byteLength: 10, async read () { return new Uint8Array() } }
    await assert.rejects(() => readExact(stuck, 0, 4), LasFormatError)
  })
})
