import type { StoredHandle, StoredFile } from '../types'

const DB_VERSION = 2

/**
 * IndexedDB storage manager for file handles and content.
 * Handles persistence of File System Access API handles and file content fallback.
 */
export class IDBStorage {
  private dbName: string
  private db: IDBDatabase | null = null
  private maxRecentFiles: number

  constructor(appName: string, maxRecentFiles = 10) {
    this.dbName = `fsbridge-${appName}`
    this.maxRecentFiles = maxRecentFiles
  }

  private async getDB(): Promise<IDBDatabase> {
    if (this.db) return this.db

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, DB_VERSION)

      request.onerror = () => reject(request.error)
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
  }

  /**
   * Store a File System Access API handle for later restoration.
   * Also stores metadata for listing recent files.
   */
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

      tx.oncomplete = async () => {
        await this.pruneOldHandles()
        resolve(storedHandle)
      }
    })
  }

  /**
   * Get all stored handle metadata, sorted by most recent first.
   */
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

  /**
   * Get the actual FileSystemHandle object by ID.
   * Returns null if not found (e.g., on non-FSA platforms).
   */
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

  /**
   * Remove a handle and its metadata from storage.
   */
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

  /**
   * Clear all stored handles.
   */
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

  /**
   * Remove oldest handles if count exceeds maxRecentFiles.
   */
  private async pruneOldHandles(): Promise<void> {
    const handles = await this.getStoredHandles()
    if (handles.length <= this.maxRecentFiles) return

    const toRemove = handles.slice(this.maxRecentFiles)
    for (const handle of toRemove) {
      await this.removeHandle(handle.id)
    }
  }

  /**
   * Store file content in IndexedDB (for fallback/Tauri/Capacitor platforms).
   * Automatically prunes old files to stay within maxRecentFiles limit.
   */
  async storeFile(file: StoredFile): Promise<void> {
    const db = await this.getDB()

    return new Promise((resolve, reject) => {
      const tx = db.transaction('files', 'readwrite')
      tx.onerror = () => reject(tx.error)

      const store = tx.objectStore('files')
      store.put(file)

      tx.oncomplete = async () => {
        await this.pruneOldFiles()
        resolve()
      }
    })
  }

  /**
   * Get a stored file by ID.
   */
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

  /**
   * Remove a file from storage.
   */
  async removeFile(id: string): Promise<void> {
    const db = await this.getDB()

    return new Promise((resolve, reject) => {
      const tx = db.transaction('files', 'readwrite')
      tx.onerror = () => reject(tx.error)

      tx.objectStore('files').delete(id)

      tx.oncomplete = () => resolve()
    })
  }

  /**
   * Get all stored files, sorted by most recent first.
   */
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

  /**
   * Clear all stored files.
   */
  async clearFiles(): Promise<void> {
    const db = await this.getDB()

    return new Promise((resolve, reject) => {
      const tx = db.transaction('files', 'readwrite')
      tx.onerror = () => reject(tx.error)

      tx.objectStore('files').clear()

      tx.oncomplete = () => resolve()
    })
  }

  /**
   * Remove oldest files if count exceeds maxRecentFiles.
   */
  private async pruneOldFiles(): Promise<void> {
    const files = await this.getStoredFiles()
    if (files.length <= this.maxRecentFiles) return

    const toRemove = files.slice(this.maxRecentFiles)
    for (const file of toRemove) {
      await this.removeFile(file.id)
    }
  }

  /**
   * Store a handle by a named key (separate from recent files).
   * Useful for app preferences like "output directory".
   */
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

  /**
   * Get a named handle by key.
   */
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

  /**
   * Remove a named handle.
   */
  async removeNamedHandle(key: string): Promise<void> {
    const db = await this.getDB()

    return new Promise((resolve, reject) => {
      const tx = db.transaction('namedHandles', 'readwrite')
      tx.onerror = () => reject(tx.error)

      tx.objectStore('namedHandles').delete(key)

      tx.oncomplete = () => resolve()
    })
  }
}
