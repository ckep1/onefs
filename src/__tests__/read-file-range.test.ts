import 'fake-indexeddb/auto'
import { describe, test, expect, vi, afterEach } from 'vitest'
import { CapacitorAdapter } from '../adapters/capacitor'
import { TauriAdapter } from '../adapters/tauri'
import { FSAccessAdapter } from '../adapters/fs-access'
import { PickerIDBAdapter } from '../adapters/picker-idb'
import { createOneFS } from '../index'
import type { OneFSDirectory, OneFSEntry } from '../types'

const BYTES = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])

function uniqueName(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2)}`
}

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function makeResponse(options: {
  status: number
  body?: Uint8Array
  contentRange?: string
}): unknown {
  return {
    status: options.status,
    ok: options.status >= 200 && options.status < 300,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-range' ? options.contentRange ?? null : null,
    },
    arrayBuffer: async () => toBuffer(options.body ?? new Uint8Array(0)),
  }
}

function makeCapacitorAdapter(testName: string, fetchMock: ReturnType<typeof vi.fn>): CapacitorAdapter {
  const adapter = new CapacitorAdapter(uniqueName(`cap-${testName}`))

  ;(adapter as any).loadFilesystem = vi.fn().mockResolvedValue({
    Filesystem: { getUri: vi.fn().mockResolvedValue({ uri: 'file:///docs/song.mp3' }) },
    Directory: { Documents: 'DOCUMENTS' },
  })
  ;(adapter as any).loadCore = vi.fn().mockResolvedValue({
    Capacitor: { convertFileSrc: (uri: string) => `capacitor-asset://${uri}` },
  })
  vi.stubGlobal('fetch', fetchMock)

  return adapter
}

/** Seekable handle over an in-memory buffer, mirroring the Tauri v2 FileHandle API. */
function makeTauriHandle(data: Uint8Array, maxChunk = Number.MAX_SAFE_INTEGER) {
  let cursor = 0
  return {
    seek: vi.fn(async (offset: number) => {
      cursor = offset
      return cursor
    }),
    read: vi.fn(async (buffer: Uint8Array) => {
      const available = Math.max(0, data.byteLength - cursor)
      if (available === 0) return null
      const count = Math.min(buffer.byteLength, available, maxChunk)
      buffer.set(data.subarray(cursor, cursor + count))
      cursor += count
      return count
    }),
    stat: vi.fn(async () => ({ size: data.byteLength })),
    close: vi.fn(async () => {}),
  }
}

