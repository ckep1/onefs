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
import { generateId, getMimeType, getFileName } from '../utils'

type TauriDialog = typeof import('@tauri-apps/plugin-dialog')
type TauriFS = typeof import('@tauri-apps/plugin-fs')

/**
 * Adapter for Tauri desktop applications.
 * Provides full filesystem access via native dialogs.
 */
export class TauriAdapter implements FSBridgeAdapter {
  platform = 'tauri' as const
  private storage: IDBStorage
  private dialog: TauriDialog | null = null
  private fs: TauriFS | null = null
  private persistByDefault: boolean

  constructor(appName: string, maxRecentFiles = 10, persistByDefault = true) {
    this.storage = new IDBStorage(appName, maxRecentFiles)
    this.persistByDefault = persistByDefault
  }

  isSupported(): boolean {
    return '__TAURI__' in window
  }

  private async loadModules(): Promise<{ dialog: TauriDialog; fs: TauriFS }> {
    if (!this.dialog || !this.fs) {
      const [dialog, fs] = await Promise.all([
        import('@tauri-apps/plugin-dialog'),
        import('@tauri-apps/plugin-fs'),
      ])
      this.dialog = dialog
      this.fs = fs
    }
    return { dialog: this.dialog, fs: this.fs }
  }

  async openFile(options: FSBridgeOpenOptions = {}): Promise<FSBridgeResult<FSBridgeFile | FSBridgeFile[]>> {
    const shouldPersist = options.persist ?? this.persistByDefault

    try {
      const { dialog, fs } = await this.loadModules()

      const filters =
        options.accept?.length
          ? [{ name: 'Accepted files', extensions: options.accept.map((a) => a.replace('.', '')) }]
          : undefined

      const result = await dialog.open({
        multiple: options.multiple ?? false,
        filters,
      })

      if (!result) {
        return err('cancelled', 'User cancelled file picker')
      }

      const paths = Array.isArray(result) ? result : [result]
      const files: FSBridgeFile[] = []

      for (const path of paths) {
        const content = await fs.readFile(path)
        const name = getFileName(path)
        const id = generateId()

        if (shouldPersist) {
          const storedFile: StoredFile = {
            id,
            name,
            path,
            content,
            mimeType: getMimeType(name),
            size: content.byteLength,
            lastModified: Date.now(),
            storedAt: Date.now(),
          }
          await this.storage.storeFile(storedFile)
        }

        files.push({
          id,
          name,
          path,
          content,
          mimeType: getMimeType(name),
          size: content.byteLength,
          lastModified: Date.now(),
        })
      }

      return ok(options.multiple ? files : files[0])
    } catch (e) {
      const error = e as Error
      // Tauri errors for file not found
      if (error.message?.includes('No such file') || error.message?.includes('not found')) {
        return err('not_found', 'File not found', e)
      }
      return err('io_error', error.message || 'Failed to open file', e)
    }
  }

