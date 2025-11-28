import type {
  FSBridgeAdapter,
  FSBridgeConfig,
  FSBridgeFile,
  FSBridgeOpenOptions,
  FSBridgeSaveOptions,
  FSBridgeDirectory,
  FSBridgeDirectoryOptions,
  FSBridgeEntry,
  StoredHandle,
  Platform,
  FSBridgeResult,
  FSBridgeErrorCode,
  FSBridgeError,
  FSBridgeCapabilities,
} from './types'
import { ok, err, PLATFORM_CAPABILITIES } from './types'

import { FSAccessAdapter } from './adapters/fs-access'
import { PickerIDBAdapter } from './adapters/picker-idb'
import { TauriAdapter } from './adapters/tauri'
import { CapacitorAdapter } from './adapters/capacitor'

export type {
  FSBridgeAdapter,
  FSBridgeConfig,
  FSBridgeFile,
  FSBridgeOpenOptions,
  FSBridgeSaveOptions,
  FSBridgeDirectory,
  FSBridgeDirectoryOptions,
  FSBridgeEntry,
  StoredHandle,
  Platform,
  FSBridgeResult,
  FSBridgeErrorCode,
  FSBridgeError,
  FSBridgeCapabilities,
}

export { ok, err, PLATFORM_CAPABILITIES }
export { FSAccessAdapter, PickerIDBAdapter, TauriAdapter, CapacitorAdapter }

/**
 * Cross-platform file system abstraction.
 *
 * Provides a unified API for file operations across:
 * - Modern browsers (File System Access API)
 * - Fallback browsers (file picker + IndexedDB)
 * - Tauri desktop apps
 * - Capacitor mobile apps
 *
 * @example
 * ```typescript
 * const fs = createFSBridge({ appName: 'myapp' })
 *
 * // Open a file
 * const result = await fs.openFile({ accept: ['.json'] })
 * if (result.ok) {
 *   const text = fs.readAsText(result.data)
 * }
 *
 * // Check platform capabilities
 * if (fs.capabilities.canSaveInPlace) {
 *   await fs.saveFile(file, newContent)
 * } else {
 *   // Will trigger download on web-fallback
 *   await fs.saveFile(file, newContent)
 * }
 * ```
 */
export class FSBridge {
  private adapter: FSBridgeAdapter
  private config: FSBridgeConfig

  constructor(config: FSBridgeConfig) {
    this.config = {
      maxRecentFiles: 10,
      persistByDefault: true,
      useNativeFSAccess: true,
      ...config,
    }

    this.adapter = this.selectAdapter()
  }

  private selectAdapter(): FSBridgeAdapter {
    const { appName, maxRecentFiles, persistByDefault, useNativeFSAccess, preferredAdapter } = this.config

    const adapters: Record<Platform, () => FSBridgeAdapter> = {
      tauri: () => new TauriAdapter(appName, maxRecentFiles, persistByDefault),
      capacitor: () => new CapacitorAdapter(appName, maxRecentFiles, persistByDefault),
      'web-fs-access': () => new FSAccessAdapter(appName, maxRecentFiles, persistByDefault),
      'web-fallback': () => new PickerIDBAdapter(appName, maxRecentFiles, persistByDefault),
    }

    if (preferredAdapter && adapters[preferredAdapter]) {
      const adapter = adapters[preferredAdapter]()
      if (adapter.isSupported()) return adapter
    }

    const order: Platform[] = useNativeFSAccess
      ? ['tauri', 'capacitor', 'web-fs-access', 'web-fallback']
      : ['tauri', 'capacitor', 'web-fallback']

    for (const platform of order) {
      const adapter = adapters[platform]()
      if (adapter.isSupported()) return adapter
    }

    return new PickerIDBAdapter(appName, maxRecentFiles, persistByDefault)
  }

  /** Current platform identifier */
  get platform(): Platform {
    return this.adapter.platform
  }

  /** Platform capabilities (what operations are available) */
  get capabilities(): FSBridgeCapabilities {
    return PLATFORM_CAPABILITIES[this.adapter.platform]
  }

  /** Whether directory operations are supported */
  get supportsDirectories(): boolean {
    return typeof this.adapter.openDirectory === 'function'
  }

  /** Whether file handles can be persisted and restored across sessions */
  get supportsHandlePersistence(): boolean {
    return this.adapter.platform === 'web-fs-access'
  }

  /**
   * Open a file picker dialog.
   * @param options - Picker configuration (accept, startIn, persist)
   * @returns The selected file with content loaded as Uint8Array
   */
  async openFile(options?: FSBridgeOpenOptions): Promise<FSBridgeResult<FSBridgeFile>>
  async openFile(options: FSBridgeOpenOptions & { multiple: true }): Promise<FSBridgeResult<FSBridgeFile[]>>
  async openFile(options: FSBridgeOpenOptions = {}): Promise<FSBridgeResult<FSBridgeFile | FSBridgeFile[]>> {
    return this.adapter.openFile(options)
  }

  /**
   * Open a file picker for multiple files.
   * Convenience wrapper around openFile with multiple: true.
   */
  async openFiles(options: Omit<FSBridgeOpenOptions, 'multiple'> = {}): Promise<FSBridgeResult<FSBridgeFile[]>> {
    const result = await this.adapter.openFile({ ...options, multiple: true })
    if (!result.ok) return result
    const data = Array.isArray(result.data) ? result.data : [result.data]
    return ok(data)
  }