const DIRECTORY: OneFSDirectory = { id: 'dir-id', name: 'Documents', path: '' }
const ENTRY: OneFSEntry = { name: 'song.mp3', kind: 'file', path: 'song.mp3' }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('CapacitorAdapter.readFileRange', () => {
  test('requests the window over the asset server and reports total size', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({ status: 206, body: BYTES.slice(2, 6), contentRange: 'bytes 2-5/10' })
    )
    const adapter = makeCapacitorAdapter('range-happy', fetchMock)

    const result = await adapter.readFileRange(DIRECTORY, ENTRY, { position: 2, length: 4 })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(Array.from(result.data.content)).toEqual([2, 3, 4, 5])
      expect(result.data.fileSize).toBe(10)
    }
    expect(fetchMock).toHaveBeenCalledWith('capacitor-asset://file:///docs/song.mp3', {
      headers: { Range: 'bytes=2-5' },
    })
  })

  test('omits fileSize when the server sends an unknown total', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({ status: 206, body: BYTES.slice(0, 2), contentRange: 'bytes 0-1/*' })
    )
    const adapter = makeCapacitorAdapter('range-unknown-total', fetchMock)

    const result = await adapter.readFileRange(DIRECTORY, ENTRY, { position: 0, length: 2 })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.fileSize).toBeUndefined()
    }
  })

  test('slices the window out of the body when the server ignores Range', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ status: 200, body: BYTES }))
    const adapter = makeCapacitorAdapter('range-200', fetchMock)

    const result = await adapter.readFileRange(DIRECTORY, ENTRY, { position: 6, length: 3 })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(Array.from(result.data.content)).toEqual([6, 7, 8])
      expect(result.data.fileSize).toBe(10)
    }
  })

  test('returns the truncated window when the range runs past EOF', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({ status: 206, body: BYTES.slice(8), contentRange: 'bytes 8-9/10' })
    )
    const adapter = makeCapacitorAdapter('range-eof', fetchMock)

    const result = await adapter.readFileRange(DIRECTORY, ENTRY, { position: 8, length: 100 })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(Array.from(result.data.content)).toEqual([8, 9])
      expect(result.data.fileSize).toBe(10)
    }
  })

  test('returns an empty window for a 416 instead of throwing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ status: 416 }))
    const adapter = makeCapacitorAdapter('range-416', fetchMock)

    const result = await adapter.readFileRange(DIRECTORY, ENTRY, { position: 500, length: 10 })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.content.byteLength).toBe(0)
    }
  })

  test('rejects traversal paths before touching the network', async () => {
    const fetchMock = vi.fn()
    const adapter = makeCapacitorAdapter('range-traversal', fetchMock)

    const result = await adapter.readFileRange(
      DIRECTORY,
      { name: 'passwd', kind: 'file', path: '../../etc/passwd' },
      { position: 0, length: 4 }
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('permission_denied')
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('rejects entries outside the requested directory', async () => {
    const fetchMock = vi.fn()
    const adapter = makeCapacitorAdapter('range-outside', fetchMock)

    const result = await adapter.readFileRange(
      { id: 'dir-id', name: 'Music', path: 'Music' },
      { name: 'song.mp3', kind: 'file', path: 'Other/song.mp3' },
      { position: 0, length: 4 }
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('permission_denied')
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('rejects a negative position without fetching', async () => {
    const fetchMock = vi.fn()
    const adapter = makeCapacitorAdapter('range-negative', fetchMock)

    const result = await adapter.readFileRange(DIRECTORY, ENTRY, { position: -1, length: 4 })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('io_error')
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('short-circuits a zero-length read', async () => {
    const fetchMock = vi.fn()
    const adapter = makeCapacitorAdapter('range-zero', fetchMock)

    const result = await adapter.readFileRange(DIRECTORY, ENTRY, { position: 0, length: 0 })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.content.byteLength).toBe(0)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('surfaces a failed request as an error result', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ status: 500 }))
    const adapter = makeCapacitorAdapter('range-500', fetchMock)

    const result = await adapter.readFileRange(DIRECTORY, ENTRY, { position: 0, length: 4 })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('io_error')
    }
  })
})

describe('TauriAdapter.readFileRange', () => {
  test('seeks and reads only the requested window', async () => {
    const adapter = new TauriAdapter(uniqueName('tauri-range-happy'))
    const handle = makeTauriHandle(BYTES)
    const open = vi.fn().mockResolvedValue(handle)

    ;(adapter as any).loadModules = vi.fn().mockResolvedValue({
      fs: { open, SeekMode: { Start: 0, Current: 1, End: 2 } },
      dialog: {},
      core: {},
    })

    const directory: OneFSDirectory = { id: 'dir-id', name: 'Music', path: '/Music' }
    const entry: OneFSEntry = { name: 'song.mp3', kind: 'file', path: '/Music/song.mp3' }

    const result = await adapter.readFileRange(directory, entry, { position: 3, length: 4 })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(Array.from(result.data.content)).toEqual([3, 4, 5, 6])
      expect(result.data.fileSize).toBe(10)
    }
    expect(open).toHaveBeenCalledWith('/Music/song.mp3', { read: true })
    expect(handle.seek).toHaveBeenCalledWith(3, 0)
    expect(handle.close).toHaveBeenCalled()
  })

  test('fills the window across short reads', async () => {
    const adapter = new TauriAdapter(uniqueName('tauri-range-short'))
    const handle = makeTauriHandle(BYTES, 2)

    ;(adapter as any).loadModules = vi.fn().mockResolvedValue({
      fs: { open: vi.fn().mockResolvedValue(handle), SeekMode: { Start: 0 } },
      dialog: {},
      core: {},
    })

    const result = await adapter.readFileRange(
      { id: 'dir-id', name: 'Music', path: '/Music' },
      { name: 'song.mp3', kind: 'file', path: '/Music/song.mp3' },
      { position: 0, length: 5 }
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(Array.from(result.data.content)).toEqual([0, 1, 2, 3, 4])
    }
    expect(handle.read.mock.calls.length).toBeGreaterThan(1)
  })

  test('returns the truncated window when the range runs past EOF', async () => {
    const adapter = new TauriAdapter(uniqueName('tauri-range-eof'))
    const handle = makeTauriHandle(BYTES)

    ;(adapter as any).loadModules = vi.fn().mockResolvedValue({
      fs: { open: vi.fn().mockResolvedValue(handle), SeekMode: { Start: 0 } },
      dialog: {},
      core: {},
    })

    const result = await adapter.readFileRange(
      { id: 'dir-id', name: 'Music', path: '/Music' },
      { name: 'song.mp3', kind: 'file', path: '/Music/song.mp3' },
      { position: 7, length: 64 }
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(Array.from(result.data.content)).toEqual([7, 8, 9])
      expect(result.data.fileSize).toBe(10)
    }
    expect(handle.close).toHaveBeenCalled()
  })

  test('returns an empty window when the range starts past EOF', async () => {
    const adapter = new TauriAdapter(uniqueName('tauri-range-past-eof'))
    const handle = makeTauriHandle(BYTES)

    ;(adapter as any).loadModules = vi.fn().mockResolvedValue({
      fs: { open: vi.fn().mockResolvedValue(handle), SeekMode: { Start: 0 } },
      dialog: {},
      core: {},
    })

    const result = await adapter.readFileRange(
      { id: 'dir-id', name: 'Music', path: '/Music' },
      { name: 'song.mp3', kind: 'file', path: '/Music/song.mp3' },
      { position: 50, length: 8 }
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.content.byteLength).toBe(0)
    }
  })

  test('omits fileSize when stat fails but still returns the bytes', async () => {
    const adapter = new TauriAdapter(uniqueName('tauri-range-nostat'))
    const handle = makeTauriHandle(BYTES)
    handle.stat = vi.fn().mockRejectedValue(new Error('fstat unavailable'))

    ;(adapter as any).loadModules = vi.fn().mockResolvedValue({
      fs: { open: vi.fn().mockResolvedValue(handle), SeekMode: { Start: 0 } },
      dialog: {},
      core: {},
    })

    const result = await adapter.readFileRange(
      { id: 'dir-id', name: 'Music', path: '/Music' },
      { name: 'song.mp3', kind: 'file', path: '/Music/song.mp3' },
      { position: 0, length: 2 }
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(Array.from(result.data.content)).toEqual([0, 1])
      expect(result.data.fileSize).toBeUndefined()
    }
  })

  test('rejects entries outside the requested directory', async () => {
    const adapter = new TauriAdapter(uniqueName('tauri-range-outside'))
    const open = vi.fn()

    ;(adapter as any).loadModules = vi.fn().mockResolvedValue({
      fs: { open, SeekMode: { Start: 0 } },
      dialog: {},
      core: {},
    })

    const result = await adapter.readFileRange(
      { id: 'dir-id', name: 'Music', path: '/Music' },
      { name: 'passwd', kind: 'file', path: '/etc/passwd' },
      { position: 0, length: 4 }
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('permission_denied')
    }
    expect(open).not.toHaveBeenCalled()
  })

  test('closes the handle when the read throws', async () => {
    const adapter = new TauriAdapter(uniqueName('tauri-range-throw'))
    const handle = makeTauriHandle(BYTES)
    handle.read = vi.fn().mockRejectedValue(new Error('Permission denied'))

    ;(adapter as any).loadModules = vi.fn().mockResolvedValue({
      fs: { open: vi.fn().mockResolvedValue(handle), SeekMode: { Start: 0 } },
      dialog: {},
      core: {},
    })

    const result = await adapter.readFileRange(
      { id: 'dir-id', name: 'Music', path: '/Music' },
      { name: 'song.mp3', kind: 'file', path: '/Music/song.mp3' },
      { position: 0, length: 4 }
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('permission_denied')
    }
    expect(handle.close).toHaveBeenCalled()
  })
})

