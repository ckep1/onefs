import type { StoredHandle, StoredFile } from '../types'

const DB_VERSION = 2
const PRUNE_BUFFER = 5

export class IDBStorage {
  private dbName: string
  private db: IDBDatabase | null = null
  private dbPromise: Promise<IDBDatabase> | null = null
  private maxRecentFiles: number
  private maxCacheSize: number
  /** Called with the records evicted by pruning, so adapters can clean up backing resources */
  onFilesPruned?: (files: StoredFile[]) => void

  constructor(appName: string, maxRecentFiles = 10, maxCacheSize = 50 * 1024 * 1024) {
    if (!appName || !/^[\w.\-]+$/.test(appName)) {
      throw new Error(`Invalid appName: must be non-empty and contain only alphanumeric, hyphens, underscores, or dots`)
    }
    this.dbName = `onefs-${appName}`
    this.maxRecentFiles = maxRecentFiles
    this.maxCacheSize = maxCacheSize
  }

  private getDB(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise

    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, DB_VERSION)

      request.onerror = () => {
        this.dbPromise = null
        reject(request.error)
      }
      request.onsuccess = () => {
        this.db = request.result
        resolve(this.db)
      }

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result

        if (!db.objectStoreNames.contains('handles')) {
          const handleStore = db.createObjectStore('handles', { keyPath: 'id' })
          handleStore.createIndex('storedAt', 'storedAt', { unique: false })
        }

        if (!db.objectStoreNames.contains('files')) {
          const fileStore = db.createObjectStore('files', { keyPath: 'id' })
          fileStore.createIndex('storedAt', 'storedAt', { unique: false })
        }

        if (!db.objectStoreNames.contains('handleObjects')) {
          db.createObjectStore('handleObjects', { keyPath: 'id' })
        }

