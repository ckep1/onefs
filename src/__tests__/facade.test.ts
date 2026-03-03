import 'fake-indexeddb/auto'
import { describe, test, expect } from 'vitest'
import { createOneFS } from '../index'
import type { OneFSFile } from '../types'

function makeFile(
  name: string,
  content: string,
  mimeType = 'application/json'
): OneFSFile {
  const encoded = new TextEncoder().encode(content)
  return {
    id: 'test-id',
    name,
    content: encoded,
    mimeType,
    size: encoded.byteLength,
    lastModified: Date.now(),
  }
}

describe('OneFS content helpers', () => {
  const fs = createOneFS({ appName: 'facade-test' })

  describe('readAsText', () => {
    test('converts Uint8Array to string', () => {
      const file = makeFile('test.txt', 'hello world', 'text/plain')
      expect(fs.readAsText(file)).toBe('hello world')
    })

    test('handles unicode', () => {
      const file = makeFile('uni.txt', 'caf\u00e9 \u2603', 'text/plain')
      expect(fs.readAsText(file)).toBe('caf\u00e9 \u2603')
    })

    test('empty content', () => {
      const file: OneFSFile = {
        id: 'empty',
        name: 'empty.txt',
        content: new Uint8Array(0),
        mimeType: 'text/plain',
        size: 0,
        lastModified: Date.now(),
      }
      expect(fs.readAsText(file)).toBe('')
    })
  })

  describe('readAsJSON', () => {
    test('parses valid JSON', () => {
      const file = makeFile('data.json', '{"key":"value"}')
      const result = fs.readAsJSON(file)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data).toEqual({ key: 'value' })
      }
    })

    test('parses array JSON', () => {
      const file = makeFile('arr.json', '[1,2,3]')
      const result = fs.readAsJSON<number[]>(file)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data).toEqual([1, 2, 3])
      }
    })

    test('returns error for invalid JSON', () => {
      const file = makeFile('bad.json', '{not json}')
      const result = fs.readAsJSON(file)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error.code).toBe('io_error')
      }
    })
  })

  describe('readAsBlob', () => {
    test('returns Blob with correct type and size', () => {
      const content = '{"key":"value"}'
      const file = makeFile('data.json', content)
      const blob = fs.readAsBlob(file)
      expect(blob).toBeInstanceOf(Blob)
      expect(blob.type).toBe('application/json')
      expect(blob.size).toBe(new TextEncoder().encode(content).byteLength)
    })
  })

  describe('readAsDataURL', () => {
    test('returns proper data URL format', () => {
      const file = makeFile('data.json', '{}')
      const url = fs.readAsDataURL(file)
      expect(url).toMatch(/^data:application\/json;base64,/)
    })

    test('encodes content correctly', () => {
      const file = makeFile('test.txt', 'hello', 'text/plain')
      const url = fs.readAsDataURL(file)
      const base64 = url.split(',')[1]
      expect(atob(base64)).toBe('hello')
    })
  })

  describe('readAsObjectURL', () => {
    test('returns blob: URL string', () => {
      const file = makeFile('test.txt', 'data', 'text/plain')
      const url = fs.readAsObjectURL(file)
      expect(url).toMatch(/^blob:/)
      URL.revokeObjectURL(url)
    })
  })
})

describe('OneFS unsupported operations', () => {
  const fs = createOneFS({ appName: 'unsupported-test' })

  test('openDirectory returns not_supported on web-fallback', async () => {
    const result = await fs.openDirectory()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('not_supported')
    }
  })

  test('readDirectory returns not_supported on web-fallback', async () => {
    const dir = { id: 'x', name: 'test' }
    const result = await fs.readDirectory(dir)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('not_supported')
    }
  })

  test('scanDirectory returns not_supported on web-fallback', async () => {
    const dir = { id: 'x', name: 'test' }
    const result = await fs.scanDirectory(dir)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('not_supported')
    }
  })

  test('getEntryUrl returns not_supported on web-fallback', async () => {
    const entry = { name: 'test.txt', kind: 'file' as const }
    const result = await fs.getEntryUrl(entry)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('not_supported')
    }
  })

  test('getFileUrl returns not_supported on web-fallback', async () => {
    const file = makeFile('test.txt', 'data', 'text/plain')
    const result = await fs.getFileUrl(file)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('not_supported')
    }
  })

  test('queryPermission returns granted on non-FSA platform', async () => {
    const file = makeFile('test.txt', 'data', 'text/plain')
    const status = await fs.queryPermission(file, 'read')
    expect(status).toBe('granted')
  })

  test('requestPermission returns ok(true) on non-FSA platform', async () => {
    const file = makeFile('test.txt', 'data', 'text/plain')
    const result = await fs.requestPermission(file, 'read')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toBe(true)
  })
})
