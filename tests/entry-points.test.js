import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import fs from 'node:fs'
import { open as openFileHandle } from 'node:fs/promises'
import { fileHandleSource, fileSource, openFile } from '../src/node.js'
import { blobSource, httpRangeSource, openBlob } from '../src/browser.js'
import { LasReader } from '../src/index.js'
import { LasFormatError } from '../src/errors.js'

const SAMPLE_PATH = new URL('sample_data/Haystack_Rock.las', import.meta.url)
const FIXTURE = new Uint8Array(fs.readFileSync(SAMPLE_PATH))

describe('node entry point', () => {
  it('opens a file from disk and reads points', async () => {
    const reader = await openFile(SAMPLE_PATH)
    try {
      assert.equal(reader.pointCount, 21932)
      assert.equal((await reader.readPoint(0)).rawX, 23084422)
    } finally {
      await reader.close()
    }
  })

  it('closes the handle when opening fails', async () => {
    const broken = new URL('sample_data/broken.las', import.meta.url)
    fs.writeFileSync(broken, Buffer.from('NOTLASF'))
    try {
      await assert.rejects(() => openFile(broken), LasFormatError)
    } finally {
      fs.unlinkSync(broken)
    }
  })

  it('re-exports the core API', async () => {
    const node = await import('../src/node.js')
    assert.equal(typeof node.LasReader, 'function')
    assert.equal(typeof node.openBytes, 'function')
    assert.equal(typeof node.parseHeader, 'function')
  })

  it('reads through a caller-owned FileHandle without closing it', async () => {
    const handle = await openFileHandle(SAMPLE_PATH, 'r')
    try {
      const reader = await LasReader.open(fileHandleSource(handle, FIXTURE.byteLength))
      await reader.close()
      // Still usable: closing the reader did not close the handle.
      assert.equal((await handle.stat()).size, FIXTURE.byteLength)
    } finally {
      await handle.close()
    }
  })

  it('reports the file size on the source', async () => {
    const source = await fileSource(SAMPLE_PATH)
    try {
      assert.equal(source.byteLength, FIXTURE.byteLength)
      assert.deepEqual([...await source.read(0, 4)], [...FIXTURE.subarray(0, 4)])
    } finally {
      await source.close()
    }
  })
})

describe('browser entry point', () => {
  it('opens a Blob', async () => {
    const reader = await openBlob(new Blob([FIXTURE]))
    assert.equal(reader.pointCount, 21932)
    assert.equal((await reader.readPoint(1)).rawX, 23081793)
  })

  it('slices a Blob rather than reading it whole', async () => {
    const source = blobSource(new Blob([FIXTURE]))
    assert.equal(source.byteLength, FIXTURE.byteLength)
    assert.deepEqual([...await source.read(331, 4)], [...FIXTURE.subarray(331, 335)])
  })

  it('reads over HTTP with range requests', async () => {
    const requests = []
    const fakeFetch = async (url, init = {}) => {
      requests.push(init.method ?? 'GET')
      if (init.method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { 'content-length': String(FIXTURE.byteLength), 'accept-ranges': 'bytes' }
        })
      }
      const [, from, to] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range)
      return new Response(FIXTURE.subarray(Number(from), Number(to) + 1), { status: 206 })
    }

    const source = await httpRangeSource('https://example.invalid/cloud.las', { fetch: fakeFetch })
    const reader = await LasReader.open(source)
    assert.equal(reader.pointCount, 21932)
    assert.equal((await reader.readPoint(0)).rawX, 23084422)
    assert.equal(requests[0], 'HEAD')
    assert.ok(requests.length < 10, 'a whole-file download would not need ranges')
  })

  it('falls back to one full download when the server will not do ranges', async () => {
    const fakeFetch = async (url, init = {}) => {
      if (init.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': '1' } })
      return new Response(FIXTURE, { status: 200 })
    }
    const reader = await LasReader.open(
      await httpRangeSource('https://example.invalid/cloud.las', { fetch: fakeFetch })
    )
    assert.equal(reader.pointCount, 21932)
  })

  it('fails loudly instead when requireRanges is set', async () => {
    const fakeFetch = async () => new Response(null, { status: 200, headers: { 'content-length': '1' } })
    await assert.rejects(
      () => httpRangeSource('https://example.invalid/cloud.las', { fetch: fakeFetch, requireRanges: true }),
      (error) => error instanceof LasFormatError && /range requests/.test(error.message)
    )
  })

  it('surfaces an HTTP error', async () => {
    const fakeFetch = async () => new Response(null, { status: 404 })
    await assert.rejects(
      () => httpRangeSource('https://example.invalid/missing.las', { fetch: fakeFetch }),
      (error) => error instanceof LasFormatError && /404/.test(error.message)
    )
  })
})