describe('FSAccessAdapter.readFileRange', () => {
  function makeEntry(bytes: Uint8Array): OneFSEntry {
    const file = new File([toBuffer(bytes)], 'song.mp3', { type: 'audio/mpeg' })
    return {
      name: 'song.mp3',
      kind: 'file',
      handle: { kind: 'file', name: 'song.mp3', getFile: async () => file } as any,
    }
  }

  test('slices the requested window without reading the whole file', async () => {
    const adapter = new FSAccessAdapter(uniqueName('fsa-range-happy'))

    const result = await adapter.readFileRange(
      { id: 'dir-id', name: 'Music' },
      makeEntry(BYTES),
      { position: 4, length: 3 }
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(Array.from(result.data.content)).toEqual([4, 5, 6])
      expect(result.data.fileSize).toBe(10)
    }
  })

  test('clamps a window that runs past EOF', async () => {
    const adapter = new FSAccessAdapter(uniqueName('fsa-range-eof'))

    const result = await adapter.readFileRange(
      { id: 'dir-id', name: 'Music' },
      makeEntry(BYTES),
      { position: 9, length: 32 }
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(Array.from(result.data.content)).toEqual([9])
      expect(result.data.fileSize).toBe(10)
    }
  })

  test('returns an empty window when the range starts past EOF', async () => {
    const adapter = new FSAccessAdapter(uniqueName('fsa-range-past-eof'))

    const result = await adapter.readFileRange(
      { id: 'dir-id', name: 'Music' },
      makeEntry(BYTES),
      { position: 40, length: 8 }
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.content.byteLength).toBe(0)
    }
  })

  test('returns not_supported without a handle', async () => {
    const adapter = new FSAccessAdapter(uniqueName('fsa-range-nohandle'))

    const result = await adapter.readFileRange(
      { id: 'dir-id', name: 'Music' },
      { name: 'song.mp3', kind: 'file' },
      { position: 0, length: 4 }
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('not_supported')
    }
  })
})

