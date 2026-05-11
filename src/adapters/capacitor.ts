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
import { generateId, getMimeType, base64ToUint8Array, uint8ArrayToBase64, toArrayBuffer, sanitizeFileName, isPathWithin, isSafeEntryName } from '../utils'

type CapacitorFilesystem = typeof import('@capacitor/filesystem')
type CapacitorCore = typeof import('@capacitor/core')

const DIRECTORY_MIME_TYPE = 'inode/directory'

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

export class CapacitorAdapter implements OneFSAdapter {
  platform = 'capacitor' as const
  private storage: IDBStorage
  private filesystem: CapacitorFilesystem | null = null
  private core: CapacitorCore | null = null
  private persistByDefault: boolean
  private scanLock: Promise<void> = Promise.resolve()
  private sessionPaths = new Map<string, string>()

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

  private async acquireScanLock(): Promise<() => void> {
    let release: () => void
    const next = new Promise<void>(resolve => { release = resolve })
    const prev = this.scanLock
    this.scanLock = next
    await prev
    return release!
  }

  private isSafeDocumentsPath(path: string): boolean {
    if (!path || path.includes('\0')) return false

    const normalized = path.replace(/\\/g, '/')
    if (normalized.startsWith('/') || normalized.startsWith('../')) return false

    const segments = normalized.split('/')
    return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
  }

  private registerSessionFile(file: Pick<OneFSFile, 'id' | 'path'>): void {
    if (!file.path || !this.isSafeDocumentsPath(file.path)) return
    this.sessionPaths.set(file.id, file.path)
  }

  private async resolveAuthorizedPath(file: OneFSFile): Promise<OneFSResult<string>> {
    const requestedPath = file.path ?? `${file.id}_${sanitizeFileName(file.name)}`
    if (!this.isSafeDocumentsPath(requestedPath)) {
      return err('permission_denied', 'Invalid file path')
    }

    try {
      const stored = await this.storage.getStoredFile(file.id)
      if (stored?.path) {
        if (stored.path !== requestedPath) {
          return err('permission_denied', 'File path does not match stored record')
        }
        return ok(requestedPath)
      }

      const livePath = this.sessionPaths.get(file.id)
      if (livePath === requestedPath) {
        return ok(requestedPath)
      }

      return err('permission_denied', 'File was not opened through this adapter')
    } catch (e) {
      return err('io_error', 'Failed to verify file provenance', e)
    }
  }

  async openFile(options: OneFSOpenOptions = {}): Promise<OneFSResult<OneFSFile | OneFSFile[]>> {
    const shouldPersist = options.persist ?? this.persistByDefault

    try {
      const files = await this.pickFilesWithPlugin(options)
      if (files) {
        for (const file of files) {
          this.registerSessionFile(file)
        }
        if (shouldPersist) {
          for (const file of files) {
            this.storage.storeFileDeferred({ ...file, storedAt: Date.now() })
          }
        }
        return ok(options.multiple ? files : files[0])
      }
    } catch {
      // Plugin not available, fall through to HTML input
    }

    return this.pickFilesWithInput(options, shouldPersist)
  }

  private async pickFilesWithPlugin(options: OneFSOpenOptions): Promise<OneFSFile[] | null> {
    try {
      const module = await import('@capawesome/capacitor-file-picker' as string) as { FilePicker: FilePicker }
      const { FilePicker } = module
      const { Filesystem, Directory } = await this.loadFilesystem()

      const types = options.accept
        ? [...new Set(options.accept.map(ext => getMimeType(ext)))]
        : ['*/*']

      const result = await FilePicker.pickFiles({
        types,
        multiple: options.multiple ?? false,
        readData: false,
      })

      const fileResults = await Promise.all(
        result.files.map(async (picked) => {
          const id = generateId()
          const safeName = sanitizeFileName(picked.name)
          const destName = `${id}_${safeName}`
          const destPath = destName

          const fileData = await Filesystem.readFile({ path: picked.path! })
          await Filesystem.writeFile({
            path: destPath,
            data: fileData.data,
            directory: Directory.Documents,
          })

          const content = typeof fileData.data === 'string'
            ? base64ToUint8Array(fileData.data)
            : new Uint8Array(await (fileData.data as Blob).arrayBuffer())

          return {
            id,
            name: picked.name,
            path: destPath,
            content,
            mimeType: picked.mimeType || getMimeType(picked.name),
            size: content.byteLength,
            lastModified: picked.modifiedAt ?? Date.now(),
          }
        })
      )

      return fileResults.length > 0 ? fileResults : null
    } catch {
      return null
    }
  }

  private pickFilesWithInput(
    options: OneFSOpenOptions,
    shouldPersist: boolean
  ): Promise<OneFSResult<OneFSFile | OneFSFile[]>> {
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
          const { Filesystem, Directory } = await this.loadFilesystem()

          const results = await Promise.all(
            Array.from(fileList).map(async (file) => {
              const content = new Uint8Array(await file.arrayBuffer())
              return { file, content }
            })
          )

          const filesOut: OneFSFile[] = []

          for (const { file, content } of results) {
            const id = generateId()
            const safeName = sanitizeFileName(file.name)
            const destPath = `${id}_${safeName}`

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
              this.storage.storeFileDeferred({ ...onefsFile, storedAt: Date.now() })
            }
            this.registerSessionFile(onefsFile)

            filesOut.push(onefsFile)
          }

