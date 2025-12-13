import type {
  OneFSAdapter,
  OneFSFile,
  OneFSOpenOptions,
  OneFSSaveOptions,
  OneFSDirectory,
  OneFSDirectoryOptions,
  OneFSReadDirectoryOptions,
  OneFSScanOptions,
  OneFSEntry,
  StoredHandle,
  StoredFile,
  OneFSResult,
} from '../types'
import { ok, err } from '../types'
import { IDBStorage } from '../storage/idb'
import { generateId, getMimeType, getFileName } from '../utils'

type TauriDialog = typeof import('@tauri-apps/plugin-dialog')
type TauriFS = typeof import('@tauri-apps/plugin-fs')
type TauriCore = typeof import('@tauri-apps/api/core')

/**
 * Adapter for Tauri v2 desktop applications.
 * Provides full filesystem access via native dialogs.
 */
export class TauriAdapter implements OneFSAdapter {
  platform = 'tauri' as const
  private storage: IDBStorage
  private dialog: TauriDialog | null = null
  private fs: TauriFS | null = null
  private core: TauriCore | null = null
  private persistByDefault: boolean

  constructor(appName: string, maxRecentFiles = 10, persistByDefault = true) {
    this.storage = new IDBStorage(appName, maxRecentFiles)
    this.persistByDefault = persistByDefault
  }

  isSupported(): boolean {
    if (typeof window === 'undefined') return false
    return '__TAURI_INTERNALS__' in window
  }

  private async loadModules(): Promise<{ dialog: TauriDialog; fs: TauriFS; core: TauriCore }> {
    if (!this.dialog || !this.fs || !this.core) {
      const [dialog, fs, core] = await Promise.all([
        import('@tauri-apps/plugin-dialog'),
        import('@tauri-apps/plugin-fs'),
        import('@tauri-apps/api/core'),
      ])
      this.dialog = dialog
      this.fs = fs
      this.core = core
    }
    return { dialog: this.dialog, fs: this.fs, core: this.core }
  }

