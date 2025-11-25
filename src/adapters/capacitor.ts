import type {
  FSBridgeAdapter,
  FSBridgeFile,
  FSBridgeOpenOptions,
  FSBridgeSaveOptions,
  FSBridgeDirectory,
  FSBridgeDirectoryOptions,
  FSBridgeEntry,
  StoredHandle,
  StoredFile,
  FSBridgeResult,
} from '../types'
import { ok, err } from '../types'
import { IDBStorage } from '../storage/idb'
import { generateId, getMimeType, base64ToUint8Array } from '../utils'

type CapacitorFilesystem = typeof import('@capacitor/filesystem')

/**
 * Adapter for Capacitor mobile applications.
 * Limited directory support (Documents directory only).
 *
 * Note: saveFile() saves to the app's Data directory, not the original location.
 * Check capabilities.canSaveInPlace to detect this behavior.
 */
export class CapacitorAdapter implements FSBridgeAdapter {
  platform = 'capacitor' as const
  private storage: IDBStorage
  private filesystem: CapacitorFilesystem | null = null
  private persistByDefault: boolean

  constructor(appName: string, maxRecentFiles = 10, persistByDefault = true) {
    this.storage = new IDBStorage(appName, maxRecentFiles)
    this.persistByDefault = persistByDefault
  }

  isSupported(): boolean {
    return 'Capacitor' in window
  }

  private async loadModule(): Promise<CapacitorFilesystem> {
    if (!this.filesystem) {
      this.filesystem = await import('@capacitor/filesystem')
    }
    return this.filesystem
  }

  async openFile(options: FSBridgeOpenOptions = {}): Promise<FSBridgeResult<FSBridgeFile | FSBridgeFile[]>> {
    const shouldPersist = options.persist ?? this.persistByDefault
    const accept = options.accept?.join(',') ?? '*/*'
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.multiple = options.multiple ?? false

    return new Promise((resolve) => {
      input.onchange = async () => {
        const fileList = input.files
        if (!fileList || fileList.length === 0) {
          resolve(err('cancelled', 'No files selected'))
          return
        }

        try {
          const files: FSBridgeFile[] = []

          for (let i = 0; i < fileList.length; i++) {
            const file = fileList[i]
            const content = new Uint8Array(await file.arrayBuffer())
            const id = generateId()
            const syntheticPath = `fsbridge_${id}_${file.name}`

            if (shouldPersist) {
              const storedFile: StoredFile = {
                id,
                name: file.name,
                path: syntheticPath,
                content,
                mimeType: file.type || getMimeType(file.name),
                size: content.byteLength,
                lastModified: file.lastModified,
                storedAt: Date.now(),
              }
              await this.storage.storeFile(storedFile)
            }

            files.push({
              id,
              name: file.name,
              path: syntheticPath,
              content,
              mimeType: file.type || getMimeType(file.name),
              size: content.byteLength,
              lastModified: file.lastModified,
            })
          }

          resolve(ok(options.multiple ? files : files[0]))
        } catch (e) {
          const error = e as Error
          resolve(err('io_error', error.message || 'Failed to read file', e))
        }
      }

      input.oncancel = () => resolve(err('cancelled', 'User cancelled file picker'))
      input.click()
    })
  }

  /**
   * Save file to app's Data directory (not original location).
   */
  async saveFile(
    file: FSBridgeFile,
    content: Uint8Array | string,
    options?: FSBridgeSaveOptions
  ): Promise<FSBridgeResult<boolean>> {
    const shouldPersist = options?.persist ?? this.persistByDefault

    try {
      const { Filesystem, Directory } = await this.loadModule()

      const contentArray = typeof content === 'string' ? new TextEncoder().encode(content) : content
      const fileName = file.path ?? `fsbridge_${file.id}_${file.name}`

      await Filesystem.writeFile({
        path: fileName,
        data: new Blob([contentArray.buffer as ArrayBuffer]),
        directory: Directory.Data,
      })

      if (shouldPersist) {
        const storedFile: StoredFile = {
          id: file.id,
          name: file.name,
          path: fileName,
          content: contentArray,
          mimeType: file.mimeType,
          size: contentArray.byteLength,
          lastModified: Date.now(),
          storedAt: Date.now(),
        }
        await this.storage.storeFile(storedFile)
      }

      return ok(true)
    } catch (e) {
      const error = e as Error
      if (error.message?.includes('Permission denied')) {
        return err('permission_denied', 'Permission denied to save file', e)
      }
      return err('io_error', error.message || 'Failed to save file', e)
    }
  }

  async saveFileAs(content: Uint8Array | string, options: FSBridgeSaveOptions = {}): Promise<FSBridgeResult<FSBridgeFile>> {
    const shouldPersist = options.persist ?? this.persistByDefault

    try {
      const { Filesystem, Directory } = await this.loadModule()

      const contentArray = typeof content === 'string' ? new TextEncoder().encode(content) : content
      const name = options.suggestedName ?? 'untitled'
      const id = generateId()
      const fileName = `fsbridge_${id}_${name}`

      await Filesystem.writeFile({
        path: fileName,
        data: new Blob([contentArray.buffer as ArrayBuffer]),
        directory: Directory.Data,
      })

      if (shouldPersist) {
        const storedFile: StoredFile = {
          id,
          name,
          path: fileName,
          content: contentArray,
          mimeType: getMimeType(name),
          size: contentArray.byteLength,
          lastModified: Date.now(),
          storedAt: Date.now(),
        }
        await this.storage.storeFile(storedFile)
      }

      return ok({
        id,
        name,
        path: fileName,
        content: contentArray,
        mimeType: getMimeType(name),
        size: contentArray.byteLength,
        lastModified: Date.now(),
      })
    } catch (e) {
      const error = e as Error
      if (error.message?.includes('Permission denied')) {
        return err('permission_denied', 'Permission denied to save file', e)
      }
      return err('io_error', error.message || 'Failed to save file', e)
    }
  }

