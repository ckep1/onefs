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

type CapacitorFilesystem = typeof import('@capacitor/filesystem')

export class CapacitorAdapter implements FSBridgeAdapter {
  platform = 'capacitor' as const
  private storage: IDBStorage
  private filesystem: CapacitorFilesystem | null = null

  constructor(appName: string, maxRecentFiles = 10) {
    this.storage = new IDBStorage(appName, maxRecentFiles)
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

            await this.storage.storeFile({
              id,
              name: file.name,
              content,
              mimeType: file.type || getMimeType(file.name),
              lastModified: file.lastModified,
              storedAt: Date.now(),
            })

            files.push({
              id,
              name: file.name,
              path: `fsbridge_${id}_${file.name}`,
              content,
              mimeType: file.type || getMimeType(file.name),
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

  async saveFile(
    file: FSBridgeFile,
    content: Uint8Array | string,
    _options?: FSBridgeSaveOptions
  ): Promise<FSBridgeResult<boolean>> {
    try {
      const { Filesystem, Directory } = await this.loadModule()

      const contentArray = typeof content === 'string' ? new TextEncoder().encode(content) : content
      const fileName = file.path ?? `fsbridge_${file.id}_${file.name}`

      await Filesystem.writeFile({
        path: fileName,
        data: new Blob([contentArray.buffer as ArrayBuffer]),
        directory: Directory.Data,
      })

      await this.storage.storeFile({
        id: file.id,
        name: file.name,
        content: contentArray,
        mimeType: file.mimeType,
        lastModified: Date.now(),
        storedAt: Date.now(),
      })

      return ok(true)
    } catch (e) {
      const error = e as Error
      return err('io_error', error.message || 'Failed to save file', e)
    }
  }

  async saveFileAs(content: Uint8Array | string, options: FSBridgeSaveOptions = {}): Promise<FSBridgeResult<FSBridgeFile>> {
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
        path: fileName,
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
      const { Filesystem, Directory } = await this.loadModule()

      const result = await Filesystem.readdir({
        path: '',
        directory: Directory.Documents,
      })

      if (!result) {
        return err('io_error', 'Failed to read directory')
      }

      const id = generateId()
      return ok({
        id,
        name: 'Documents',
        path: '',
      })
    } catch (e) {
      const error = e as Error
      return err('io_error', error.message || 'Failed to open directory', e)
    }
  }

  async readDirectory(directory: FSBridgeDirectory): Promise<FSBridgeResult<FSBridgeFile[]>> {
    try {
      const { Filesystem, Directory } = await this.loadModule()

      const result = await Filesystem.readdir({
        path: directory.path ?? '',
        directory: Directory.Documents,
      })

      const files: FSBridgeFile[] = []

      for (const entry of result.files) {
        if (entry.type === 'directory') continue

        try {
          const filePath = directory.path ? `${directory.path}/${entry.name}` : entry.name
          const fileData = await Filesystem.readFile({
            path: filePath,
            directory: Directory.Documents,
          })

          let content: Uint8Array
          if (fileData.data instanceof Blob) {
            content = new Uint8Array(await fileData.data.arrayBuffer())
          } else {
            const binary = atob(fileData.data as string)
            content = new Uint8Array(binary.length)
            for (let i = 0; i < binary.length; i++) {
              content[i] = binary.charCodeAt(i)
            }
          }

          files.push({
            id: generateId(),
            name: entry.name,
            path: filePath,
            content,
            mimeType: getMimeType(entry.name),
            lastModified: entry.mtime ?? Date.now(),
          })
        } catch {
          continue
        }
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