  /**
   * Save content to an existing file.
   *
   * Behavior varies by platform:
   * - web-fs-access: Saves in-place to original location
   * - tauri: Saves in-place to original location
   * - web-fallback: Triggers a download (not in-place)
   * - capacitor: Saves to app's Data directory (not original location)
   *
   * Check `capabilities.canSaveInPlace` to detect behavior.
   *
   * @param file - The file to save to (must have handle/path from openFile)
   * @param content - New content as string or Uint8Array
   * @param options - Save options (persist)
   */
  async saveFile(file: FSBridgeFile, content: Uint8Array | string, options?: FSBridgeSaveOptions): Promise<FSBridgeResult<boolean>> {
    return this.adapter.saveFile(file, content, options)
  }

  /**
   * Open a save dialog and write content to a new file.
   * @param content - Content to save as string or Uint8Array
   * @param options - Save options (suggestedName, accept, persist)
   * @returns The newly created file
   */
  async saveFileAs(content: Uint8Array | string, options?: FSBridgeSaveOptions): Promise<FSBridgeResult<FSBridgeFile>> {
    return this.adapter.saveFileAs(content, options)
  }

  /**
   * Open a directory picker dialog.
   * Not available on web-fallback platform.
   * @param options - Directory picker options (mode, persist)
   */
  async openDirectory(options?: FSBridgeDirectoryOptions): Promise<FSBridgeResult<FSBridgeDirectory>> {
    if (!this.adapter.openDirectory) {
      return err('not_supported', `Directory operations not supported on ${this.adapter.platform}`)
    }
    return this.adapter.openDirectory(options)
  }

  /**
   * List directory contents as entries (metadata only, no content loaded).
   * Use readFileFromDirectory() to load a specific file's content.
   *
   * @param directory - Directory from openDirectory()
   * @returns Array of file and directory entries with metadata
   */
  async readDirectory(directory: FSBridgeDirectory): Promise<FSBridgeResult<FSBridgeEntry[]>> {
    if (!this.adapter.readDirectory) {
      return err('not_supported', `Directory operations not supported on ${this.adapter.platform}`)
    }
    return this.adapter.readDirectory(directory)
  }

  /**
   * Load a specific file's content from a directory.
   * Use this instead of readDirectory to avoid loading all files at once.
   *
   * @param directory - Directory containing the file
   * @param entry - Entry from readDirectory() with kind === 'file'
   * @returns The file with content loaded
   */
  async readFileFromDirectory(directory: FSBridgeDirectory, entry: FSBridgeEntry): Promise<FSBridgeResult<FSBridgeFile>> {
    if (!this.adapter.readFileFromDirectory) {
      return err('not_supported', `Directory operations not supported on ${this.adapter.platform}`)
    }
    return this.adapter.readFileFromDirectory(directory, entry)
  }

  /**
   * Get list of recently opened files.
   * On web-fs-access, these can be restored without picker.
   * On other platforms, content is restored from IndexedDB cache.
   */
  async getRecentFiles(): Promise<StoredHandle[]> {
    return this.adapter.getRecentFiles()
  }

  /**
   * Restore a previously opened file.
   * On web-fs-access: Re-reads from disk (may request permission)
   * On other platforms: Returns cached content from IndexedDB
   *
   * @param stored - Handle from getRecentFiles()
   */
  async restoreFile(stored: StoredHandle): Promise<FSBridgeResult<FSBridgeFile>> {
    return this.adapter.restoreFile(stored)
  }

  /**
   * Restore a previously opened directory.
   * Only available on web-fs-access platform.
   *
   * @param stored - Handle from getRecentFiles() with type === 'directory'
   */
  async restoreDirectory(stored: StoredHandle): Promise<FSBridgeResult<FSBridgeDirectory>> {
    if (!this.adapter.restoreDirectory) {
      return err('not_supported', `Directory restoration not supported on ${this.adapter.platform}`)
    }
    return this.adapter.restoreDirectory(stored)
  }

  /**
   * Remove a file from the recent files list.
   */
  async removeFromRecent(id: string): Promise<void> {
    return this.adapter.removeFromRecent(id)
  }

  /**
   * Clear all recent files.
   */
  async clearRecent(): Promise<void> {
    return this.adapter.clearRecent()
  }

  // ─────────────────────────────────────────────────────────────
  // Content conversion helpers
  // ─────────────────────────────────────────────────────────────

  /**
   * Read file content as UTF-8 string.
   */
  readAsText(file: FSBridgeFile): string {
    return new TextDecoder().decode(file.content)
  }

  /**
   * Read file content as parsed JSON.
   * @throws SyntaxError if content is not valid JSON
   */
  readAsJSON<T = unknown>(file: FSBridgeFile): T {
    return JSON.parse(this.readAsText(file))
  }

  /**
   * Read file content as data URL (data:mime;base64,...).
   */
  readAsDataURL(file: FSBridgeFile): string {
    let binary = ''
    for (let i = 0; i < file.content.length; i++) {
      binary += String.fromCharCode(file.content[i])
    }
    return `data:${file.mimeType};base64,${btoa(binary)}`
  }

  /**
   * Read file content as Blob.
   */
  readAsBlob(file: FSBridgeFile): Blob {
    return new Blob([file.content.buffer as ArrayBuffer], { type: file.mimeType })
  }

  /**
   * Read file content as object URL (blob:...).
   * Remember to call URL.revokeObjectURL() when done.
   */
  readAsObjectURL(file: FSBridgeFile): string {
    return URL.createObjectURL(this.readAsBlob(file))
  }
}

/**
 * Create a new FSBridge instance.
 *
 * @param config - Configuration options
 * @returns FSBridge instance configured for the current platform
 *
 * @example
 * ```typescript
 * const fs = createFSBridge({
 *   appName: 'myapp',
 *   maxRecentFiles: 20,
 *   persistByDefault: true,
 * })
 * ```
 */
export function createFSBridge(config: FSBridgeConfig): FSBridge {
  return new FSBridge(config)
}