  async saveFile(
    file: FSBridgeFile,
    content: Uint8Array | string,
    options?: FSBridgeSaveOptions
  ): Promise<FSBridgeResult<boolean>> {
    if (!file.path) {
      return err('not_supported', 'Cannot save file without path - use saveFileAs instead')
    }

    const shouldPersist = options?.persist ?? this.persistByDefault

    try {
      const { fs } = await this.loadModules()
      const contentArray = typeof content === 'string' ? new TextEncoder().encode(content) : content

      await fs.writeFile(file.path, contentArray)

      if (shouldPersist) {
        const storedFile: StoredFile = {
          id: file.id,
          name: file.name,
          path: file.path,
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
      const { dialog, fs } = await this.loadModules()

      const filters =
        options.accept?.length
          ? [{ name: 'Accepted files', extensions: options.accept.map((a) => a.replace('.', '')) }]
          : undefined

      const path = await dialog.save({
        defaultPath: options.suggestedName,
        filters,
      })

      if (!path) {
        return err('cancelled', 'User cancelled save dialog')
      }

      const contentArray = typeof content === 'string' ? new TextEncoder().encode(content) : content
      await fs.writeFile(path, contentArray)

      const name = getFileName(path)
      const id = generateId()

      if (shouldPersist) {
        const storedFile: StoredFile = {
          id,
          name,
          path,
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
        path,
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

  async openDirectory(options: FSBridgeDirectoryOptions = {}): Promise<FSBridgeResult<FSBridgeDirectory>> {
    const shouldPersist = options.persist ?? this.persistByDefault

    try {
      const { dialog } = await this.loadModules()

      const path = await dialog.open({
        directory: true,
      })

      if (!path || Array.isArray(path)) {
        return err('cancelled', 'User cancelled directory picker')
      }

      const id = generateId()

      if (shouldPersist) {
        // Store directory info for recent list
        const storedFile: StoredFile = {
          id,
          name: getFileName(path),
          path,
          content: new Uint8Array(0), // Empty content for directories
          mimeType: 'inode/directory',
          size: 0,
          lastModified: Date.now(),
          storedAt: Date.now(),
        }
        await this.storage.storeFile(storedFile)
      }

      return ok({
        id,
        name: getFileName(path),
        path,
      })
    } catch (e) {
      const error = e as Error
      return err('io_error', error.message || 'Failed to open directory', e)
    }
  }

  /**
   * List directory contents as entries (metadata only).
   * Use readFileFromDirectory() to load a specific file's content.
   */
  async readDirectory(directory: FSBridgeDirectory): Promise<FSBridgeResult<FSBridgeEntry[]>> {
    if (!directory.path) {
      return err('not_supported', 'Cannot read directory without path')
    }

    try {
      const { fs } = await this.loadModules()
      const dirEntries = await fs.readDir(directory.path)
      const entries: FSBridgeEntry[] = []

      for (const entry of dirEntries) {
        const filePath = `${directory.path}/${entry.name}`

        if (entry.isFile) {
          // Get file stats for size/lastModified
          try {
            const stat = await fs.stat(filePath)
            entries.push({
              name: entry.name,
              kind: 'file',
              size: stat.size,
              lastModified: stat.mtime ? new Date(stat.mtime).getTime() : Date.now(),
              path: filePath,
            })
          } catch {
            // If stat fails, add entry without size info
            entries.push({
              name: entry.name,
              kind: 'file',
              path: filePath,
            })
          }
        } else if (entry.isDirectory) {
          entries.push({
            name: entry.name,
            kind: 'directory',
            path: filePath,
          })
        }
      }

      return ok(entries)
    } catch (e) {
      const error = e as Error
      if (error.message?.includes('No such file') || error.message?.includes('not found')) {
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
      const { fs } = await this.loadModules()
      const content = await fs.readFile(entry.path)

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
      if (error.message?.includes('No such file') || error.message?.includes('not found')) {
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

    // If we have a path, try to read the current file contents
    if (file.path && file.mimeType !== 'inode/directory') {
      try {
        const { fs } = await this.loadModules()
        const content = await fs.readFile(file.path)
        const stat = await fs.stat(file.path)

        return ok({
          id: file.id,
          name: file.name,
          path: file.path,
          content,
          mimeType: file.mimeType,
          size: content.byteLength,
          lastModified: stat.mtime ? new Date(stat.mtime).getTime() : file.lastModified,
        })
      } catch {
        // Fall back to stored content if file no longer exists
      }
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

  async restoreDirectory(stored: StoredHandle): Promise<FSBridgeResult<FSBridgeDirectory>> {
    const file = await this.storage.getStoredFile(stored.id)
    if (!file || file.mimeType !== 'inode/directory') {
      return err('not_found', 'Directory not found in storage')
    }

    if (!file.path) {
      return err('not_found', 'Directory path not found')
    }

    // Verify the directory still exists
    try {
      const { fs } = await this.loadModules()
      const stat = await fs.stat(file.path)
      if (!stat.isDirectory) {
        return err('not_found', 'Path is not a directory')
      }

      return ok({
        id: file.id,
        name: file.name,
        path: file.path,
      })
    } catch (e) {
      const error = e as Error
      if (error.message?.includes('No such file') || error.message?.includes('not found')) {
        return err('not_found', 'Directory no longer exists at original location', e)
      }
      return err('io_error', error.message || 'Failed to restore directory', e)
    }
  }

  async removeFromRecent(id: string): Promise<void> {
    await this.storage.removeFile(id)
  }

  async clearRecent(): Promise<void> {
    await this.storage.clearFiles()
  }
}
