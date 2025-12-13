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
  OneFSResult,
} from '../types'
import { ok, err } from '../types'
import { IDBStorage } from '../storage/idb'
import { generateId, getMimeType, base64ToUint8Array, uint8ArrayToBase64 } from '../utils'

type CapacitorFilesystem = typeof import('@capacitor/filesystem')
type CapacitorCore = typeof import('@capacitor/core')

interface FilePickerResult {
  files: Array<{
    name: string
    path?: string
    mimeType?: string
    modifiedAt?: number
    size?: number
  }>
}

interface FilePicker {
  pickFiles(options: {
    types?: string[]
    multiple?: boolean
    readData?: boolean
  }): Promise<FilePickerResult>
}

/**
 * Adapter for Capacitor mobile applications.
 *
 * Primary workflow: Enable Files app sharing via Info.plist, then scan Documents folder.
 * Users drag files into your app's folder in the iOS Files app.
 *
 * Info.plist settings required:
 * - UIFileSharingEnabled: true
 * - LSSupportsOpeningDocumentsInPlace: true
 *
 * Note: saveFile() saves to the app's Documents directory.
 */
export class CapacitorAdapter implements OneFSAdapter {
  platform = 'capacitor' as const
  private storage: IDBStorage
  private filesystem: CapacitorFilesystem | null = null
  private core: CapacitorCore | null = null
  private persistByDefault: boolean

  constructor(appName: string, maxRecentFiles = 10, persistByDefault = true) {
    this.storage = new IDBStorage(appName, maxRecentFiles)
    this.persistByDefault = persistByDefault
  }

