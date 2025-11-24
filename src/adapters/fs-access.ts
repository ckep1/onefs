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

function buildAcceptTypes(accept?: string[]): FilePickerAcceptType[] {
  if (!accept || accept.length === 0) return []

  const extensions = accept.filter((a) => a.startsWith('.'))
  if (extensions.length === 0) return []

  return [
    {
      description: 'Accepted files',
      accept: {
        '*/*': extensions,
      },
    },
  ]
}

export class FSAccessAdapter implements FSBridgeAdapter {
  platform = 'web-fs-access' as const
  private storage: IDBStorage
  private persistByDefault: boolean

  constructor(appName: string, maxRecentFiles = 10, persistByDefault = true) {
    this.storage = new IDBStorage(appName, maxRecentFiles)
    this.persistByDefault = persistByDefault
  }

  isSupported(): boolean {
    return 'showOpenFilePicker' in window
  }

  async openFile(options: FSBridgeOpenOptions = {}): Promise<FSBridgeFile | FSBridgeFile[] | null> {
    const shouldPersist = options.persist ?? this.persistByDefault

    try {
      const handles = await window.showOpenFilePicker({
        multiple: options.multiple ?? false,
        types: buildAcceptTypes(options.accept),
        startIn: options.startIn,
      })

      const files: FSBridgeFile[] = []

      for (const handle of handles) {
        const file = await handle.getFile()
        const content = new Uint8Array(await file.arrayBuffer())
        const id = generateId()

        if (shouldPersist) {
          await this.storage.storeHandle(handle, id)
        }

        files.push({
          id,
          name: handle.name,
          content,
          mimeType: file.type || getMimeType(handle.name),
          lastModified: file.lastModified,
          handle,
        })
      }

      return options.multiple ? files : files[0] ?? null
    } catch (err) {
      if ((err as Error).name === 'AbortError') return null
      throw err
    }
  }

  async saveFile(
    file: FSBridgeFile,
    content: Uint8Array | string,
    _options?: FSBridgeSaveOptions
  ): Promise<boolean> {
    if (!file.handle) return false

    try {
      const permission = await file.handle.queryPermission({ mode: 'readwrite' })
      if (permission !== 'granted') {
        const requested = await file.handle.requestPermission({ mode: 'readwrite' })
        if (requested !== 'granted') return false
      }

      const writable = await file.handle.createWritable()
      const data = typeof content === 'string' ? content : new Blob([content.buffer as ArrayBuffer])
      await writable.write(data)
      await writable.close()

      return true
    } catch (err) {
      if ((err as Error).name === 'AbortError') return false
      throw err
    }
  }

  async saveFileAs(content: Uint8Array | string, options: FSBridgeSaveOptions = {}): Promise<FSBridgeFile | null> {
    const shouldPersist = options.persist ?? this.persistByDefault

    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: options.suggestedName,
        types: buildAcceptTypes(options.accept),
        startIn: options.startIn,
      })

      const writable = await handle.createWritable()
      const data = typeof content === 'string' ? content : new Blob([content.buffer as ArrayBuffer])
      await writable.write(data)
      await writable.close()

      const id = generateId()
      if (shouldPersist) {
        await this.storage.storeHandle(handle, id)
      }

      const contentArray = typeof content === 'string' ? new TextEncoder().encode(content) : content

      return {
        id,
        name: handle.name,
        content: contentArray,
        mimeType: getMimeType(handle.name),
        lastModified: Date.now(),
        handle,
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return null
      throw err
    }
  }

  async openDirectory(options: FSBridgeDirectoryOptions = {}): Promise<FSBridgeDirectory | null> {
    try {
      const handle = await window.showDirectoryPicker({
        startIn: options.startIn,
        mode: options.mode ?? 'read',
      })

      const id = generateId()
      await this.storage.storeHandle(handle, id)

      return {
        id,
        name: handle.name,
        handle,
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return null
      throw err
    }
  }

  async readDirectory(directory: FSBridgeDirectory): Promise<FSBridgeFile[]> {
    if (!directory.handle) return []

    const files: FSBridgeFile[] = []

    for await (const entry of directory.handle.values()) {
      if (entry.kind === 'file') {
        const file = await entry.getFile()
        const content = new Uint8Array(await file.arrayBuffer())

        files.push({
          id: generateId(),
          name: entry.name,
          content,
          mimeType: file.type || getMimeType(entry.name),
          lastModified: file.lastModified,
          handle: entry,
        })
      }
    }

    return files
  }

  async getRecentFiles(): Promise<StoredHandle[]> {
    return this.storage.getStoredHandles()
  }

  async restoreFile(stored: StoredHandle): Promise<FSBridgeFile | null> {
    const handle = await this.storage.getHandleObject(stored.id)
    if (!handle || handle.kind !== 'file') return null

    const fileHandle = handle as FileSystemFileHandle

    const permission = await fileHandle.queryPermission({ mode: 'read' })
    if (permission !== 'granted') {
      const requested = await fileHandle.requestPermission({ mode: 'read' })
      if (requested !== 'granted') return null
    }

    const file = await fileHandle.getFile()
    const content = new Uint8Array(await file.arrayBuffer())

    return {
      id: stored.id,
      name: fileHandle.name,
      content,
      mimeType: file.type || getMimeType(fileHandle.name),
      lastModified: file.lastModified,
      handle: fileHandle,
    }
  }

  async removeFromRecent(id: string): Promise<void> {
    await this.storage.removeHandle(id)
  }

  async clearRecent(): Promise<void> {
    await this.storage.clearHandles()
  }
}
