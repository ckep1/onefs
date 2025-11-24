import type {
  FSBridgeAdapter,
  FSBridgeFile,
  FSBridgeOpenOptions,
  FSBridgeSaveOptions,
  FSBridgeDirectory,
  FSBridgeDirectoryOptions,
  StoredHandle,
  FSBridgeResult,
} from '../types'
import { ok, err } from '../types'
import { IDBStorage } from '../storage/idb'
import { generateId, getMimeType } from '../utils'

function buildAcceptTypes(accept?: string[]): FilePickerAcceptType[] {
  if (!accept || accept.length === 0) return []

  const extensions = accept.filter((a) => a.startsWith('.'))
  if (extensions.length === 0) return []

  return [
    {
      description: 'Accepted files',
      accept: {
        '*/*': extensions,
      },
    },
  ]
}

export class FSAccessAdapter implements FSBridgeAdapter {
  platform = 'web-fs-access' as const
  private storage: IDBStorage
  private persistByDefault: boolean

  constructor(appName: string, maxRecentFiles = 10, persistByDefault = true) {
    this.storage = new IDBStorage(appName, maxRecentFiles)
    this.persistByDefault = persistByDefault
  }

  isSupported(): boolean {
    return 'showOpenFilePicker' in window
  }

  async openFile(options: FSBridgeOpenOptions = {}): Promise<FSBridgeResult<FSBridgeFile | FSBridgeFile[]>> {
    const shouldPersist = options.persist ?? this.persistByDefault

    try {
      const handles = await window.showOpenFilePicker({
        multiple: options.multiple ?? false,
        types: buildAcceptTypes(options.accept),
        startIn: options.startIn,
      })

      const files: FSBridgeFile[] = []

      for (const handle of handles) {
        const file = await handle.getFile()
        const content = new Uint8Array(await file.arrayBuffer())
        const id = generateId()

        if (shouldPersist) {
          await this.storage.storeHandle(handle, id)
        }

        files.push({
          id,
          name: handle.name,
          content,
          mimeType: file.type || getMimeType(handle.name),
          lastModified: file.lastModified,
          handle,
        })
      }

      return ok(options.multiple ? files : files[0])
    } catch (e) {
      const error = e as Error
      if (error.name === 'AbortError') {
        return err('cancelled', 'User cancelled file picker')
      }
      if (error.name === 'SecurityError') {
        return err('permission_denied', 'Permission denied to access file', e)
      }
      return err('io_error', error.message || 'Failed to open file', e)
    }
  }

  async saveFile(
    file: FSBridgeFile,
    content: Uint8Array | string,
    _options?: FSBridgeSaveOptions
  ): Promise<FSBridgeResult<boolean>> {
    if (!file.handle) {
      return err('not_supported', 'Cannot save file without handle - use saveFileAs instead')
    }

    try {
      const permission = await file.handle.queryPermission({ mode: 'readwrite' })
      if (permission !== 'granted') {
        const requested = await file.handle.requestPermission({ mode: 'readwrite' })
        if (requested !== 'granted') {
          return err('permission_denied', 'Write permission denied')
        }
      }

      const writable = await file.handle.createWritable()
      const data = typeof content === 'string' ? content : new Blob([content.buffer as ArrayBuffer])
      await writable.write(data)
      await writable.close()

      return ok(true)
    } catch (e) {
      const error = e as Error
      if (error.name === 'AbortError') {
        return err('cancelled', 'User cancelled save operation')
      }
      if (error.name === 'SecurityError' || error.name === 'NotAllowedError') {
        return err('permission_denied', 'Permission denied to save file', e)
      }
      return err('io_error', error.message || 'Failed to save file', e)
    }
  }

