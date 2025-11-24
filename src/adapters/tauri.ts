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
import { generateId, getMimeType, getFileName } from '../utils'

type TauriDialog = typeof import('@tauri-apps/plugin-dialog')
type TauriFS = typeof import('@tauri-apps/plugin-fs')

export class TauriAdapter implements FSBridgeAdapter {
  platform = 'tauri' as const
  private storage: IDBStorage
  private dialog: TauriDialog | null = null
  private fs: TauriFS | null = null

  constructor(appName: string, maxRecentFiles = 10) {
    this.storage = new IDBStorage(appName, maxRecentFiles)
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

        await this.storage.storeFile({
          id,
          name,
          content,
          mimeType: getMimeType(name),
          lastModified: Date.now(),
          storedAt: Date.now(),
        })

        files.push({
          id,
          name,
          path,
          content,
          mimeType: getMimeType(name),
          lastModified: Date.now(),
        })
      }

      return ok(options.multiple ? files : files[0])
    } catch (e) {
      const error = e as Error
      return err('io_error', error.message || 'Failed to open file', e)
    }
  }

  async saveFile(
    file: FSBridgeFile,
    content: Uint8Array | string,
    _options?: FSBridgeSaveOptions
  ): Promise<FSBridgeResult<boolean>> {
    if (!file.path) {
      return err('not_supported', 'Cannot save file without path - use saveFileAs instead')
    }

    try {
      const { fs } = await this.loadModules()
      const contentArray = typeof content === 'string' ? new TextEncoder().encode(content) : content

      await fs.writeFile(file.path, contentArray)
      return ok(true)
    } catch (e) {
      const error = e as Error
      return err('io_error', error.message || 'Failed to save file', e)
    }
  }

  async saveFileAs(content: Uint8Array | string, options: FSBridgeSaveOptions = {}): Promise<FSBridgeResult<FSBridgeFile>> {
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

      await this.storage.storeFile({
        id,
        name,
        content: contentArray,
        mimeType: getMimeType(name),
        lastModified: Date.now(),
        storedAt: Date.now(),
      })

      return ok({
        id,
        name,
        path,
        content: contentArray,
        mimeType: getMimeType(name),
        lastModified: Date.now(),
      })
    } catch (e) {
      const error = e as Error
      return err('io_error', error.message || 'Failed to save file', e)
    }
  }

  async openDirectory(_options: FSBridgeDirectoryOptions = {}): Promise<FSBridgeResult<FSBridgeDirectory>> {
    try {
      const { dialog } = await this.loadModules()

      const path = await dialog.open({
        directory: true,
      })

      if (!path || Array.isArray(path)) {
        return err('cancelled', 'User cancelled directory picker')
      }

      const id = generateId()

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

  async readDirectory(directory: FSBridgeDirectory): Promise<FSBridgeResult<FSBridgeFile[]>> {
    if (!directory.path) {
      return err('not_supported', 'Cannot read directory without path')
    }

    try {
      const { fs } = await this.loadModules()
      const entries = await fs.readDir(directory.path)
      const files: FSBridgeFile[] = []

      for (const entry of entries) {
        if (!entry.isFile) continue

        const filePath = `${directory.path}/${entry.name}`
        const content = await fs.readFile(filePath)

        files.push({
          id: generateId(),
          name: entry.name,
          path: filePath,
          content,
          mimeType: getMimeType(entry.name),
          lastModified: Date.now(),
        })
      }

      return ok(files)
    } catch (e) {
      const error = e as Error
      return err('io_error', error.message || 'Failed to read directory', e)
    }
  }

  async getRecentFiles(): Promise<StoredHandle[]> {
    const files = await this.storage.getStoredFiles()
    return files.map((f) => ({
      id: f.id,
      name: f.name,
      type: 'file' as const,
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
      content: file.content,
      mimeType: file.mimeType,
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
