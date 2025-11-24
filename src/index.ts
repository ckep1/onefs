import type {
  FSBridgeAdapter,
  FSBridgeConfig,
  FSBridgeFile,
  FSBridgeOpenOptions,
  FSBridgeSaveOptions,
  FSBridgeDirectory,
  FSBridgeDirectoryOptions,
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
  StoredHandle,
  Platform,
  FSBridgeResult,
  FSBridgeErrorCode,
  FSBridgeError,
  FSBridgeCapabilities,
}

export { ok, err, PLATFORM_CAPABILITIES }
export { FSAccessAdapter, PickerIDBAdapter, TauriAdapter, CapacitorAdapter }

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
      tauri: () => new TauriAdapter(appName, maxRecentFiles),
      capacitor: () => new CapacitorAdapter(appName, maxRecentFiles),
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

  get platform(): Platform {
    return this.adapter.platform
  }

  get capabilities(): FSBridgeCapabilities {
    return PLATFORM_CAPABILITIES[this.adapter.platform]
  }

  get supportsDirectories(): boolean {
    return typeof this.adapter.openDirectory === 'function'
  }

  get supportsHandlePersistence(): boolean {
    return this.adapter.platform === 'web-fs-access'
  }

  async openFile(options?: FSBridgeOpenOptions): Promise<FSBridgeResult<FSBridgeFile>>
  async openFile(options: FSBridgeOpenOptions & { multiple: true }): Promise<FSBridgeResult<FSBridgeFile[]>>
  async openFile(options: FSBridgeOpenOptions = {}): Promise<FSBridgeResult<FSBridgeFile | FSBridgeFile[]>> {
    return this.adapter.openFile(options)
  }

  async openFiles(options: Omit<FSBridgeOpenOptions, 'multiple'> = {}): Promise<FSBridgeResult<FSBridgeFile[]>> {
    const result = await this.adapter.openFile({ ...options, multiple: true })
    if (!result.ok) return result
    const data = Array.isArray(result.data) ? result.data : [result.data]
    return ok(data)
  }

  async saveFile(file: FSBridgeFile, content: Uint8Array | string, options?: FSBridgeSaveOptions): Promise<FSBridgeResult<boolean>> {
    return this.adapter.saveFile(file, content, options)
  }

  async saveFileAs(content: Uint8Array | string, options?: FSBridgeSaveOptions): Promise<FSBridgeResult<FSBridgeFile>> {
    return this.adapter.saveFileAs(content, options)
  }

  async openDirectory(options?: FSBridgeDirectoryOptions): Promise<FSBridgeResult<FSBridgeDirectory>> {
    if (!this.adapter.openDirectory) {
      return err('not_supported', `Directory operations not supported on ${this.adapter.platform}`)
    }
    return this.adapter.openDirectory(options)
  }

  async readDirectory(directory: FSBridgeDirectory): Promise<FSBridgeResult<FSBridgeFile[]>> {
    if (!this.adapter.readDirectory) {
      return err('not_supported', `Directory operations not supported on ${this.adapter.platform}`)
    }
    return this.adapter.readDirectory(directory)
  }

  async getRecentFiles(): Promise<StoredHandle[]> {
    return this.adapter.getRecentFiles()
  }

  async restoreFile(stored: StoredHandle): Promise<FSBridgeResult<FSBridgeFile>> {
    return this.adapter.restoreFile(stored)
  }

  async removeFromRecent(id: string): Promise<void> {
    return this.adapter.removeFromRecent(id)
  }

  async clearRecent(): Promise<void> {
    return this.adapter.clearRecent()
  }

  readAsText(file: FSBridgeFile): string {
    if (typeof file.content === 'string') return file.content
    return new TextDecoder().decode(file.content)
  }

  readAsJSON<T = unknown>(file: FSBridgeFile): T {
    return JSON.parse(this.readAsText(file))
  }

  readAsDataURL(file: FSBridgeFile): string {
    const content = typeof file.content === 'string' ? new TextEncoder().encode(file.content) : file.content
    let binary = ''
    for (let i = 0; i < content.length; i++) {
      binary += String.fromCharCode(content[i])
    }
    return `data:${file.mimeType};base64,${btoa(binary)}`
  }

  readAsBlob(file: FSBridgeFile): Blob {
    const content = typeof file.content === 'string' ? new TextEncoder().encode(file.content) : file.content
    return new Blob([content.buffer as ArrayBuffer], { type: file.mimeType })
  }

  readAsObjectURL(file: FSBridgeFile): string {
    return URL.createObjectURL(this.readAsBlob(file))
  }
}

export function createFSBridge(config: FSBridgeConfig): FSBridge {
  return new FSBridge(config)
}
