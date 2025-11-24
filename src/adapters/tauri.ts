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

  async openFile(options: FSBridgeOpenOptions = {}): Promise<FSBridgeFile | FSBridgeFile[] | null> {
    const { dialog, fs } = await this.loadModules()

    const filters =
      options.accept?.length
        ? [{ name: 'Accepted files', extensions: options.accept.map((a) => a.replace('.', '')) }]
        : undefined

    const result = await dialog.open({
      multiple: options.multiple ?? false,
      filters,
    })

    if (!result) return null

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

    return options.multiple ? files : files[0] ?? null
  }

  async saveFile(
    file: FSBridgeFile,
    content: Uint8Array | string,
    _options?: FSBridgeSaveOptions
  ): Promise<boolean> {
    if (!file.path) return false

    const { fs } = await this.loadModules()
    const contentArray = typeof content === 'string' ? new TextEncoder().encode(content) : content

    await fs.writeFile(file.path, contentArray)
    return true
  }

  async saveFileAs(content: Uint8Array | string, options: FSBridgeSaveOptions = {}): Promise<FSBridgeFile | null> {
    const { dialog, fs } = await this.loadModules()

    const filters =
      options.accept?.length
        ? [{ name: 'Accepted files', extensions: options.accept.map((a) => a.replace('.', '')) }]
        : undefined

    const path = await dialog.save({
      defaultPath: options.suggestedName,
      filters,
    })

    if (!path) return null

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

    return {
      id,
      name,
      path,
      content: contentArray,
      mimeType: getMimeType(name),
      lastModified: Date.now(),
    }
  }

  async openDirectory(_options: FSBridgeDirectoryOptions = {}): Promise<FSBridgeDirectory | null> {
    const { dialog } = await this.loadModules()

    const path = await dialog.open({
      directory: true,
    })

    if (!path || Array.isArray(path)) return null

    const id = generateId()

    return {
      id,
      name: getFileName(path),
      path,
    }
  }

  async readDirectory(directory: FSBridgeDirectory): Promise<FSBridgeFile[]> {
    if (!directory.path) return []

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