  async openFile(options: OneFSOpenOptions = {}): Promise<OneFSResult<OneFSFile | OneFSFile[]>> {
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
      const files: OneFSFile[] = []

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
    file: OneFSFile,
    content: Uint8Array | string,
    options?: OneFSSaveOptions
  ): Promise<OneFSResult<boolean>> {
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

  async saveFileAs(content: Uint8Array | string, options: OneFSSaveOptions = {}): Promise<OneFSResult<OneFSFile>> {
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

  async openDirectory(options: OneFSDirectoryOptions = {}): Promise<OneFSResult<OneFSDirectory>> {
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
   *
   * @param directory - Directory to read
   * @param options.skipStats - Skip stat() calls for faster scanning (size/lastModified will be undefined)
   */
  async readDirectory(
    directory: OneFSDirectory,
    options: OneFSReadDirectoryOptions = {}
  ): Promise<OneFSResult<OneFSEntry[]>> {
    if (!directory.path) {
      return err('not_supported', 'Cannot read directory without path')
    }

    try {
      const { fs } = await this.loadModules()
      const dirEntries = await fs.readDir(directory.path)
      const entries: OneFSEntry[] = []

      for (const entry of dirEntries) {
        // Defensive check for entry.name
        if (!entry.name) continue

        const filePath = `${directory.path}/${entry.name}`

        if (entry.isFile) {
          if (options.skipStats) {
            // Fast path: skip stat() call
            entries.push({
              name: entry.name,
              kind: 'file',
              path: filePath,
            })
          } else {
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
   * Note: maxBytes option is not yet implemented for Tauri (full file is always loaded).
   */
  async readFileFromDirectory(
    _directory: OneFSDirectory,
    entry: OneFSEntry,
    _options?: { maxBytes?: number }
  ): Promise<OneFSResult<OneFSFile>> {
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

  /**
   * Recursively scan a directory for files.
   * Uses iterative approach to avoid stack overflow on deep directories.
   *
   * @param directory - Directory to scan
   * @param options.skipStats - Skip stat() calls for faster scanning
   * @param options.extensions - File extensions to include (e.g., ['.mp3', '.flac'])
   * @param options.onProgress - Callback for progress updates (scanned, found)
   * @param options.signal - AbortSignal for cancellation
   */
  async scanDirectory(
    directory: OneFSDirectory,
    options: OneFSScanOptions = {}
  ): Promise<OneFSResult<OneFSEntry[]>> {
    if (!directory.path) {
      return err('not_supported', 'Cannot scan directory without path')
    }

    const { extensions, onProgress, onError, signal, skipStats } = options
    const extensionSet = extensions?.length
      ? new Set(extensions.map((e) => e.toLowerCase().replace(/^\./, '')))
      : null

    try {
      const { fs } = await this.loadModules()
      const files: OneFSEntry[] = []
      const directoriesToScan: string[] = [directory.path]
      let totalScanned = 0

      while (directoriesToScan.length > 0) {
        // Check for cancellation
        if (signal?.aborted) {
          return err('cancelled', 'Scan was cancelled')
        }

        const currentDir = directoriesToScan.pop()!

        try {
          const dirEntries = await fs.readDir(currentDir)

          for (const entry of dirEntries) {
            // Defensive check for entry.name
            if (!entry.name) continue

            const entryPath = `${currentDir}/${entry.name}`

            if (entry.isDirectory) {
              // Queue subdirectory for later scanning
              directoriesToScan.push(entryPath)
            } else if (entry.isFile) {
              // Check extension filter
              if (extensionSet) {
                const ext = entry.name.split('.').pop()?.toLowerCase()
                if (!ext || !extensionSet.has(ext)) continue
              }

              if (skipStats) {
                files.push({
                  name: entry.name,
                  kind: 'file',
                  path: entryPath,
                })
              } else {
                try {
                  const stat = await fs.stat(entryPath)
                  files.push({
                    name: entry.name,
                    kind: 'file',
                    size: stat.size,
                    lastModified: stat.mtime ? new Date(stat.mtime).getTime() : Date.now(),
                    path: entryPath,
                  })
                } catch {
                  files.push({
                    name: entry.name,
                    kind: 'file',
                    path: entryPath,
                  })
                }
              }
            }

            totalScanned++
          }

          // Report progress and yield to main thread periodically
          if (onProgress && totalScanned % 100 === 0) {
            onProgress(totalScanned, files.length)
          }
          if (totalScanned % 500 === 0) {
            await new Promise((resolve) => setTimeout(resolve, 0))
          }
        } catch (dirError) {
          onError?.(currentDir, dirError)
        }
      }

      // Final progress update
      if (onProgress) {
        onProgress(totalScanned, files.length)
      }

      return ok(files)
    } catch (e) {
      const error = e as Error
      if (error.message?.includes('No such file') || error.message?.includes('not found')) {
        return err('not_found', 'Directory not found', e)
      }
      if (error.message?.includes('Permission denied')) {
        return err('permission_denied', 'Permission denied to scan directory', e)
      }
      return err('io_error', error.message || 'Failed to scan directory', e)
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

  async restoreFile(stored: StoredHandle): Promise<OneFSResult<OneFSFile>> {
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

  async restoreDirectory(stored: StoredHandle): Promise<OneFSResult<OneFSDirectory>> {
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

  /**
   * Get an efficient URL for a file using Tauri's asset protocol.
   * This avoids loading the entire file into memory.
   * Falls back to blob URL if convertFileSrc is not available.
   */
  async getFileUrl(file: OneFSFile): Promise<string> {
    if (!file.path) {
      return URL.createObjectURL(new Blob([file.content.buffer as ArrayBuffer], { type: file.mimeType }))
    }

    try {
      const { core } = await this.loadModules()
      return core.convertFileSrc(file.path)
    } catch {
      return URL.createObjectURL(new Blob([file.content.buffer as ArrayBuffer], { type: file.mimeType }))
    }
  }

  /**
   * Get an efficient URL for a directory entry without loading content.
   * Use this for audio/video streaming where you don't need the file in memory.
   */
  async getEntryUrl(entry: OneFSEntry): Promise<string | null> {
    if (!entry.path || entry.kind !== 'file') {
      return null
    }

    try {
      const { core } = await this.loadModules()
      return core.convertFileSrc(entry.path)
    } catch {
      return null
    }
  }
}

/**
 * Get a Tauri asset URL for a file path.
 * Useful for audio/video playback without loading entire file into memory.
 * Returns null if not running in Tauri v2.
 */
export async function getTauriFileUrl(filePath: string): Promise<string | null> {
  if (typeof window === 'undefined') return null
  if (!('__TAURI_INTERNALS__' in window)) return null

  try {
    const { convertFileSrc } = await import('@tauri-apps/api/core')
    return convertFileSrc(filePath)
  } catch {
    return null
  }
}
