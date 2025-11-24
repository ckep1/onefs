import type { StoredHandle, StoredFile } from '../types'

const DB_VERSION = 1

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
      }
    })
  }

  async storeHandle(handle: FileSystemFileHandle | FileSystemDirectoryHandle, id: string): Promise<StoredHandle> {
    const db = await this.getDB()
    const storedHandle: StoredHandle = {
      id,
      name: handle.name,
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
    if (handles.length <= this.maxRecentFiles) return

    const toRemove = handles.slice(this.maxRecentFiles)
    for (const handle of toRemove) {
      await this.removeHandle(handle.id)
    }
  }

  async storeFile(file: StoredFile): Promise<void> {
    const db = await this.getDB()

    return new Promise((resolve, reject) => {
      const tx = db.transaction('files', 'readwrite')
      tx.onerror = () => reject(tx.error)

      const store = tx.objectStore('files')
      store.put(file)

      tx.oncomplete = () => resolve()
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
}