  /**
   * Opens the Documents directory (limited - no picker).
   */
  async openDirectory(options: FSBridgeDirectoryOptions = {}): Promise<FSBridgeResult<FSBridgeDirectory>> {
    const shouldPersist = options.persist ?? this.persistByDefault

    try {
      const { Filesystem, Directory } = await this.loadModule()

      // Verify we can access the directory
      const result = await Filesystem.readdir({
        path: '',
        directory: Directory.Documents,
      })

      if (!result) {
        return err('io_error', 'Failed to read directory')
      }

      const id = generateId()

      if (shouldPersist) {
        const storedFile: StoredFile = {
          id,
          name: 'Documents',
          path: '',
          content: new Uint8Array(0),
          mimeType: 'inode/directory',
          size: 0,
          lastModified: Date.now(),
          storedAt: Date.now(),
        }
        await this.storage.storeFile(storedFile)
      }

      return ok({
        id,
        name: 'Documents',
        path: '',
      })
    } catch (e) {
      const error = e as Error
      if (error.message?.includes('Permission denied')) {
        return err('permission_denied', 'Permission denied to access directory', e)
      }
      return err('io_error', error.message || 'Failed to open directory', e)
    }
  }

  /**
   * List directory contents as entries (metadata only).
   * Limited to Documents directory.
   */
  async readDirectory(directory: FSBridgeDirectory): Promise<FSBridgeResult<FSBridgeEntry[]>> {
    try {
      const { Filesystem, Directory } = await this.loadModule()

      const result = await Filesystem.readdir({
        path: directory.path ?? '',
        directory: Directory.Documents,
      })

      const entries: FSBridgeEntry[] = []

      for (const entry of result.files) {
        const filePath = directory.path ? `${directory.path}/${entry.name}` : entry.name

        if (entry.type === 'directory') {
          entries.push({
            name: entry.name,
            kind: 'directory',
            path: filePath,
          })
        } else {
          entries.push({
            name: entry.name,
            kind: 'file',
            size: entry.size,
            lastModified: entry.mtime ?? Date.now(),
            path: filePath,
          })
        }
      }

      return ok(entries)
    } catch (e) {
      const error = e as Error
      if (error.message?.includes('not found') || error.message?.includes('does not exist')) {
        return err('not_found', 'Directory not found', e)
      }
      if (error.message?.includes('Permission denied')) {
        return err('permission_denied', 'Permission denied to read directory', e)
      }
      return err('io_error', error.message || 'Failed to read directory', e)
    }
  }

  /**
   * Load a specific file from a directory.
   */
  async readFileFromDirectory(
    _directory: FSBridgeDirectory,
    entry: FSBridgeEntry
  ): Promise<FSBridgeResult<FSBridgeFile>> {
    if (!entry.path || entry.kind !== 'file') {
      return err('not_supported', 'Cannot read file without path')
    }

    try {
      const { Filesystem, Directory } = await this.loadModule()

      const fileData = await Filesystem.readFile({
        path: entry.path,
        directory: Directory.Documents,
      })

      let content: Uint8Array
      if (fileData.data instanceof Blob) {
        content = new Uint8Array(await fileData.data.arrayBuffer())
      } else {
        // Base64 encoded string
        content = base64ToUint8Array(fileData.data as string)
      }

      return ok({
        id: generateId(),
        name: entry.name,
        path: entry.path,
        content,
        mimeType: getMimeType(entry.name),
        size: content.byteLength,
        lastModified: entry.lastModified ?? Date.now(),
      })
    } catch (e) {
      const error = e as Error
      if (error.message?.includes('not found') || error.message?.includes('does not exist')) {
        return err('not_found', 'File not found', e)
      }
      if (error.message?.includes('Permission denied')) {
        return err('permission_denied', 'Permission denied to read file', e)
      }
      return err('io_error', error.message || 'Failed to read file', e)
    }
  }

  async getRecentFiles(): Promise<StoredHandle[]> {
    const files = await this.storage.getStoredFiles()
    return files.map((f) => ({
      id: f.id,
      name: f.name,
      path: f.path,
      type: f.mimeType === 'inode/directory' ? 'directory' as const : 'file' as const,
      storedAt: f.storedAt,
    }))
  }

  async restoreFile(stored: StoredHandle): Promise<FSBridgeResult<FSBridgeFile>> {
    const file = await this.storage.getStoredFile(stored.id)
    if (!file) {
      return err('not_found', 'File not found in storage')
    }

    return ok({
      id: file.id,
      name: file.name,
      path: file.path,
      content: file.content,
      mimeType: file.mimeType,
      size: file.size,
      lastModified: file.lastModified,
    })
  }

  async removeFromRecent(id: string): Promise<void> {
    await this.storage.removeFile(id)
  }

  async clearRecent(): Promise<void> {
    await this.storage.clearFiles()
  }
}