        if (!db.objectStoreNames.contains('namedHandles')) {
          db.createObjectStore('namedHandles', { keyPath: 'key' })
        }
      }
    })
    return this.dbPromise
  }

  async storeHandle(
    handle: FileSystemFileHandle | FileSystemDirectoryHandle,
    id: string,
    path?: string
  ): Promise<StoredHandle> {
    const db = await this.getDB()
    const storedHandle: StoredHandle = {
      id,
      name: handle.name,
      path,
      type: handle.kind === 'file' ? 'file' : 'directory',
      storedAt: Date.now(),
    }

    return new Promise((resolve, reject) => {
      const tx = db.transaction(['handles', 'handleObjects'], 'readwrite')
      tx.onerror = () => reject(tx.error)

      const handleStore = tx.objectStore('handles')
      const objectStore = tx.objectStore('handleObjects')

      handleStore.put(storedHandle)
      objectStore.put({ id, handle })

      tx.oncomplete = () => {
        this.pruneOldHandles().catch(() => {})
        resolve(storedHandle)
      }
    })
  }

  async getStoredHandles(): Promise<StoredHandle[]> {
    const db = await this.getDB()

    return new Promise((resolve, reject) => {
      const tx = db.transaction('handles', 'readonly')
      const store = tx.objectStore('handles')
      const index = store.index('storedAt')
      const request = index.getAll()

      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const handles = request.result as StoredHandle[]
        resolve(handles.sort((a, b) => b.storedAt - a.storedAt))
      }
    })
  }

  async getHandleObject(id: string): Promise<FileSystemFileHandle | FileSystemDirectoryHandle | null> {
    const db = await this.getDB()

    return new Promise((resolve, reject) => {
      const tx = db.transaction('handleObjects', 'readonly')
      const store = tx.objectStore('handleObjects')
      const request = store.get(id)

      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const result = request.result as { id: string; handle: FileSystemFileHandle | FileSystemDirectoryHandle } | undefined
        resolve(result?.handle ?? null)
      }
    })
  }

  async removeHandle(id: string): Promise<void> {
    const db = await this.getDB()

    return new Promise((resolve, reject) => {
      const tx = db.transaction(['handles', 'handleObjects'], 'readwrite')
      tx.onerror = () => reject(tx.error)

      tx.objectStore('handles').delete(id)
      tx.objectStore('handleObjects').delete(id)

      tx.oncomplete = () => resolve()
    })
  }

  async clearHandles(): Promise<void> {
    const db = await this.getDB()

    return new Promise((resolve, reject) => {
      const tx = db.transaction(['handles', 'handleObjects'], 'readwrite')
      tx.onerror = () => reject(tx.error)

      tx.objectStore('handles').clear()
      tx.objectStore('handleObjects').clear()

      tx.oncomplete = () => resolve()
    })
  }

  private async pruneOldHandles(): Promise<void> {
    const handles = await this.getStoredHandles()
    if (handles.length <= this.maxRecentFiles + PRUNE_BUFFER) return

    const toRemove = handles.slice(this.maxRecentFiles)
    const db = await this.getDB()
    const tx = db.transaction(['handles', 'handleObjects'], 'readwrite')
    const handleStore = tx.objectStore('handles')
    const objectStore = tx.objectStore('handleObjects')
    for (const handle of toRemove) {
      handleStore.delete(handle.id)
      objectStore.delete(handle.id)
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  }

  async storeFile(file: StoredFile): Promise<void> {
    let toStore = file
    if (file.content.byteLength > this.maxCacheSize) {
      // Too large to cache. With a path the metadata record is still kept
      // (content is re-read from disk on restore); without one there is
      // nothing to restore from, so skip entirely.
      if (!file.path) return
      toStore = { ...file, content: new Uint8Array(0) }
    }

    const db = await this.getDB()

    return new Promise((resolve, reject) => {
      const tx = db.transaction('files', 'readwrite')
      tx.onerror = () => reject(tx.error)

      const store = tx.objectStore('files')
      store.put(toStore)

      tx.oncomplete = () => {
        this.pruneOldFiles().catch(() => {})
        resolve()
      }
    })
  }

  /**
   * Update name/path/mimeType on an existing record without touching its
   * cached content. No-op (returns false) when the record does not exist.
   */
  async updateFileMetadata(
    id: string,
    updates: { name?: string; path?: string; mimeType?: string }
  ): Promise<boolean> {
    const existing = await this.getStoredFile(id)
    if (!existing) return false

    const db = await this.getDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('files', 'readwrite')
      tx.onerror = () => reject(tx.error)

      tx.objectStore('files').put({ ...existing, ...updates, storedAt: Date.now() })

      tx.oncomplete = () => resolve(true)
    })
  }

  storeFileDeferred(file: StoredFile): void {
    queueMicrotask(() => {
      this.storeFile(file).catch(() => {})
    })
  }

  async getStoredFile(id: string): Promise<StoredFile | null> {
    const db = await this.getDB()

    return new Promise((resolve, reject) => {
      const tx = db.transaction('files', 'readonly')
      const store = tx.objectStore('files')
      const request = store.get(id)

      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result ?? null)
    })
  }

  async removeFile(id: string): Promise<void> {
    const db = await this.getDB()

    return new Promise((resolve, reject) => {
      const tx = db.transaction('files', 'readwrite')
      tx.onerror = () => reject(tx.error)

      tx.objectStore('files').delete(id)

      tx.oncomplete = () => resolve()
    })
  }

  async getStoredFiles(): Promise<StoredFile[]> {
    const db = await this.getDB()

    return new Promise((resolve, reject) => {
      const tx = db.transaction('files', 'readonly')
      const store = tx.objectStore('files')
      const index = store.index('storedAt')
      const request = index.getAll()

      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const files = request.result as StoredFile[]
        resolve(files.sort((a, b) => b.storedAt - a.storedAt))
      }
    })
  }

  async clearFiles(): Promise<void> {
    const db = await this.getDB()

    return new Promise((resolve, reject) => {
      const tx = db.transaction('files', 'readwrite')
      tx.onerror = () => reject(tx.error)

      tx.objectStore('files').clear()

      tx.oncomplete = () => resolve()
    })
  }

  private async pruneOldFiles(): Promise<void> {
    const files = await this.getStoredFiles()
    if (files.length <= this.maxRecentFiles + PRUNE_BUFFER) return

    const toRemove = files.slice(this.maxRecentFiles)
    const db = await this.getDB()
    const tx = db.transaction('files', 'readwrite')
    const store = tx.objectStore('files')
    for (const file of toRemove) {
      store.delete(file.id)
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    if (toRemove.length > 0) {
      this.onFilesPruned?.(toRemove)
    }
  }

  async setNamedHandle(
    key: string,
    handle: FileSystemFileHandle | FileSystemDirectoryHandle
  ): Promise<void> {
    const db = await this.getDB()

    return new Promise((resolve, reject) => {
      const tx = db.transaction('namedHandles', 'readwrite')
      tx.onerror = () => reject(tx.error)

      tx.objectStore('namedHandles').put({
        key,
        handle,
        name: handle.name,
        type: handle.kind,
        storedAt: Date.now(),
      })

      tx.oncomplete = () => resolve()
    })
  }

  async getNamedHandle(key: string): Promise<{
    handle: FileSystemFileHandle | FileSystemDirectoryHandle
    name: string
    type: 'file' | 'directory'
  } | null> {
    const db = await this.getDB()

    return new Promise((resolve, reject) => {
      const tx = db.transaction('namedHandles', 'readonly')
      const request = tx.objectStore('namedHandles').get(key)

      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const result = request.result
        if (!result) {
          resolve(null)
        } else {
          resolve({
            handle: result.handle,
            name: result.name,
            type: result.type,
          })
        }
      }
    })
  }

  async removeNamedHandle(key: string): Promise<void> {
    const db = await this.getDB()

    return new Promise((resolve, reject) => {
      const tx = db.transaction('namedHandles', 'readwrite')
      tx.onerror = () => reject(tx.error)

      tx.objectStore('namedHandles').delete(key)

      tx.oncomplete = () => resolve()
    })
  }

  dispose(): void {
    if (this.db) {
      this.db.close()
      this.db = null
    }
    this.dbPromise = null
  }
}
