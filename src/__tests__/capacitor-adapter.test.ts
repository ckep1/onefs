import 'fake-indexeddb/auto'
import { describe, test, expect, vi } from 'vitest'
import { CapacitorAdapter } from '../adapters/capacitor'
import type { OneFSDirectory, OneFSEntry, OneFSFile } from '../types'

function makeFile(overrides: Partial<OneFSFile> = {}): OneFSFile {
  const content = overrides.content ?? new Uint8Array([1, 2, 3])
  return {
    id: overrides.id ?? 'file-id',
    name: overrides.name ?? 'track.mp3',
    path: overrides.path ?? 'track.mp3',
    content,
    mimeType: overrides.mimeType ?? 'audio/mpeg',
    size: overrides.size ?? content.byteLength,
    lastModified: overrides.lastModified ?? Date.now(),
  }
}

describe('CapacitorAdapter security and root-path behavior', () => {
  test('readFileFromDirectory allows root-level files when directory path is empty', async () => {
    const adapter = new CapacitorAdapter('cap-root-read-' + Math.random().toString(36).slice(2))
    const readFile = vi.fn().mockResolvedValue({ data: btoa('abc') })

    ;(adapter as any).loadFilesystem = vi.fn().mockResolvedValue({
      Filesystem: { readFile },
      Directory: { Documents: 'DOCUMENTS' },
    })
    ;(adapter as any).loadCore = vi.fn().mockResolvedValue({
      Capacitor: { convertFileSrc: vi.fn() },
    })

    const directory: OneFSDirectory = {
      id: 'dir-id',
      name: 'Documents',
      path: '',
    }
    const entry: OneFSEntry = {
      name: 'song.mp3',
      kind: 'file',
      path: 'song.mp3',
    }

    const result = await adapter.readFileFromDirectory(directory, entry)
    expect(result.ok).toBe(true)
    expect(readFile).toHaveBeenCalledWith({
      path: 'song.mp3',
      directory: 'DOCUMENTS',
    })
  })

  test('saveFile rejects files not opened by this adapter', async () => {
    const adapter = new CapacitorAdapter('cap-save-auth-' + Math.random().toString(36).slice(2))
    const writeFile = vi.fn().mockResolvedValue(undefined)

    ;(adapter as any).loadFilesystem = vi.fn().mockResolvedValue({
      Filesystem: { writeFile },
      Directory: { Documents: 'DOCUMENTS' },
    })
    ;(adapter as any).storage.getStoredFile = vi.fn().mockResolvedValue(null)

    const result = await adapter.saveFile(makeFile({ id: 'unknown', path: 'unknown.mp3' }), new Uint8Array([9]))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('permission_denied')
    }
    expect(writeFile).not.toHaveBeenCalled()
  })

  test('restoreFile ignores caller path and reads from stored record', async () => {
    const adapter = new CapacitorAdapter('cap-restore-path-' + Math.random().toString(36).slice(2))
    const readFile = vi.fn().mockResolvedValue({ data: btoa('abc') })
    const stat = vi.fn().mockResolvedValue({ mtime: 1234 })

    ;(adapter as any).loadFilesystem = vi.fn().mockResolvedValue({
      Filesystem: { readFile, stat },
      Directory: { Documents: 'DOCUMENTS' },
    })
    ;(adapter as any).storage.getStoredFile = vi.fn().mockResolvedValue({
      id: 'known-id',
      name: 'trusted.mp3',
      path: 'trusted.mp3',
      content: new Uint8Array([1, 2, 3]),
      mimeType: 'audio/mpeg',
      size: 3,
      lastModified: 1,
      storedAt: 1,
    })

    const result = await adapter.restoreFile({
      id: 'known-id',
      name: 'forged.mp3',
      path: 'forged.mp3',
      type: 'file',
      storedAt: 1,
    })

    expect(result.ok).toBe(true)
    expect(readFile).toHaveBeenCalledWith({
      path: 'trusted.mp3',
      directory: 'DOCUMENTS',
    })
  })

  test('deleteFile rejects files not opened by this adapter', async () => {
    const adapter = new CapacitorAdapter('cap-delete-auth-' + Math.random().toString(36).slice(2))
    const deleteFile = vi.fn().mockResolvedValue(undefined)

    ;(adapter as any).loadFilesystem = vi.fn().mockResolvedValue({
      Filesystem: { deleteFile },
      Directory: { Documents: 'DOCUMENTS' },
    })
    ;(adapter as any).storage.getStoredFile = vi.fn().mockResolvedValue(null)

    const result = await adapter.deleteFile(makeFile({ id: 'unknown', path: 'unknown.mp3' }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('permission_denied')
    }
    expect(deleteFile).not.toHaveBeenCalled()
  })

  test('renameFile rejects files not opened by this adapter', async () => {
    const adapter = new CapacitorAdapter('cap-rename-auth-' + Math.random().toString(36).slice(2))
    const rename = vi.fn().mockResolvedValue(undefined)

    ;(adapter as any).loadFilesystem = vi.fn().mockResolvedValue({
      Filesystem: { rename },
      Directory: { Documents: 'DOCUMENTS' },
    })
    ;(adapter as any).storage.getStoredFile = vi.fn().mockResolvedValue(null)

    const result = await adapter.renameFile(makeFile({ id: 'unknown', path: 'unknown.mp3' }), 'new-name.mp3')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('permission_denied')
    }
    expect(rename).not.toHaveBeenCalled()
  })

  test('deleteFile succeeds for files tracked in active session', async () => {
    const adapter = new CapacitorAdapter('cap-delete-session-' + Math.random().toString(36).slice(2))
    const deleteFile = vi.fn().mockResolvedValue(undefined)
    const removeFile = vi.fn().mockResolvedValue(undefined)

    ;(adapter as any).loadFilesystem = vi.fn().mockResolvedValue({
      Filesystem: { deleteFile },
      Directory: { Documents: 'DOCUMENTS' },
    })
    ;(adapter as any).storage.getStoredFile = vi.fn().mockResolvedValue(null)
    ;(adapter as any).storage.removeFile = removeFile
    ;(adapter as any).sessionPaths.set('known-id', 'known.mp3')

    const result = await adapter.deleteFile(makeFile({ id: 'known-id', path: 'known.mp3' }))
    expect(result.ok).toBe(true)
    expect(deleteFile).toHaveBeenCalledWith({
      path: 'known.mp3',
      directory: 'DOCUMENTS',
    })
    expect(removeFile).toHaveBeenCalledWith('known-id')
  })
})
