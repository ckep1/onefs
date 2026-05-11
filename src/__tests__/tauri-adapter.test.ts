import 'fake-indexeddb/auto'
import { describe, test, expect, vi } from 'vitest'
import { TauriAdapter } from '../adapters/tauri'
import type { OneFSDirectory, OneFSFile } from '../types'

function makeFile(overrides: Partial<OneFSFile> = {}): OneFSFile {
  const content = overrides.content ?? new Uint8Array([1, 2, 3])
  return {
    id: overrides.id ?? 'file-id',
    name: overrides.name ?? 'track.mp3',
    path: overrides.path ?? '/tmp/track.mp3',
    content,
    mimeType: overrides.mimeType ?? 'audio/mpeg',
    size: overrides.size ?? content.byteLength,
    lastModified: overrides.lastModified ?? Date.now(),
  }
}

function makeAdapter(testName: string): TauriAdapter {
  return new TauriAdapter(`tauri-${testName}-${Math.random().toString(36).slice(2)}`)
}

describe('TauriAdapter path safety and separator handling', () => {
  test('scanDirectory preserves real filenames containing repeated dots', async () => {
    const adapter = makeAdapter('scan-dots')
    const readDir = vi.fn().mockResolvedValue([
      { name: 'Artist - Wait... What.mp3', isFile: true, isDirectory: false },
    ])

    ;(adapter as any).loadModules = vi.fn().mockResolvedValue({
      fs: { readDir },
      dialog: {},
      core: {},
    })

    const directory: OneFSDirectory = { id: 'dir-id', name: 'Music', path: '/Music' }
    const result = await adapter.scanDirectory(directory, { extensions: ['.mp3'], skipStats: true })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data[0]).toMatchObject({
        name: 'Artist - Wait... What.mp3',
        path: '/Music/Artist - Wait... What.mp3',
      })
    }
  })

  test('readDirectory keeps backslash separator for Windows paths', async () => {
    const adapter = makeAdapter('read-directory')
    const readDir = vi.fn().mockResolvedValue([
      { name: 'song.mp3', isFile: true, isDirectory: false },
    ])

    ;(adapter as any).loadModules = vi.fn().mockResolvedValue({
      fs: { readDir },
      dialog: {},
      core: {},
    })

    const directory: OneFSDirectory = { id: 'dir-id', name: 'Music', path: 'C:\\Music' }
    const result = await adapter.readDirectory(directory, { skipStats: true })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data[0].path).toBe('C:\\Music\\song.mp3')
    }
  })

  test('scanDirectory keeps backslash separator for nested Windows paths', async () => {
    const adapter = makeAdapter('scan-directory')
    const readDir = vi
      .fn()
      .mockImplementation(async (path: string) => {
        if (path === 'C:\\Music') {
          return [{ name: 'Albums', isFile: false, isDirectory: true }]
        }
        if (path === 'C:\\Music\\Albums') {
          return [{ name: 'track.mp3', isFile: true, isDirectory: false }]
        }
        return []
      })

    ;(adapter as any).loadModules = vi.fn().mockResolvedValue({
      fs: { readDir },
      dialog: {},
      core: {},
    })

    const directory: OneFSDirectory = { id: 'dir-id', name: 'Music', path: 'C:\\Music' }
    const result = await adapter.scanDirectory(directory, { skipStats: true })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).toEqual([
        {
          name: 'track.mp3',
          kind: 'file',
          path: 'C:\\Music\\Albums\\track.mp3',
        },
      ])
    }
  })

  test('renameFile preserves Windows separator and parent directory', async () => {
    const adapter = makeAdapter('rename-windows')
    const rename = vi.fn().mockResolvedValue(undefined)
    const storeFile = vi.fn().mockResolvedValue(undefined)
    const file = makeFile({
      id: 'known-id',
      name: 'track.mp3',
      path: 'C:\\Users\\chris\\track.mp3',
    })

    ;(adapter as any).loadModules = vi.fn().mockResolvedValue({
      fs: { rename },
      dialog: {},
      core: {},
    })
    ;(adapter as any).storage.getStoredFile = vi.fn().mockResolvedValue({ path: file.path })
    ;(adapter as any).storage.storeFile = storeFile

    const result = await adapter.renameFile(file, 'renamed.mp3')

    expect(result.ok).toBe(true)
    expect(rename).toHaveBeenCalledWith('C:\\Users\\chris\\track.mp3', 'C:\\Users\\chris\\renamed.mp3')
    if (result.ok) {
      expect(result.data.path).toBe('C:\\Users\\chris\\renamed.mp3')
    }
  })

  test('renameFile preserves repeated-dot filenames verbatim (no sanitization)', async () => {
    const adapter = makeAdapter('rename-dots')
    const rename = vi.fn().mockResolvedValue(undefined)
    const file = makeFile({ id: 'known-id', path: '/Music/old.mp3' })

    ;(adapter as any).loadModules = vi.fn().mockResolvedValue({
      fs: { rename },
      dialog: {},
      core: {},
    })
    ;(adapter as any).storage.getStoredFile = vi.fn().mockResolvedValue({ path: file.path })
    ;(adapter as any).storage.storeFile = vi.fn().mockResolvedValue(undefined)

    const result = await adapter.renameFile(file, '...thinking.txt')

    expect(result.ok).toBe(true)
    expect(rename).toHaveBeenCalledWith('/Music/old.mp3', '/Music/...thinking.txt')
    if (result.ok) {
      expect(result.data.name).toBe('...thinking.txt')
      expect(result.data.path).toBe('/Music/...thinking.txt')
    }
  })

  test('renameFile rejects names containing separators', async () => {
    const adapter = makeAdapter('rename-unsafe')
    const rename = vi.fn().mockResolvedValue(undefined)
    const file = makeFile({ id: 'known-id', path: '/Music/old.mp3' })

    ;(adapter as any).loadModules = vi.fn().mockResolvedValue({
      fs: { rename },
      dialog: {},
      core: {},
    })
    ;(adapter as any).storage.getStoredFile = vi.fn().mockResolvedValue({ path: file.path })

    const result = await adapter.renameFile(file, '../escape.txt')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('io_error')
    }
    expect(rename).not.toHaveBeenCalled()
  })

  test('renameFile picks dominant separator from parent for mixed-separator paths', async () => {
    const adapter = makeAdapter('rename-mixed-sep')
    const rename = vi.fn().mockResolvedValue(undefined)
    const file = makeFile({
      id: 'known-id',
      path: 'C:\\Users\\chris\\Music/track.mp3',
    })

    ;(adapter as any).loadModules = vi.fn().mockResolvedValue({
      fs: { rename },
      dialog: {},
      core: {},
    })
    ;(adapter as any).storage.getStoredFile = vi.fn().mockResolvedValue({ path: file.path })
    ;(adapter as any).storage.storeFile = vi.fn().mockResolvedValue(undefined)

    const result = await adapter.renameFile(file, 'renamed.mp3')

    expect(result.ok).toBe(true)
    expect(rename).toHaveBeenCalledWith(
      'C:\\Users\\chris\\Music/track.mp3',
      'C:\\Users\\chris\\Music\\renamed.mp3'
    )
  })

  test('deleteFile rejects files not opened through this adapter', async () => {
    const adapter = makeAdapter('delete-auth')
    const remove = vi.fn().mockResolvedValue(undefined)

    ;(adapter as any).loadModules = vi.fn().mockResolvedValue({
      fs: { remove },
      dialog: {},
      core: {},
    })
    ;(adapter as any).storage.getStoredFile = vi.fn().mockResolvedValue(null)

    const result = await adapter.deleteFile(makeFile({ id: 'unknown', path: '/tmp/unknown.mp3' }))

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('permission_denied')
    }
    expect(remove).not.toHaveBeenCalled()
  })

  test('saveFile rejects files not opened through this adapter', async () => {
    const adapter = makeAdapter('save-auth')
    const writeFile = vi.fn().mockResolvedValue(undefined)

    ;(adapter as any).loadModules = vi.fn().mockResolvedValue({
      fs: { writeFile },
      dialog: {},
      core: {},
    })
    ;(adapter as any).storage.getStoredFile = vi.fn().mockResolvedValue(null)

    const result = await adapter.saveFile(makeFile({ id: 'unknown', path: '/tmp/unknown.mp3' }), new Uint8Array([9]))

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('permission_denied')
    }
    expect(writeFile).not.toHaveBeenCalled()
  })

  test('saveFile allows files tracked in active session', async () => {
    const adapter = makeAdapter('save-session')
    const writeFile = vi.fn().mockResolvedValue(undefined)

    ;(adapter as any).loadModules = vi.fn().mockResolvedValue({
      fs: { writeFile },
      dialog: {},
      core: {},
    })
    ;(adapter as any).storage.getStoredFile = vi.fn().mockResolvedValue(null)
    ;(adapter as any).sessionPaths.set('known-id', '/tmp/known.mp3')

    const result = await adapter.saveFile(makeFile({ id: 'known-id', path: '/tmp/known.mp3' }), new Uint8Array([7]), { persist: false })

    expect(result.ok).toBe(true)
    expect(writeFile).toHaveBeenCalledWith('/tmp/known.mp3', new Uint8Array([7]))
  })

  test('renameFile rejects files not opened through this adapter', async () => {
    const adapter = makeAdapter('rename-auth')
    const rename = vi.fn().mockResolvedValue(undefined)

    ;(adapter as any).loadModules = vi.fn().mockResolvedValue({
      fs: { rename },
      dialog: {},
      core: {},
    })
    ;(adapter as any).storage.getStoredFile = vi.fn().mockResolvedValue(null)

    const result = await adapter.renameFile(makeFile({ id: 'unknown', path: '/tmp/unknown.mp3' }), 'new.mp3')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('permission_denied')
    }
    expect(rename).not.toHaveBeenCalled()
  })
})