          resolve(ok(options.multiple ? filesOut : filesOut[0]))
        } catch (e) {
          const error = e as Error
          resolve(err('io_error', error.message || 'Failed to read file', e))
        }
      }

      input.oncancel = () => resolve(err('cancelled', 'User cancelled file picker'))
      input.click()
    })
  }

  async saveFile(
    file: OneFSFile,
    content: Uint8Array | string,
    options?: OneFSSaveOptions
  ): Promise<OneFSResult<boolean>> {
    const shouldPersist = options?.persist ?? this.persistByDefault
    const authorized = await this.resolveAuthorizedPath(file)
    if (!authorized.ok) return authorized
    const fileName = authorized.data

    try {
      const { Filesystem, Directory } = await this.loadFilesystem()

      const contentArray = typeof content === 'string' ? new TextEncoder().encode(content) : content

      await Filesystem.writeFile({
        path: fileName,
        data: uint8ArrayToBase64(contentArray),
        directory: Directory.Documents,
      })
      this.registerSessionFile({ id: file.id, path: fileName })

      if (shouldPersist) {
        this.storage.storeFileDeferred({
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
      const fileName = `${id}_${sanitizeFileName(name)}`

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
        this.storage.storeFileDeferred({ ...file, storedAt: Date.now() })
      }
      this.registerSessionFile(file)

      return ok(file)
    } catch (e) {
      const error = e as Error
      if (error.message?.includes('Permission denied')) {
        return err('permission_denied', 'Permission denied to save file', e)
      }
      return err('io_error', error.message || 'Failed to save file', e)
    }
  }

  async openDirectory(_options: OneFSDirectoryOptions = {}): Promise<OneFSResult<OneFSDirectory>> {
    try {
      const { Filesystem, Directory } = await this.loadFilesystem()

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
        if (!isSafeEntryName(entry.name)) continue
        const entryName = entry.name
        const filePath = directory.path ? `${directory.path}/${entryName}` : entryName

        if (entry.type === 'directory') {
          entries.push({
            name: entryName,
            kind: 'directory',
            path: filePath,
          })
        } else {
          if (options.skipStats) {
            entries.push({
              name: entryName,
              kind: 'file',
              path: filePath,
            })
          } else {
            entries.push({
              name: entryName,
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

  async scanDirectory(
    directory: OneFSDirectory,
    options: OneFSScanOptions = {}
  ): Promise<OneFSResult<OneFSEntry[]>> {
    const release = await this.acquireScanLock()
    try {
      return await this._scanDirectoryImpl(directory, options)
    } finally {
      release()
    }
  }

  private async _scanDirectoryImpl(
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
            if (!isSafeEntryName(entry.name)) continue
            const entryName = entry.name
            const entryPath = currentDir ? `${currentDir}/${entryName}` : entryName

            if (entry.type === 'directory') {
              directoriesToScan.push(entryPath)
            } else {
              if (extensionSet) {
                const ext = entryName.split('.').pop()?.toLowerCase()
                if (!ext || !extensionSet.has(ext)) {
                  continue
                }
              }

              if (skipStats) {
                files.push({
                  name: entryName,
                  kind: 'file',
                  path: entryPath,
                })
              } else {
                files.push({
                  name: entryName,
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

  async readFileFromDirectory(
    directory: OneFSDirectory,
    entry: OneFSEntry,
    options?: { maxBytes?: number }
  ): Promise<OneFSResult<OneFSFile>> {
    if (!entry.path || entry.kind !== 'file') {
      return err('not_supported', 'Cannot read file without path')
    }

    if (!this.isSafeDocumentsPath(entry.path)) {
      return err('permission_denied', 'Invalid file path')
    }

    if (directory.path && !isPathWithin(entry.path, directory.path)) {
      return err('permission_denied', 'Path is outside the expected directory')
    }

    try {
      const { Filesystem, Directory } = await this.loadFilesystem()
      const { Capacitor } = await this.loadCore()

      if (options?.maxBytes && entry.size && entry.size > options.maxBytes) {
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
          const partialFile: OneFSFile = {
            id: generateId(),
            name: entry.name,
            path: entry.path,
            content,
            mimeType: getMimeType(entry.name),
            size: content.byteLength,
            lastModified: entry.lastModified ?? Date.now(),
          }
          this.registerSessionFile(partialFile)

          return ok(partialFile)
        }
      }

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

      const loadedFile: OneFSFile = {
        id: generateId(),
        name: entry.name,
        path: entry.path,
        content,
        mimeType: getMimeType(entry.name),
        size: content.byteLength,
        lastModified: entry.lastModified ?? Date.now(),
      }
      this.registerSessionFile(loadedFile)

      return ok(loadedFile)
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

  async getFileUrl(file: OneFSFile): Promise<string> {
    if (!file.path) {
      return URL.createObjectURL(new Blob([toArrayBuffer(file.content)], { type: file.mimeType }))
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
      return URL.createObjectURL(new Blob([toArrayBuffer(file.content)], { type: file.mimeType }))
    }
  }

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
      type: f.mimeType === DIRECTORY_MIME_TYPE ? 'directory' as const : 'file' as const,
      storedAt: f.storedAt,
    }))
  }

  async restoreFile(stored: StoredHandle): Promise<OneFSResult<OneFSFile>> {
    const file = await this.storage.getStoredFile(stored.id)
    if (!file || file.mimeType === DIRECTORY_MIME_TYPE) {
      return err('not_found', 'File not found in storage')
    }

    if (file.path) {
      if (!this.isSafeDocumentsPath(file.path)) {
        return err('permission_denied', 'Invalid stored file path')
      }

      try {
        const { Filesystem, Directory } = await this.loadFilesystem()

        const fileData = await Filesystem.readFile({
          path: file.path,
          directory: Directory.Documents,
        })

        let content: Uint8Array
        if (fileData.data instanceof Blob) {
          content = new Uint8Array(await fileData.data.arrayBuffer())
        } else {
          content = base64ToUint8Array(fileData.data as string)
        }

        const stat = await Filesystem.stat({
          path: file.path,
          directory: Directory.Documents,
        })

        const restored: OneFSFile = {
          id: file.id,
          name: file.name,
          path: file.path,
          content,
          mimeType: file.mimeType,
          size: content.byteLength,
          lastModified: stat.mtime ?? Date.now(),
        }
        this.registerSessionFile(restored)
        return ok(restored)
      } catch (e) {
        const message = e instanceof Error ? e.message : 'File no longer accessible'
        return err('not_found', message, e)
      }
    }

    const restoredFromCache: OneFSFile = {
      id: file.id,
      name: file.name,
      path: file.path,
      content: file.content,
      mimeType: file.mimeType,
      size: file.size,
      lastModified: file.lastModified,
    }
    this.registerSessionFile(restoredFromCache)
    return ok(restoredFromCache)
  }

  async restoreDirectory(stored: StoredHandle): Promise<OneFSResult<OneFSDirectory>> {
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

  async deleteFile(file: OneFSFile): Promise<OneFSResult<boolean>> {
    const authorized = await this.resolveAuthorizedPath(file)
    if (!authorized.ok) return authorized
    const path = authorized.data

    try {
      const { Filesystem, Directory } = await this.loadFilesystem()
      await Filesystem.deleteFile({
        path,
        directory: Directory.Documents,
      })
      await this.storage.removeFile(file.id)
      this.sessionPaths.delete(file.id)
      return ok(true)
    } catch (e) {
      const error = e as Error
      if (error.message?.includes('not found') || error.message?.includes('does not exist')) {
        return err('not_found', 'File not found', e)
      }
      if (error.message?.includes('Permission denied')) {
        return err('permission_denied', 'Permission denied to delete file', e)
      }
      return err('io_error', error.message || 'Failed to delete file', e)
    }
  }

  async renameFile(file: OneFSFile, newName: string): Promise<OneFSResult<OneFSFile>> {
    if (!isSafeEntryName(newName)) {
      return err('io_error', 'Invalid file name')
    }

    const authorized = await this.resolveAuthorizedPath(file)
    if (!authorized.ok) return authorized
    const oldPath = authorized.data
    const parentDir = oldPath.includes('/') ? oldPath.substring(0, oldPath.lastIndexOf('/')) : ''
    const newPath = parentDir ? `${parentDir}/${newName}` : newName
    if (!this.isSafeDocumentsPath(newPath)) {
      return err('io_error', 'Invalid file name')
    }

    try {
      const { Filesystem, Directory } = await this.loadFilesystem()
      await Filesystem.rename({
        from: oldPath,
        to: newPath,
        directory: Directory.Documents,
        toDirectory: Directory.Documents,
      })

      const updatedFile: OneFSFile = {
        ...file,
        name: newName,
        path: newPath,
        mimeType: getMimeType(newName),
      }

      await this.storage.storeFile({
        id: updatedFile.id,
        name: updatedFile.name,
        path: updatedFile.path,
        content: updatedFile.content,
        mimeType: updatedFile.mimeType,
        size: updatedFile.size,
        lastModified: updatedFile.lastModified,
        storedAt: Date.now(),
      })
      this.registerSessionFile(updatedFile)

      return ok(updatedFile)
    } catch (e) {
      const error = e as Error
      if (error.message?.includes('not found') || error.message?.includes('does not exist')) {
        return err('not_found', 'File not found', e)
      }
      if (error.message?.includes('Permission denied')) {
        return err('permission_denied', 'Permission denied to rename file', e)
      }
      return err('io_error', error.message || 'Failed to rename file', e)
    }
  }

  async removeFromRecent(id: string): Promise<void> {
    await this.storage.removeFile(id)
    this.sessionPaths.delete(id)
  }

  async clearRecent(): Promise<void> {
    await this.storage.clearFiles()
    this.sessionPaths.clear()
  }

  dispose(): void {
    this.storage.dispose()
    this.sessionPaths.clear()
  }
}
