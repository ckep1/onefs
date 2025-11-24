import type {
  FSBridgeAdapter,
  FSBridgeFile,
  FSBridgeOpenOptions,
  FSBridgeSaveOptions,
  StoredHandle,
  StoredFile,
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

export class PickerIDBAdapter implements FSBridgeAdapter {
  platform = 'web-fallback' as const
  private storage: IDBStorage
  private persistByDefault: boolean

  constructor(appName: string, maxRecentFiles = 10, persistByDefault = true) {
    this.storage = new IDBStorage(appName, maxRecentFiles)
    this.persistByDefault = persistByDefault
  }

  isSupported(): boolean {
    return typeof document !== 'undefined' && 'createElement' in document
  }

  async openFile(options: FSBridgeOpenOptions = {}): Promise<FSBridgeFile | FSBridgeFile[] | null> {
    const shouldPersist = options.persist ?? this.persistByDefault

    return new Promise((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.multiple = options.multiple ?? false

      if (options.accept?.length) {
        input.accept = options.accept.join(',')
      }

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

          if (shouldPersist) {
            const storedFile: StoredFile = {
              id,
              name: file.name,
              content,
              mimeType: file.type || getMimeType(file.name),
              lastModified: file.lastModified,
              storedAt: Date.now(),
            }
            await this.storage.storeFile(storedFile)
          }

          files.push({
            id,
            name: file.name,
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
    options?: FSBridgeSaveOptions
  ): Promise<boolean> {
    const shouldPersist = options?.persist ?? this.persistByDefault
    const contentArray = typeof content === 'string' ? new TextEncoder().encode(content) : content

    if (shouldPersist) {
      const storedFile: StoredFile = {
        id: file.id,
        name: file.name,
        content: contentArray,
        mimeType: file.mimeType,
        lastModified: Date.now(),
        storedAt: Date.now(),
      }
      await this.storage.storeFile(storedFile)
    }

    this.triggerDownload(file.name, contentArray, file.mimeType)
    return true
  }

  async saveFileAs(content: Uint8Array | string, options: FSBridgeSaveOptions = {}): Promise<FSBridgeFile | null> {
    const shouldPersist = options.persist ?? this.persistByDefault
    const contentArray = typeof content === 'string' ? new TextEncoder().encode(content) : content
    const name = options.suggestedName ?? 'untitled'
    const mimeType = getMimeType(name)
    const id = generateId()

    if (shouldPersist) {
      const storedFile: StoredFile = {
        id,
        name,
        content: contentArray,
        mimeType,
        lastModified: Date.now(),
        storedAt: Date.now(),
      }
      await this.storage.storeFile(storedFile)
    }

    this.triggerDownload(name, contentArray, mimeType)

    return {
      id,
      name,
      content: contentArray,
      mimeType,
      lastModified: Date.now(),
    }
  }

  private triggerDownload(name: string, content: Uint8Array, mimeType: string): void {
    const blob = new Blob([content.buffer as ArrayBuffer], { type: mimeType })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
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
