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
  OneFSReadRangeOptions,
  OneFSFileRange,
  StoredHandle,
  StoredFile,
  OneFSResult,
} from '../types'
import { ok, err } from '../types'
import { IDBStorage } from '../storage/idb'
import { generateId, getMimeType, base64ToUint8Array, uint8ArrayToBase64, toArrayBuffer, sanitizeFileName, isPathWithin, isSafeEntryName, pickFilesViaInput, invalidRangeReason, parseContentRangeSize } from '../utils'

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
    this.storage.onFilesPruned = (files) => {
      void this.removePrunedCopies(files)
    }
    this.persistByDefault = persistByDefault
  }

  isSupported(): boolean {
    if (typeof window === 'undefined') return false
    const cap = (window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
    return cap?.isNativePlatform?.() ?? false
  }

  /**
   * Delete the Documents copies backing pruned records so they don't
   * accumulate as orphans on disk.
   */
  private async removePrunedCopies(files: StoredFile[]): Promise<void> {
    try {
      const { Filesystem, Directory } = await this.loadFilesystem()
      for (const f of files) {
        if (!f.path || f.mimeType === DIRECTORY_MIME_TYPE || !this.isSafeDocumentsPath(f.path)) continue
        await Filesystem.deleteFile({ path: f.path, directory: Directory.Documents }).catch(() => {})
      }
    } catch {
      // Filesystem module unavailable
    }
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

    // Session paths first: after a rename the stored record can lag behind
    // (metadata updates are best-effort), but the session map is authoritative
    const livePath = this.sessionPaths.get(file.id)
    if (livePath === requestedPath) {
      return ok(requestedPath)
    }

    try {
      const stored = await this.storage.getStoredFile(file.id)
      if (stored?.path === requestedPath) {
        return ok(requestedPath)
      }

      return err('permission_denied', 'File was not opened through this adapter')
    } catch (e) {
      return err('io_error', 'Failed to verify file provenance', e)
    }
  }

  async openFile(options: OneFSOpenOptions = {}): Promise<OneFSResult<OneFSFile | OneFSFile[]>> {
    const shouldPersist = options.persist ?? this.persistByDefault

    const pluginResult = await this.pickFilesWithPlugin(options)
    if (pluginResult) {
      if (!pluginResult.ok) return pluginResult
      const files = pluginResult.data
      for (const file of files) {
        this.registerSessionFile(file)
        if (shouldPersist) {
          this.storage.storeFileDeferred({ ...file, storedAt: Date.now() })
        }
      }
      return ok(options.multiple ? files : files[0])
    }

    return this.pickFilesWithInput(options, shouldPersist)
  }

  /**
   * Pick via @capawesome/capacitor-file-picker. Returns null only when the
   * plugin is not installed; once the picker has run, errors (including user
   * cancellation) are returned as results rather than falling back to the
   * HTML input, which would open a second picker.
   */
  private async pickFilesWithPlugin(options: OneFSOpenOptions): Promise<OneFSResult<OneFSFile[]> | null> {
    let FilePicker: FilePicker
    try {
      const module = await import('@capawesome/capacitor-file-picker' as string) as { FilePicker: FilePicker }
      FilePicker = module.FilePicker
      if (!FilePicker) return null
    } catch {
      return null
    }

    try {
      const { Filesystem, Directory } = await this.loadFilesystem()

      const types = options.accept
        ? [...new Set(options.accept.map(ext => getMimeType(ext)))]
        : ['*/*']

      const result = await FilePicker.pickFiles({
        types,
        multiple: options.multiple ?? false,
        readData: false,
      })

      if (result.files.length === 0) {
        return err('cancelled', 'No files selected')
      }

      const fileResults = await Promise.all(
        result.files.map(async (picked) => {
          const id = generateId()
          const safeName = sanitizeFileName(picked.name)
          const destPath = `${id}_${safeName}`

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

      return ok(fileResults)
    } catch (e) {
      const error = e as Error
      if (error.message?.toLowerCase().includes('cancel')) {
        return err('cancelled', 'User cancelled file picker')
      }
      return err('io_error', error.message || 'Failed to open file', e)
    }
  }

  private async pickFilesWithInput(
    options: OneFSOpenOptions,
    shouldPersist: boolean
  ): Promise<OneFSResult<OneFSFile | OneFSFile[]>> {
    const fileList = await pickFilesViaInput({
      accept: options.accept?.join(',') ?? '*/*',
      multiple: options.multiple ?? false,
    })
    if (!fileList) {
      return err('cancelled', 'User cancelled file picker')
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

      return ok(options.multiple ? filesOut : filesOut[0])
    } catch (e) {
      const error = e as Error
      return err('io_error', error.message || 'Failed to read file', e)
    }
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

  /**
   * Validate that an entry can be read: it must be a file, sit inside the
   * Documents sandbox, and stay within the directory it was listed from.
   */
  private resolveEntryPath(directory: OneFSDirectory, entry: OneFSEntry): OneFSResult<string> {
    if (!entry.path || entry.kind !== 'file') {
      return err('not_supported', 'Cannot read file without path')
    }

    if (!this.isSafeDocumentsPath(entry.path)) {
      return err('permission_denied', 'Invalid file path')
    }

    if (directory.path && !isPathWithin(entry.path, directory.path)) {
      return err('permission_denied', 'Path is outside the expected directory')
    }

    return ok(entry.path)
  }

  /**
   * Resolve a Documents-relative path to a URL the webview can fetch.
   */
  private async getNativeUrl(path: string): Promise<string> {
    const { Filesystem, Directory } = await this.loadFilesystem()
    const { Capacitor } = await this.loadCore()

    const uri = await Filesystem.getUri({ path, directory: Directory.Documents })
    return Capacitor.convertFileSrc(uri.uri)
  }

  /**
   * Stream a file's bytes through the webview instead of the base64 Filesystem
   * bridge, which costs roughly 4x the file size in transient memory. Returns
   * null when the webview route is unavailable (no `fetch`, no asset server)
   * so callers can fall back to `Filesystem.readFile`.
   */
  private async fetchFileBytes(path: string): Promise<Uint8Array | null> {
    try {
      const response = await fetch(await this.getNativeUrl(path))
      if (!response.ok) return null
      return new Uint8Array(await response.arrayBuffer())
    } catch {
      return null
    }
  }

  async readFileFromDirectory(
    directory: OneFSDirectory,
    entry: OneFSEntry,
    options?: { maxBytes?: number }
  ): Promise<OneFSResult<OneFSFile>> {
    const resolved = this.resolveEntryPath(directory, entry)
    if (!resolved.ok) return resolved
    const path = resolved.data

    try {
      const { Filesystem, Directory } = await this.loadFilesystem()

      if (options?.maxBytes && entry.size && entry.size > options.maxBytes) {
        const nativeUrl = await this.getNativeUrl(path)

        const response = await fetch(nativeUrl, {
          headers: { Range: `bytes=0-${options.maxBytes - 1}` }
        })

        if (response.ok || response.status === 206) {
          const arrayBuffer = await response.arrayBuffer()
          const content = new Uint8Array(arrayBuffer)
          const partialFile: OneFSFile = {
            id: generateId(),
            name: entry.name,
            path,
            content,
            mimeType: getMimeType(entry.name),
            size: content.byteLength,
            lastModified: entry.lastModified ?? Date.now(),
          }
          this.registerSessionFile(partialFile)

          return ok(partialFile)
        }
      }

      let content = await this.fetchFileBytes(path)

      if (!content) {
        const fileData = await Filesystem.readFile({
          path,
          directory: Directory.Documents,
        })

        content = fileData.data instanceof Blob
          ? new Uint8Array(await fileData.data.arrayBuffer())
          : base64ToUint8Array(fileData.data as string)
      }

      const loadedFile: OneFSFile = {
        id: generateId(),
        name: entry.name,
        path,
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

  /**
   * Read a byte window over the webview's asset server, so only the requested
   * bytes cross the bridge. There is no base64 fallback here on purpose: that
   * path would read the entire file, which is what this API exists to avoid.
   */
  async readFileRange(
    directory: OneFSDirectory,
    entry: OneFSEntry,
    options: OneFSReadRangeOptions
  ): Promise<OneFSResult<OneFSFileRange>> {
    const resolved = this.resolveEntryPath(directory, entry)
    if (!resolved.ok) return resolved

    const invalid = invalidRangeReason(options.position, options.length)
    if (invalid) return err('io_error', `Invalid range: ${invalid}`)

    if (options.length === 0) {
      return ok({ content: new Uint8Array(0) })
    }

    try {
      const nativeUrl = await this.getNativeUrl(resolved.data)
      const end = options.position + options.length - 1

      const response = await fetch(nativeUrl, {
        headers: { Range: `bytes=${options.position}-${end}` },
      })

      if (response.status === 206) {
        const content = new Uint8Array(await response.arrayBuffer())
        return ok({ content, fileSize: parseContentRangeSize(response.headers?.get('Content-Range')) })
      }

      // Requested range starts past EOF
      if (response.status === 416) {
        return ok({ content: new Uint8Array(0) })
      }

      if (response.ok) {
        // Range header ignored - slice the window out of the full body.
        // Correctness over efficiency; the whole file crossed the bridge.
        const body = new Uint8Array(await response.arrayBuffer())
        return ok({
          content: body.slice(options.position, options.position + options.length),
          fileSize: body.byteLength,
        })
      }

      if (response.status === 404) {
        return err('not_found', 'File not found')
      }

      return err('io_error', `Failed to read range (HTTP ${response.status})`)
    } catch (e) {
      const error = e as Error
      return err('io_error', error.message || 'Failed to read range', e)
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

      // Update the stored record's metadata without rewriting cached content
      // (the in-memory file.content may be stale). Best-effort: the disk
      // rename already succeeded.
      await this.storage
        .updateFileMetadata(file.id, { name: newName, path: newPath, mimeType: updatedFile.mimeType })
        .catch(() => {})
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
