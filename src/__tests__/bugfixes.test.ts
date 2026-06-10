import 'fake-indexeddb/auto'
import { describe, test, expect, vi } from 'vitest'
import { IDBStorage } from '../storage/idb'
import { TauriAdapter } from '../adapters/tauri'
import { CapacitorAdapter } from '../adapters/capacitor'
import { FSAccessAdapter } from '../adapters/fs-access'
import { ok, err } from '../types'
import type { OneFSFile, StoredFile } from '../types'

const rand = () => Math.random().toString(36).slice(2)

function makeStoredFile(id: string, overrides: Partial<StoredFile> = {}): StoredFile {
  return {
    id,
    name: `${id}.mp3`,
    content: new Uint8Array([1, 2, 3]),
    mimeType: 'audio/mpeg',
    size: 3,
    lastModified: Date.now(),
    storedAt: Date.now(),
    ...overrides,
  }
}

function makeFile(overrides: Partial<OneFSFile> = {}): OneFSFile {
  const content = overrides.content ?? new Uint8Array([1, 2, 3])
  return {
    id: 'file-id',
    name: 'track.mp3',
    path: 'track.mp3',
    content,
    mimeType: 'audio/mpeg',
    size: content.byteLength,
    lastModified: Date.now(),
    ...overrides,
  }
}

describe('IDBStorage oversize and metadata handling', () => {
  test('oversize file with a path keeps its metadata record (content emptied)', async () => {
    const storage = new IDBStorage('bug-oversize-' + rand(), 10, 16)
    await storage.storeFile(makeStoredFile('big', { path: 'big.bin', content: new Uint8Array(32), size: 32 }))

    const stored = await storage.getStoredFile('big')
    expect(stored).not.toBeNull()
    expect(stored!.path).toBe('big.bin')
    expect(stored!.content.byteLength).toBe(0)
  })

  test('oversize file without a path is still skipped entirely', async () => {
    const storage = new IDBStorage('bug-oversize-nopath-' + rand(), 10, 16)
    await storage.storeFile(makeStoredFile('big', { content: new Uint8Array(32), size: 32 }))
    expect(await storage.getStoredFile('big')).toBeNull()
  })

  test('updateFileMetadata changes name/path but preserves cached content', async () => {
    const storage = new IDBStorage('bug-update-meta-' + rand())
    await storage.storeFile(makeStoredFile('f1', { path: 'old.mp3', content: new Uint8Array([9, 8, 7]) }))

    const updated = await storage.updateFileMetadata('f1', { name: 'new.mp3', path: 'new.mp3' })
    expect(updated).toBe(true)

    const stored = await storage.getStoredFile('f1')
    expect(stored!.name).toBe('new.mp3')
    expect(stored!.path).toBe('new.mp3')
    expect(Array.from(new Uint8Array(stored!.content))).toEqual([9, 8, 7])
  })

  test('updateFileMetadata is a no-op for missing records', async () => {
    const storage = new IDBStorage('bug-update-missing-' + rand())
    expect(await storage.updateFileMetadata('ghost', { name: 'x' })).toBe(false)
    expect(await storage.getStoredFile('ghost')).toBeNull()
  })

  test('pruning invokes onFilesPruned with the evicted records', async () => {
    const storage = new IDBStorage('bug-prune-cb-' + rand(), 1)
    const pruned = new Promise<StoredFile[]>((resolve) => {
      storage.onFilesPruned = resolve
    })

    for (let i = 0; i < 7; i++) {
      await storage.storeFile(makeStoredFile(`f${i}`, { path: `f${i}.mp3`, storedAt: i * 1000 }))
    }

    const removed = await pruned
    expect(removed.length).toBeGreaterThan(0)
    expect(removed.every((f) => f.id !== 'f6')).toBe(true)
  })
})

describe('TauriAdapter restore and rename', () => {
  test('restoreFile rejects directory records instead of returning an empty file', async () => {
    const adapter = new TauriAdapter('bug-restore-dir-' + rand())
    ;(adapter as any).storage.getStoredFile = vi.fn().mockResolvedValue(
      makeStoredFile('dir-id', { name: 'Music', path: '/Music', content: new Uint8Array(0), mimeType: 'inode/directory', size: 0 })
    )

    const result = await adapter.restoreFile({ id: 'dir-id', name: 'Music', type: 'directory', storedAt: 1 })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('not_found')
    }
  })

  test('renameFile updates metadata without rewriting cached content', async () => {
    const adapter = new TauriAdapter('bug-rename-meta-' + rand())
    const rename = vi.fn().mockResolvedValue(undefined)
    const updateFileMetadata = vi.fn().mockResolvedValue(true)
    const storeFile = vi.fn().mockResolvedValue(undefined)
    const file = makeFile({ id: 'known-id', path: '/Music/old.mp3', content: new Uint8Array([5, 5, 5]) })

    ;(adapter as any).loadModules = vi.fn().mockResolvedValue({ fs: { rename }, dialog: {}, core: {} })
    ;(adapter as any).storage.getStoredFile = vi.fn().mockResolvedValue({ path: file.path })
    ;(adapter as any).storage.updateFileMetadata = updateFileMetadata
    ;(adapter as any).storage.storeFile = storeFile

    const result = await adapter.renameFile(file, 'renamed.mp3')

    expect(result.ok).toBe(true)
    expect(updateFileMetadata).toHaveBeenCalledWith('known-id', expect.objectContaining({
      name: 'renamed.mp3',
      path: '/Music/renamed.mp3',
    }))
    expect(storeFile).not.toHaveBeenCalled()
  })
})