  async saveFileAs(content: Uint8Array | string, options: FSBridgeSaveOptions = {}): Promise<FSBridgeResult<FSBridgeFile>> {
    const shouldPersist = options.persist ?? this.persistByDefault

    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: options.suggestedName,
        types: buildAcceptTypes(options.accept),
        startIn: options.startIn,
      })

      const writable = await handle.createWritable()
      const data = typeof content === 'string' ? content : new Blob([content.buffer as ArrayBuffer])
      await writable.write(data)
      await writable.close()

      const id = generateId()
      if (shouldPersist) {
        await this.storage.storeHandle(handle, id)
      }

      const contentArray = typeof content === 'string' ? new TextEncoder().encode(content) : content

      return ok({
        id,
        name: handle.name,
        content: contentArray,
        mimeType: getMimeType(handle.name),
        lastModified: Date.now(),
        handle,
      })
    } catch (e) {
      const error = e as Error
      if (error.name === 'AbortError') {
        return err('cancelled', 'User cancelled save dialog')
      }
      if (error.name === 'SecurityError' || error.name === 'NotAllowedError') {
        return err('permission_denied', 'Permission denied to save file', e)
      }
      return err('io_error', error.message || 'Failed to save file', e)
    }
  }

  async openDirectory(options: FSBridgeDirectoryOptions = {}): Promise<FSBridgeResult<FSBridgeDirectory>> {
    try {
      const handle = await window.showDirectoryPicker({
        startIn: options.startIn,
        mode: options.mode ?? 'read',
      })

      const id = generateId()
      await this.storage.storeHandle(handle, id)

      return ok({
        id,
        name: handle.name,
        handle,
      })
    } catch (e) {
      const error = e as Error
      if (error.name === 'AbortError') {
        return err('cancelled', 'User cancelled directory picker')
      }
      if (error.name === 'SecurityError' || error.name === 'NotAllowedError') {
        return err('permission_denied', 'Permission denied to access directory', e)
      }
      return err('io_error', error.message || 'Failed to open directory', e)
    }
  }

  async readDirectory(directory: FSBridgeDirectory): Promise<FSBridgeResult<FSBridgeFile[]>> {
    if (!directory.handle) {
      return err('not_supported', 'Cannot read directory without handle')
    }

    try {
      const files: FSBridgeFile[] = []

      for await (const entry of directory.handle.values()) {
        if (entry.kind === 'file') {
          const file = await entry.getFile()
          const content = new Uint8Array(await file.arrayBuffer())

          files.push({
            id: generateId(),
            name: entry.name,
            content,
            mimeType: file.type || getMimeType(entry.name),
            lastModified: file.lastModified,
            handle: entry,
          })
        }
      }

      return ok(files)
    } catch (e) {
      const error = e as Error
      if (error.name === 'SecurityError' || error.name === 'NotAllowedError') {
        return err('permission_denied', 'Permission denied to read directory', e)
      }
      return err('io_error', error.message || 'Failed to read directory', e)
    }
  }

  async getRecentFiles(): Promise<StoredHandle[]> {
    return this.storage.getStoredHandles()
  }

  async restoreFile(stored: StoredHandle): Promise<FSBridgeResult<FSBridgeFile>> {
    const handle = await this.storage.getHandleObject(stored.id)
    if (!handle || handle.kind !== 'file') {
      return err('not_found', 'File handle not found in storage')
    }

    const fileHandle = handle as FileSystemFileHandle

    try {
      const permission = await fileHandle.queryPermission({ mode: 'read' })
      if (permission !== 'granted') {
        const requested = await fileHandle.requestPermission({ mode: 'read' })
        if (requested !== 'granted') {
          return err('permission_denied', 'Read permission denied')
        }
      }

      const file = await fileHandle.getFile()
      const content = new Uint8Array(await file.arrayBuffer())

      return ok({
        id: stored.id,
        name: fileHandle.name,
        content,
        mimeType: file.type || getMimeType(fileHandle.name),
        lastModified: file.lastModified,
        handle: fileHandle,
      })
    } catch (e) {
      const error = e as Error
      if (error.name === 'NotFoundError') {
        return err('not_found', 'File no longer exists at original location', e)
      }
      if (error.name === 'SecurityError' || error.name === 'NotAllowedError') {
        return err('permission_denied', 'Permission denied to restore file', e)
      }
      return err('io_error', error.message || 'Failed to restore file', e)
    }
  }

  async removeFromRecent(id: string): Promise<void> {
    await this.storage.removeHandle(id)
  }

  async clearRecent(): Promise<void> {
    await this.storage.clearHandles()
  }
}
