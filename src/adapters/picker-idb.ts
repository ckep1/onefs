import type {
  FSBridgeAdapter,
  FSBridgeFile,
  FSBridgeOpenOptions,
  FSBridgeSaveOptions,
  StoredHandle,
  StoredFile,
  FSBridgeResult,
} from '../types'
import { ok, err } from '../types'
import { IDBStorage } from '../storage/idb'
import { generateId, getMimeType } from '../utils'

/**
 * Fallback adapter for browsers without File System Access API.
 * Uses <input type="file"> for selection and downloads for saving.
 *
 * Note: saveFile() triggers a download rather than saving in-place.
 * Check capabilities.canSaveInPlace to detect this behavior.
 */
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

  async openFile(options: FSBridgeOpenOptions = {}): Promise<FSBridgeResult<FSBridgeFile | FSBridgeFile[]>> {
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
          resolve(err('cancelled', 'No files selected'))
          return
        }

        try {
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
                size: content.byteLength,
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
              size: content.byteLength,
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

  /**
   * "Save" by triggering a download. Does not save in-place.
   * The file is also stored in IndexedDB for restoration via getRecentFiles().
   */
  async saveFile(
    file: FSBridgeFile,
    content: Uint8Array | string,
    options?: FSBridgeSaveOptions
  ): Promise<FSBridgeResult<boolean>> {
    const shouldPersist = options?.persist ?? this.persistByDefault
    const contentArray = typeof content === 'string' ? new TextEncoder().encode(content) : content

    try {
      if (shouldPersist) {
        const storedFile: StoredFile = {
          id: file.id,
          name: file.name,
          content: contentArray,
          mimeType: file.mimeType,
          size: contentArray.byteLength,
          lastModified: Date.now(),
          storedAt: Date.now(),
        }
        await this.storage.storeFile(storedFile)
      }

      this.triggerDownload(file.name, contentArray, file.mimeType)
      return ok(true)
    } catch (e) {
      const error = e as Error
      return err('io_error', error.message || 'Failed to save file', e)
    }
  }

  /**
   * Save as a new file by triggering a download.
   */
  async saveFileAs(content: Uint8Array | string, options: FSBridgeSaveOptions = {}): Promise<FSBridgeResult<FSBridgeFile>> {
    const shouldPersist = options.persist ?? this.persistByDefault
    const contentArray = typeof content === 'string' ? new TextEncoder().encode(content) : content
    const name = options.suggestedName ?? 'untitled'
    const mimeType = getMimeType(name)
    const id = generateId()

    try {
      if (shouldPersist) {
        const storedFile: StoredFile = {
          id,
          name,
          content: contentArray,
          mimeType,
          size: contentArray.byteLength,
          lastModified: Date.now(),
          storedAt: Date.now(),
        }
        await this.storage.storeFile(storedFile)
      }

      this.triggerDownload(name, contentArray, mimeType)

      return ok({
        id,
        name,
        content: contentArray,
        mimeType,
        size: contentArray.byteLength,
        lastModified: Date.now(),
      })
    } catch (e) {
      const error = e as Error
      return err('io_error', error.message || 'Failed to save file', e)
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
      size: file.size,
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