  isSupported(): boolean {
    if (typeof window === 'undefined') return false
    const cap = (window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
    return cap?.isNativePlatform?.() ?? false
  }

  private async loadFilesystem(): Promise<CapacitorFilesystem> {
    if (!this.filesystem) {
      this.filesystem = await import('@capacitor/filesystem')
    }
    return this.filesystem
  }

  private async loadCore(): Promise<CapacitorCore> {
    if (!this.core) {
      this.core = await import('@capacitor/core')
    }
    return this.core
  }

  /**
   * Open file picker. Uses @capawesome/capacitor-file-picker if available,
   * falls back to HTML input element.
   */
  async openFile(options: OneFSOpenOptions = {}): Promise<OneFSResult<OneFSFile | OneFSFile[]>> {
    const shouldPersist = options.persist ?? this.persistByDefault

    try {
      // Try to use @capawesome/capacitor-file-picker
      const files = await this.pickFilesWithPlugin(options)
      if (files) {
        const result = shouldPersist ? await this.persistFiles(files) : files
        return ok(options.multiple ? result : result[0])
      }
    } catch {
      // Plugin not available, fall through to HTML input
    }

    // Fallback to HTML input
    return this.pickFilesWithInput(options, shouldPersist)
  }

  private async pickFilesWithPlugin(options: OneFSOpenOptions): Promise<OneFSFile[] | null> {
    try {
      const module = await import('@capawesome/capacitor-file-picker' as string) as { FilePicker: FilePicker }
      const { FilePicker } = module
      const { Filesystem, Directory } = await this.loadFilesystem()

      const types = options.accept?.map(ext => {
        const mimeMap: Record<string, string> = {
          '.mp3': 'audio/mpeg',
          '.flac': 'audio/flac',
          '.wav': 'audio/wav',
          '.m4a': 'audio/mp4',
          '.aac': 'audio/aac',
          '.ogg': 'audio/ogg',
          '.opus': 'audio/opus',
        }
        return mimeMap[ext] || 'audio/*'
      }) ?? ['audio/*']

      const result = await FilePicker.pickFiles({
        types,
        multiple: options.multiple ?? false,
        readData: false,
      })

      const files: OneFSFile[] = []

      for (const picked of result.files) {
        // Copy file to Documents for persistent access
        const destName = `${generateId()}_${picked.name}`
        const destPath = destName

        // Read and copy to Documents
        const fileData = await Filesystem.readFile({ path: picked.path! })
        await Filesystem.writeFile({
          path: destPath,
          data: fileData.data,
          directory: Directory.Documents,
        })

        const content = typeof fileData.data === 'string'
          ? base64ToUint8Array(fileData.data)
          : new Uint8Array(await (fileData.data as Blob).arrayBuffer())

        files.push({
          id: generateId(),
          name: picked.name,
          path: destPath,
          content,
          mimeType: picked.mimeType || getMimeType(picked.name),
          size: content.byteLength,
          lastModified: picked.modifiedAt ?? Date.now(),
        })
      }

      return files.length > 0 ? files : null
    } catch {
      return null
    }
  }

  private pickFilesWithInput(
    options: OneFSOpenOptions,
    shouldPersist: boolean
  ): Promise<OneFSResult<OneFSFile | OneFSFile[]>> {
    const accept = options.accept?.join(',') ?? 'audio/*'
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
          const { Filesystem, Directory } = await this.loadFilesystem()
          const files: OneFSFile[] = []

          for (let i = 0; i < fileList.length; i++) {
            const file = fileList[i]
            const content = new Uint8Array(await file.arrayBuffer())
            const id = generateId()
            const destPath = `${id}_${file.name}`

            // Copy to Documents for persistent access
            await Filesystem.writeFile({
              path: destPath,
              data: uint8ArrayToBase64(content),
              directory: Directory.Documents,
            })

            const onefsFile: OneFSFile = {
              id,
              name: file.name,
              path: destPath,
              content,
              mimeType: file.type || getMimeType(file.name),
              size: content.byteLength,
              lastModified: file.lastModified,
            }

            if (shouldPersist) {
              await this.storage.storeFile({
                ...onefsFile,
                storedAt: Date.now(),
              })
            }

            files.push(onefsFile)
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

  private async persistFiles(files: OneFSFile[]): Promise<OneFSFile[]> {
    for (const file of files) {
      await this.storage.storeFile({
        ...file,
        storedAt: Date.now(),
      })
    }
    return files
  }

  async saveFile(
    file: OneFSFile,
    content: Uint8Array | string,
    options?: OneFSSaveOptions
  ): Promise<OneFSResult<boolean>> {
    const shouldPersist = options?.persist ?? this.persistByDefault

    try {
      const { Filesystem, Directory } = await this.loadFilesystem()

      const contentArray = typeof content === 'string' ? new TextEncoder().encode(content) : content
      const fileName = file.path ?? `${file.id}_${file.name}`

      await Filesystem.writeFile({
        path: fileName,
        data: uint8ArrayToBase64(contentArray),
        directory: Directory.Documents,
      })

      if (shouldPersist) {
        await this.storage.storeFile({
          id: file.id,
          name: file.name,
          path: fileName,
          content: contentArray,
          mimeType: file.mimeType,
          size: contentArray.byteLength,
          lastModified: Date.now(),
          storedAt: Date.now(),
        })
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
      const { Filesystem, Directory } = await this.loadFilesystem()

      const contentArray = typeof content === 'string' ? new TextEncoder().encode(content) : content
      const name = options.suggestedName ?? 'untitled'
      const id = generateId()
      const fileName = `${id}_${name}`

      await Filesystem.writeFile({
        path: fileName,
        data: uint8ArrayToBase64(contentArray),
        directory: Directory.Documents,
      })

      const file: OneFSFile = {
        id,
        name,
        path: fileName,
        content: contentArray,
        mimeType: getMimeType(name),
        size: contentArray.byteLength,
        lastModified: Date.now(),
      }

      if (shouldPersist) {
        await this.storage.storeFile({ ...file, storedAt: Date.now() })
      }

      return ok(file)
    } catch (e) {
      const error = e as Error
      if (error.message?.includes('Permission denied')) {
        return err('permission_denied', 'Permission denied to save file', e)
      }
      return err('io_error', error.message || 'Failed to save file', e)
    }
  }

  /**
   * Opens the app's Documents directory.
   * This is the folder exposed in iOS Files app when UIFileSharingEnabled is true.
   */
  async openDirectory(_options: OneFSDirectoryOptions = {}): Promise<OneFSResult<OneFSDirectory>> {
    try {
      const { Filesystem, Directory } = await this.loadFilesystem()

      // Verify we can access the directory
      await Filesystem.readdir({
        path: '',
        directory: Directory.Documents,
      })

      const id = generateId()

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
   */
  async readDirectory(
    directory: OneFSDirectory,
    options: OneFSReadDirectoryOptions = {}
  ): Promise<OneFSResult<OneFSEntry[]>> {
    try {
      const { Filesystem, Directory } = await this.loadFilesystem()

      const result = await Filesystem.readdir({
        path: directory.path ?? '',
        directory: Directory.Documents,
      })

      const entries: OneFSEntry[] = []

      for (const entry of result.files) {
        const filePath = directory.path ? `${directory.path}/${entry.name}` : entry.name

        if (entry.type === 'directory') {
          entries.push({
            name: entry.name,
            kind: 'directory',
            path: filePath,
          })
        } else {
          if (options.skipStats) {
            entries.push({
              name: entry.name,
              kind: 'file',
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
   * Recursively scan directory for files.
   */
  async scanDirectory(
    directory: OneFSDirectory,
    options: OneFSScanOptions = {}
  ): Promise<OneFSResult<OneFSEntry[]>> {
    const { extensions, onProgress, onError, signal, skipStats } = options
    const extensionSet = extensions?.length
      ? new Set(extensions.map(e => e.toLowerCase().replace(/^\./, '')))
      : null

    try {
      const { Filesystem, Directory } = await this.loadFilesystem()
      const files: OneFSEntry[] = []
      const directoriesToScan: string[] = [directory.path ?? '']
      let totalScanned = 0

      while (directoriesToScan.length > 0) {
        if (signal?.aborted) {
          return err('cancelled', 'Scan was cancelled')
        }

        const currentDir = directoriesToScan.pop()!

        try {
          const result = await Filesystem.readdir({
            path: currentDir,
            directory: Directory.Documents,
          })

          for (const entry of result.files) {
            const entryPath = currentDir ? `${currentDir}/${entry.name}` : entry.name

            if (entry.type === 'directory') {
              directoriesToScan.push(entryPath)
            } else {
              // Check extension filter
              if (extensionSet) {
                const ext = entry.name.split('.').pop()?.toLowerCase()
                if (!ext || !extensionSet.has(ext)) {
                  continue
                }
              }

              if (skipStats) {
                files.push({
                  name: entry.name,
                  kind: 'file',
                  path: entryPath,
                })
              } else {
                files.push({
                  name: entry.name,
                  kind: 'file',
                  size: entry.size,
                  lastModified: entry.mtime ?? Date.now(),
                  path: entryPath,
                })
              }
            }

            totalScanned++
          }

          if (onProgress && totalScanned % 100 === 0) {
            onProgress(totalScanned, files.length)
          }
          if (totalScanned % 500 === 0) {
            await new Promise(resolve => setTimeout(resolve, 0))
          }
        } catch (dirError) {
          onError?.(currentDir, dirError)
        }
      }

      if (onProgress) {
        onProgress(totalScanned, files.length)
      }

      return ok(files)
    } catch (e) {
      const error = e as Error
      if (error.message?.includes('not found') || error.message?.includes('does not exist')) {
        return err('not_found', 'Directory not found', e)
      }
      if (error.message?.includes('Permission denied')) {
        return err('permission_denied', 'Permission denied to scan directory', e)
      }
      return err('io_error', error.message || 'Failed to scan directory', e)
    }
  }

  /**
   * Load a specific file from a directory.
   * Supports partial reads via maxBytes option to reduce memory usage for large files.
   */
  async readFileFromDirectory(
    _directory: OneFSDirectory,
    entry: OneFSEntry,
    options?: { maxBytes?: number }
  ): Promise<OneFSResult<OneFSFile>> {
    if (!entry.path || entry.kind !== 'file') {
      return err('not_supported', 'Cannot read file without path')
    }

    try {
      const { Filesystem, Directory } = await this.loadFilesystem()
      const { Capacitor } = await this.loadCore()

      // For partial reads on large files, use fetch with Range header
      if (options?.maxBytes && entry.size && entry.size > options.maxBytes) {
        try {
          const uri = await Filesystem.getUri({
            path: entry.path,
            directory: Directory.Documents,
          })
          const nativeUrl = Capacitor.convertFileSrc(uri.uri)

          const response = await fetch(nativeUrl, {
            headers: { Range: `bytes=0-${options.maxBytes - 1}` }
          })

          if (response.ok || response.status === 206) {
            const arrayBuffer = await response.arrayBuffer()
            const content = new Uint8Array(arrayBuffer)

            return ok({
              id: generateId(),
              name: entry.name,
              path: entry.path,
              content,
              mimeType: getMimeType(entry.name),
              size: content.byteLength,
              lastModified: entry.lastModified ?? Date.now(),
            })
          }
        } catch (partialError) {
          // Fallback to full read
        }
      }

      // Full file read (original behavior)
      const fileData = await Filesystem.readFile({
        path: entry.path,
        directory: Directory.Documents,
      })

      let content: Uint8Array
      if (fileData.data instanceof Blob) {
        content = new Uint8Array(await fileData.data.arrayBuffer())
      } else {
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

  /**
   * Get an efficient URL for a file using Capacitor's convertFileSrc.
   * This avoids loading the entire file into memory.
   */
  async getFileUrl(file: OneFSFile): Promise<string> {
    if (!file.path) {
      return URL.createObjectURL(new Blob([file.content.buffer as ArrayBuffer], { type: file.mimeType }))
    }

    try {
      const { Filesystem, Directory } = await this.loadFilesystem()
      const { Capacitor } = await this.loadCore()

      const result = await Filesystem.getUri({
        path: file.path,
        directory: Directory.Documents,
      })

      return Capacitor.convertFileSrc(result.uri)
    } catch {
      return URL.createObjectURL(new Blob([file.content.buffer as ArrayBuffer], { type: file.mimeType }))
    }
  }

  /**
   * Get an efficient URL for a directory entry without loading content.
   * Use this for audio/video streaming.
   */
  async getEntryUrl(entry: OneFSEntry): Promise<string | null> {
    if (!entry.path || entry.kind !== 'file') {
      return null
    }

    try {
      const { Filesystem, Directory } = await this.loadFilesystem()
      const { Capacitor } = await this.loadCore()

      const result = await Filesystem.getUri({
        path: entry.path,
        directory: Directory.Documents,
      })

      return Capacitor.convertFileSrc(result.uri)
    } catch {
      return null
    }
  }

  async getRecentFiles(): Promise<StoredHandle[]> {
    const files = await this.storage.getStoredFiles()
    return files.map(f => ({
      id: f.id,
      name: f.name,
      path: f.path,
      type: f.mimeType === 'inode/directory' ? 'directory' as const : 'file' as const,
      storedAt: f.storedAt,
    }))
  }

  async restoreFile(stored: StoredHandle): Promise<OneFSResult<OneFSFile>> {
    // Try to read fresh from disk first
    if (stored.path) {
      try {
        const { Filesystem, Directory } = await this.loadFilesystem()

        const fileData = await Filesystem.readFile({
          path: stored.path,
          directory: Directory.Documents,
        })

        let content: Uint8Array
        if (fileData.data instanceof Blob) {
          content = new Uint8Array(await fileData.data.arrayBuffer())
        } else {
          content = base64ToUint8Array(fileData.data as string)
        }

        const stat = await Filesystem.stat({
          path: stored.path,
          directory: Directory.Documents,
        })

        return ok({
          id: stored.id,
          name: stored.name,
          path: stored.path,
          content,
          mimeType: getMimeType(stored.name),
          size: content.byteLength,
          lastModified: stat.mtime ?? Date.now(),
        })
      } catch {
        // File may have been deleted, fall back to storage
      }
    }

    // Fall back to stored content
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

  async restoreDirectory(stored: StoredHandle): Promise<OneFSResult<OneFSDirectory>> {
    // For Capacitor, we only support the Documents directory
    if (stored.type !== 'directory') {
      return err('not_found', 'Not a directory')
    }

    try {
      const { Filesystem, Directory } = await this.loadFilesystem()

      await Filesystem.readdir({
        path: stored.path ?? '',
        directory: Directory.Documents,
      })

      return ok({
        id: stored.id,
        name: stored.name,
        path: stored.path ?? '',
      })
    } catch (e) {
      const error = e as Error
      return err('not_found', error.message || 'Directory not found', e)
    }
  }

  async removeFromRecent(id: string): Promise<void> {
    await this.storage.removeFile(id)
  }

  async clearRecent(): Promise<void> {
    await this.storage.clearFiles()
  }
}
