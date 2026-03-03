import 'fake-indexeddb/auto'
import { describe, test, expect, beforeEach } from 'vitest'
import { IDBStorage } from '../storage/idb'
import type { StoredFile } from '../types'

function makeStoredFile(id: string, size = 100): StoredFile {
  return {
    id,
    name: `${id}.txt`,
    content: new Uint8Array(size).fill(42),
    mimeType: 'text/plain',
    size,
    lastModified: Date.now(),
    storedAt: Date.now(),
  }
}

describe('IDBStorage constructor', () => {
  test('valid appName accepted', () => {
    expect(() => new IDBStorage('my-app')).not.toThrow()
    expect(() => new IDBStorage('app_v2.1')).not.toThrow()
  })

  test('empty appName throws', () => {
    expect(() => new IDBStorage('')).toThrow(/Invalid appName/)
  })

  test('special character appName throws', () => {
    expect(() => new IDBStorage('my app')).toThrow(/Invalid appName/)
    expect(() => new IDBStorage('app@home')).toThrow(/Invalid appName/)
    expect(() => new IDBStorage('app/name')).toThrow(/Invalid appName/)
  })
})

describe('IDBStorage file operations', () => {
  let storage: IDBStorage

  beforeEach(() => {
    storage = new IDBStorage('test-app-' + Math.random().toString(36).slice(2))
  })

  test('storeFile and getStoredFile round-trip', async () => {
    const file = makeStoredFile('file-1')
    await storage.storeFile(file)
    const retrieved = await storage.getStoredFile('file-1')
    expect(retrieved).not.toBeNull()
    expect(retrieved!.id).toBe('file-1')
    expect(retrieved!.name).toBe('file-1.txt')
    expect(new Uint8Array(retrieved!.content)).toEqual(file.content)
  })

  test('content preserved correctly', async () => {
    const content = new Uint8Array([0, 1, 127, 128, 255])
    const file: StoredFile = {
      id: 'binary',
      name: 'binary.bin',
      content,
      mimeType: 'application/octet-stream',
      size: content.length,
      lastModified: Date.now(),
      storedAt: Date.now(),
    }
    await storage.storeFile(file)
    const retrieved = await storage.getStoredFile('binary')
    expect(new Uint8Array(retrieved!.content)).toEqual(content)
  })

  test('file exceeding maxCacheSize is silently skipped', async () => {
    const small = new IDBStorage(
      'test-small-' + Math.random().toString(36).slice(2),
      10,
      50
    )
    const bigFile = makeStoredFile('big', 100)
    await small.storeFile(bigFile)
    const retrieved = await small.getStoredFile('big')
    expect(retrieved).toBeNull()
  })

  test('non-existent file returns null', async () => {
    const result = await storage.getStoredFile('does-not-exist')
    expect(result).toBeNull()
  })

  test('removeFile works', async () => {
    await storage.storeFile(makeStoredFile('rm-me'))
    await storage.removeFile('rm-me')
    expect(await storage.getStoredFile('rm-me')).toBeNull()
  })

  test('getStoredFiles returns files sorted by most recent', async () => {
    const f1 = makeStoredFile('a')
    f1.storedAt = 1000
    const f2 = makeStoredFile('b')
    f2.storedAt = 3000
    const f3 = makeStoredFile('c')
    f3.storedAt = 2000

    await storage.storeFile(f1)
    await storage.storeFile(f2)
    await storage.storeFile(f3)

    const all = await storage.getStoredFiles()
    expect(all.map((f) => f.id)).toEqual(['b', 'c', 'a'])
  })

  test('clearFiles removes all files', async () => {
    await storage.storeFile(makeStoredFile('x'))
    await storage.storeFile(makeStoredFile('y'))
    await storage.clearFiles()
    const all = await storage.getStoredFiles()
    expect(all).toHaveLength(0)
  })

  test('pruning removes oldest files beyond maxRecentFiles', async () => {
    const small = new IDBStorage(
      'test-prune-' + Math.random().toString(36).slice(2),
      3,
      50 * 1024 * 1024
    )
    for (let i = 0; i < 5; i++) {
      const f = makeStoredFile(`f${i}`)
      f.storedAt = i * 1000
      await small.storeFile(f)
    }

    await new Promise((r) => setTimeout(r, 100))

    const all = await small.getStoredFiles()
    expect(all.length).toBeLessThanOrEqual(3)
  })
})

describe('IDBStorage handle operations', () => {
  let storage: IDBStorage

  beforeEach(() => {
    storage = new IDBStorage('test-handles-' + Math.random().toString(36).slice(2))
  })

  test('removeHandle on non-existent id does not throw', async () => {
    await expect(storage.removeHandle('ghost')).resolves.not.toThrow()
  })

  test('clearHandles removes all handles', async () => {
    await storage.clearHandles()
    const handles = await storage.getStoredHandles()
    expect(handles).toHaveLength(0)
  })
})

describe('IDBStorage dispose', () => {
  test('after dispose, getDB reopens the database', async () => {
    const storage = new IDBStorage('test-dispose-' + Math.random().toString(36).slice(2))
    await storage.storeFile(makeStoredFile('before'))
    storage.dispose()
    const retrieved = await storage.getStoredFile('before')
    expect(retrieved).not.toBeNull()
  })
})
