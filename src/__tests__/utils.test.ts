import { describe, test, expect } from 'vitest'
import {
  generateId,
  getFileName,
  getMimeType,
  normalizePath,
  isPathWithin,
  sanitizeFileName,
  toArrayBuffer,
  uint8ArrayToBase64,
  base64ToUint8Array,
} from '../utils'

describe('generateId', () => {
  test('returns a string', () => {
    expect(typeof generateId()).toBe('string')
  })

  test('returns unique values', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()))
    expect(ids.size).toBe(100)
  })

  test('matches UUID format', () => {
    const uuid = generateId()
    expect(uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
  })
})

describe('getFileName', () => {
  test('unix path', () => {
    expect(getFileName('/foo/bar/file.txt')).toBe('file.txt')
  })

  test('windows path', () => {
    expect(getFileName('C:\\Users\\file.txt')).toBe('file.txt')
  })

  test('just a filename', () => {
    expect(getFileName('file.txt')).toBe('file.txt')
  })

  test('trailing slash falls back to full path', () => {
    expect(getFileName('/foo/bar/')).toBe('/foo/bar/')
  })

  test('empty string', () => {
    expect(getFileName('')).toBe('')
  })
})

describe('getMimeType', () => {
  test('json extension', () => {
    expect(getMimeType('data.json')).toBe('application/json')
  })

  test('txt extension', () => {
    expect(getMimeType('readme.txt')).toBe('text/plain')
  })

  test('mp3 extension', () => {
    expect(getMimeType('song.mp3')).toBe('audio/mpeg')
  })

  test('png extension', () => {
    expect(getMimeType('image.png')).toBe('image/png')
  })

  test('unknown extension', () => {
    expect(getMimeType('file.xyz')).toBe('application/octet-stream')
  })

  test('no extension', () => {
    expect(getMimeType('Makefile')).toBe('application/octet-stream')
  })

  test('uppercase extension is resolved (lowercased internally)', () => {
    expect(getMimeType('data.JSON')).toBe('application/json')
  })

  test('multiple dots uses last extension', () => {
    expect(getMimeType('archive.tar.gz')).toBe('application/gzip')
  })
})

describe('normalizePath', () => {
  test('resolves parent references', () => {
    expect(normalizePath('/foo/bar/../baz')).toBe('/foo/baz')
  })

  test('resolves current directory references', () => {
    expect(normalizePath('/foo/./bar')).toBe('/foo/bar')
  })

  test('collapses double slashes', () => {
    expect(normalizePath('/foo//bar')).toBe('/foo/bar')
  })

  test('removes trailing slash', () => {
    expect(normalizePath('/foo/bar/')).toBe('/foo/bar')
  })

  test('preserves root', () => {
    expect(normalizePath('/')).toBe('/')
  })

  test('handles backslashes', () => {
    expect(normalizePath('C:\\foo\\bar')).toBe('C:/foo/bar')
  })

  test('empty string', () => {
    expect(normalizePath('')).toBe('')
  })

  test('does not go above root', () => {
    expect(normalizePath('/../foo')).toBe('/foo')
  })

  test('multiple parent references', () => {
    expect(normalizePath('/a/b/c/../../d')).toBe('/a/d')
  })

  test('relative path without leading slash', () => {
    expect(normalizePath('foo/bar/../baz')).toBe('foo/baz')
  })
})

describe('isPathWithin', () => {
  test('basic containment', () => {
    expect(isPathWithin('/foo/bar', '/foo')).toBe(true)
  })

  test('exact match', () => {
    expect(isPathWithin('/foo', '/foo')).toBe(true)
  })

  test('not contained', () => {
    expect(isPathWithin('/foo/bar', '/baz')).toBe(false)
  })

  test('prefix trick - partial segment match is not a real parent', () => {
    expect(isPathWithin('/foo/bar', '/foo/b')).toBe(false)
  })

  test('traversal escapes parent', () => {
    expect(isPathWithin('/foo/../etc', '/foo')).toBe(false)
  })

  test('empty parent does not contain relative paths', () => {
    expect(isPathWithin('foo/bar', '')).toBe(false)
  })

  test('deeper nesting', () => {
    expect(isPathWithin('/a/b/c/d', '/a/b')).toBe(true)
  })
})

describe('sanitizeFileName', () => {
  test('strips forward slashes', () => {
    expect(sanitizeFileName('foo/bar')).toBe('foobar')
  })

  test('strips backslashes', () => {
    expect(sanitizeFileName('foo\\bar')).toBe('foobar')
  })

  test('strips null bytes', () => {
    expect(sanitizeFileName('foo\0bar')).toBe('foobar')
  })

  test('strips double dots', () => {
    expect(sanitizeFileName('..test')).toBe('test')
  })

  test('combined traversal', () => {
    expect(sanitizeFileName('../etc/passwd')).toBe('etcpasswd')
  })

  test('normal filename unchanged', () => {
    expect(sanitizeFileName('file.txt')).toBe('file.txt')
  })

  test('multiple consecutive dots', () => {
    expect(sanitizeFileName('....test')).toBe('test')
  })
})

describe('toArrayBuffer', () => {
  test('returns correct ArrayBuffer from Uint8Array', () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const ab = toArrayBuffer(bytes)
    expect(ab).toBeInstanceOf(ArrayBuffer)
    expect(ab.byteLength).toBe(4)
    expect(new Uint8Array(ab)).toEqual(new Uint8Array([1, 2, 3, 4]))
  })

  test('handles Uint8Array with byteOffset', () => {
    const buffer = new ArrayBuffer(8)
    const full = new Uint8Array(buffer)
    full.set([10, 20, 30, 40, 50, 60, 70, 80])
    const view = new Uint8Array(buffer, 2, 3)
    const ab = toArrayBuffer(view)
    expect(ab.byteLength).toBe(3)
    expect(new Uint8Array(ab)).toEqual(new Uint8Array([30, 40, 50]))
  })

  test('handles empty Uint8Array', () => {
    const ab = toArrayBuffer(new Uint8Array(0))
    expect(ab.byteLength).toBe(0)
  })
})

describe('uint8ArrayToBase64', () => {
  test('encodes correctly', () => {
    const text = 'Hello, World!'
    const bytes = new TextEncoder().encode(text)
    expect(uint8ArrayToBase64(bytes)).toBe(btoa(text))
  })

  test('empty array returns empty string', () => {
    expect(uint8ArrayToBase64(new Uint8Array(0))).toBe('')
  })

  test('handles larger data', () => {
    const bytes = new Uint8Array(10000)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256
    const b64 = uint8ArrayToBase64(bytes)
    const decoded = base64ToUint8Array(b64)
    expect(decoded).toEqual(bytes)
  })
})

describe('base64ToUint8Array', () => {
  test('round-trips with uint8ArrayToBase64', () => {
    const original = new Uint8Array([0, 127, 255, 1, 128])
    const b64 = uint8ArrayToBase64(original)
    expect(base64ToUint8Array(b64)).toEqual(original)
  })

  test('empty string returns empty array', () => {
    expect(base64ToUint8Array('')).toEqual(new Uint8Array(0))
  })
})