describe('CapacitorAdapter authorization order', () => {
  test('session path is honored even when the stored record has a stale path', async () => {
    const adapter = new CapacitorAdapter('bug-session-first-' + rand())
    const writeFile = vi.fn().mockResolvedValue(undefined)

    ;(adapter as any).loadFilesystem = vi.fn().mockResolvedValue({
      Filesystem: { writeFile },
      Directory: { Documents: 'DOCUMENTS' },
    })
    ;(adapter as any).storage.getStoredFile = vi.fn().mockResolvedValue({ path: 'stale-old.mp3' })
    ;(adapter as any).sessionPaths.set('known-id', 'renamed-new.mp3')

    const result = await adapter.saveFile(
      makeFile({ id: 'known-id', path: 'renamed-new.mp3' }),
      new Uint8Array([1]),
      { persist: false }
    )

    expect(result.ok).toBe(true)
    expect(writeFile).toHaveBeenCalledWith(expect.objectContaining({ path: 'renamed-new.mp3' }))
  })
})

describe('CapacitorAdapter picker fallback behavior', () => {
  test('cancelling the native picker does not fall back to the HTML input', async () => {
    const adapter = new CapacitorAdapter('bug-cancel-' + rand())
    ;(adapter as any).pickFilesWithPlugin = vi.fn().mockResolvedValue(err('cancelled', 'User cancelled file picker'))
    const inputPicker = vi.fn()
    ;(adapter as any).pickFilesWithInput = inputPicker

    const result = await adapter.openFile()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('cancelled')
    }
    expect(inputPicker).not.toHaveBeenCalled()
  })

  test('missing plugin still falls back to the HTML input', async () => {
    const adapter = new CapacitorAdapter('bug-fallback-' + rand())
    ;(adapter as any).pickFilesWithPlugin = vi.fn().mockResolvedValue(null)
    const inputPicker = vi.fn().mockResolvedValue(ok([makeFile()]))
    ;(adapter as any).pickFilesWithInput = inputPicker

    const result = await adapter.openFile()
    expect(result.ok).toBe(true)
    expect(inputPicker).toHaveBeenCalled()
  })
})

describe('CapacitorAdapter pruned-copy cleanup', () => {
  test('removePrunedCopies deletes file copies and skips directories and unsafe paths', async () => {
    const adapter = new CapacitorAdapter('bug-prune-copies-' + rand())
    const deleteFile = vi.fn().mockResolvedValue(undefined)

    ;(adapter as any).loadFilesystem = vi.fn().mockResolvedValue({
      Filesystem: { deleteFile },
      Directory: { Documents: 'DOCUMENTS' },
    })

    await (adapter as any).removePrunedCopies([
      makeStoredFile('a', { path: 'uuid_a.mp3' }),
      makeStoredFile('d', { path: '', mimeType: 'inode/directory' }),
      makeStoredFile('x', { path: '../escape.mp3' }),
      makeStoredFile('n', { path: undefined }),
    ])

    expect(deleteFile).toHaveBeenCalledTimes(1)
    expect(deleteFile).toHaveBeenCalledWith({ path: 'uuid_a.mp3', directory: 'DOCUMENTS' })
  })
})

describe('FSAccessAdapter rename validation', () => {
  function makeHandle(name: string) {
    return {
      kind: 'file' as const,
      name,
      queryPermission: vi.fn().mockResolvedValue('granted'),
      requestPermission: vi.fn().mockResolvedValue('granted'),
      move: vi.fn().mockResolvedValue(undefined),
    }
  }

  test('rejects unsafe names instead of silently mangling them', async () => {
    const adapter = new FSAccessAdapter('bug-fsa-rename-' + rand())
    const handle = makeHandle('old.txt')
    const file = makeFile({ path: undefined, handle: handle as any })

    for (const bad of ['../escape.txt', 'a/b.txt', '..', '']) {
      const result = await adapter.renameFile(file, bad)
      expect(result.ok).toBe(false)
    }
    expect(handle.move).not.toHaveBeenCalled()
  })

  test('passes repeated-dot names through verbatim', async () => {
    const adapter = new FSAccessAdapter('bug-fsa-rename-dots-' + rand())
    const handle = makeHandle('old.txt')
    const file = makeFile({ path: undefined, handle: handle as any })

    const result = await adapter.renameFile(file, '...thinking.txt')
    expect(result.ok).toBe(true)
    expect(handle.move).toHaveBeenCalledWith('...thinking.txt')
    if (result.ok) {
      expect(result.data.name).toBe('...thinking.txt')
    }
  })
})
