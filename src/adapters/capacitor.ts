import type {
  FSBridgeAdapter,
  FSBridgeFile,
  FSBridgeOpenOptions,
  FSBridgeSaveOptions,
  FSBridgeDirectory,
  FSBridgeDirectoryOptions,
  StoredHandle,
} from '../types'
import { IDBStorage } from '../storage/idb'

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
}

function getMimeType(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase()
  const mimeTypes: Record<string, string> = {
    txt: 'text/plain',
    json: 'application/json',
    js: 'text/javascript',
    ts: 'text/typescript',
    html: 'text/html',
    css: 'text/css',
    md: 'text/markdown',
    xml: 'application/xml',
    csv: 'text/csv',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    pdf: 'application/pdf',
    zip: 'application/zip',
  }
  return mimeTypes[ext ?? ''] ?? 'application/octet-stream'
}

function getFileName(path: string): string {
  return path.split('/').pop() ?? path.split('\\').pop() ?? path
}

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

  async openFile(options: FSBridgeOpenOptions = {}): Promise<FSBridgeFile | FSBridgeFile[] | null> {
    const { Filesystem, Directory, Encoding } = await this.loadModule()

    const accept = options.accept?.join(',') ?? '*/*'
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.multiple = options.multiple ?? false

    return new Promise((resolve) => {
      input.onchange = async () => {
        const fileList = input.files
        if (!fileList || fileList.length === 0) {
          resolve(null)
          return
        }

        const files: FSBridgeFile[] = []

        for (let i = 0; i < fileList.length; i++) {
          const file = fileList[i]
          const content = new Uint8Array(await file.arrayBuffer())
          const id = generateId()
          const fileName = `fsbridge_${id}_${file.name}`

          await Filesystem.writeFile({
            path: fileName,
            data: btoa(String.fromCharCode(...content)),
            directory: Directory.Data,
            encoding: Encoding.UTF8,
          })

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
            path: fileName,
            content,
            mimeType: file.type || getMimeType(file.name),
            lastModified: file.lastModified,
          })
        }

        resolve(options.multiple ? files : files[0] ?? null)
      }

      input.oncancel = () => resolve(null)
      input.click()
    })
  }

  async saveFile(
    file: FSBridgeFile,
    content: Uint8Array | string,
    _options?: FSBridgeSaveOptions
  ): Promise<boolean> {
    const { Filesystem, Directory, Encoding } = await this.loadModule()

    const contentArray = typeof content === 'string' ? new TextEncoder().encode(content) : content
    const fileName = file.path ?? `fsbridge_${file.id}_${file.name}`

    await Filesystem.writeFile({
      path: fileName,
      data: btoa(String.fromCharCode(...contentArray)),
      directory: Directory.Data,
      encoding: Encoding.UTF8,
    })

    await this.storage.storeFile({
      id: file.id,
      name: file.name,
      content: contentArray,
      mimeType: file.mimeType,
      lastModified: Date.now(),
      storedAt: Date.now(),
    })

    return true
  }

  async saveFileAs(content: Uint8Array | string, options: FSBridgeSaveOptions = {}): Promise<FSBridgeFile | null> {
    const { Filesystem, Directory, Encoding } = await this.loadModule()

    const contentArray = typeof content === 'string' ? new TextEncoder().encode(content) : content
    const name = options.suggestedName ?? 'untitled'
    const id = generateId()
    const fileName = `fsbridge_${id}_${name}`

    await Filesystem.writeFile({
      path: fileName,
      data: btoa(String.fromCharCode(...contentArray)),
      directory: Directory.Data,
      encoding: Encoding.UTF8,
    })

    await this.storage.storeFile({
      id,
      name,
      content: contentArray,
      mimeType: getMimeType(name),
      lastModified: Date.now(),
      storedAt: Date.now(),
    })

    return {
      id,
      name,
      path: fileName,
      content: contentArray,
      mimeType: getMimeType(name),
      lastModified: Date.now(),
    }
  }

  async openDirectory(_options: FSBridgeDirectoryOptions = {}): Promise<FSBridgeDirectory | null> {
    const { Filesystem, Directory } = await this.loadModule()

    try {
      const result = await Filesystem.readdir({
        path: '',
        directory: Directory.Documents,
      })

      if (!result) return null

      const id = generateId()
      return {
        id,
        name: 'Documents',
        path: '',
      }
    } catch {
      return null
    }
  }

  async readDirectory(directory: FSBridgeDirectory): Promise<FSBridgeFile[]> {
    const { Filesystem, Directory, Encoding } = await this.loadModule()

    const result = await Filesystem.readdir({
      path: directory.path ?? '',
      directory: Directory.Documents,
    })

    const files: FSBridgeFile[] = []

    for (const entry of result.files) {
      if (entry.type === 'directory') continue

      try {
        const fileData = await Filesystem.readFile({
          path: `${directory.path}/${entry.name}`,
          directory: Directory.Documents,
          encoding: Encoding.UTF8,
        })

        const content = Uint8Array.from(atob(fileData.data as string), (c) => c.charCodeAt(0))

        files.push({
          id: generateId(),
          name: entry.name,
          path: `${directory.path}/${entry.name}`,
          content,
          mimeType: getMimeType(entry.name),
          lastModified: entry.mtime ?? Date.now(),
        })
      } catch {
        continue
      }
    }

    return files
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

  async restoreFile(stored: StoredHandle): Promise<FSBridgeFile | null> {
    const file = await this.storage.getStoredFile(stored.id)
    if (!file) return null

    return {
      id: file.id,
      name: file.name,
      content: file.content,
      mimeType: file.mimeType,
      lastModified: file.lastModified,
    }
  }

  async removeFromRecent(id: string): Promise<void> {
    await this.storage.removeFile(id)
  }

  async clearRecent(): Promise<void> {
    await this.storage.clearFiles()
  }
}