describe('PickerIDBAdapter.readFileRange', () => {
  async function makeAdapterWithCache(testName: string) {
    const adapter = new PickerIDBAdapter(uniqueName(`idb-${testName}`))
    await (adapter as any).storage.storeFile({
      id: 'cached-id',
      name: 'song.mp3',
      content: BYTES,
      mimeType: 'audio/mpeg',
      size: BYTES.byteLength,
      lastModified: 1,
      storedAt: 1,
    })
    return adapter
  }

  test('slices cached content', async () => {
    const adapter = await makeAdapterWithCache('range-happy')

    const result = await adapter.readFileRange(
      { id: 'dir-id', name: 'n/a' },
      { name: 'song.mp3', kind: 'file' },
      { position: 1, length: 3 }
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(Array.from(result.data.content)).toEqual([1, 2, 3])
      expect(result.data.fileSize).toBe(10)
    }
  })

  test('clamps a window that runs past EOF', async () => {
    const adapter = await makeAdapterWithCache('range-eof')

    const result = await adapter.readFileRange(
      { id: 'dir-id', name: 'n/a' },
      { name: 'song.mp3', kind: 'file' },
      { position: 8, length: 16 }
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(Array.from(result.data.content)).toEqual([8, 9])
    }
  })

  test('returns not_supported when nothing is cached for the entry', async () => {
    const adapter = await makeAdapterWithCache('range-uncached')

    const result = await adapter.readFileRange(
      { id: 'dir-id', name: 'n/a' },
      { name: 'other.mp3', kind: 'file' },
      { position: 0, length: 4 }
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('not_supported')
    }
  })
})

describe('OneFS.readFileRange facade', () => {
  test('delegates to the adapter on the current platform', async () => {
    const fs = createOneFS({ appName: uniqueName('facade-range').replace(/[^\w.-]/g, '') })

    const result = await fs.readFileRange(
      { id: 'dir-id', name: 'n/a' },
      { name: 'missing.mp3', kind: 'file' },
      { position: 0, length: 4 }
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('not_supported')
    }
  })

  test('web-fallback reports readFileRange as unavailable', () => {
    const fs = createOneFS({ appName: 'facade-range-caps' })
    expect(fs.platform).toBe('web-fallback')
    expect(fs.capabilities.readFileRange).toBe(false)
  })
})
