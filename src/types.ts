export type FSBridgeErrorCode =
  | 'cancelled'
  | 'permission_denied'
  | 'not_supported'
  | 'not_found'
  | 'io_error'
  | 'unknown'

export interface FSBridgeError {
  code: FSBridgeErrorCode
  message: string
  cause?: unknown
}

export type FSBridgeResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: FSBridgeError }

export function ok<T>(data: T): FSBridgeResult<T> {
  return { ok: true, data }
}

export function err<T>(code: FSBridgeErrorCode, message: string, cause?: unknown): FSBridgeResult<T> {
  return { ok: false, error: { code, message, cause } }
}

export interface FSBridgeFile {
  id: string
  name: string
  path?: string
  content: Uint8Array | string
  mimeType: string
  lastModified: number
  handle?: FileSystemFileHandle
}

export interface FSBridgeOpenOptions {
  accept?: string[]
  multiple?: boolean
  startIn?: 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos'
  persist?: boolean
}

export interface FSBridgeSaveOptions {
  suggestedName?: string
  accept?: string[]
  startIn?: 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos'
  persist?: boolean
}

export interface FSBridgeDirectoryOptions {
  startIn?: 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos'
  mode?: 'read' | 'readwrite'
}

export interface FSBridgeDirectory {
  id: string
  name: string
  path?: string
  handle?: FileSystemDirectoryHandle
}

export interface StoredHandle {
  id: string
  name: string
  path?: string
  type: 'file' | 'directory'
  storedAt: number
}

export interface StoredFile {
  id: string
  name: string
  content: Uint8Array
  mimeType: string
  lastModified: number
  storedAt: number
}

export type Platform = 'web-fs-access' | 'web-fallback' | 'tauri' | 'capacitor'

export interface FSBridgeCapabilities {
  openFile: boolean
  saveFile: boolean
  saveFileAs: boolean
  openDirectory: boolean | 'limited'
  readDirectory: boolean | 'limited'
  handlePersistence: boolean
}

export const PLATFORM_CAPABILITIES: Record<Platform, FSBridgeCapabilities> = {
  'web-fs-access': {
    openFile: true,
    saveFile: true,
    saveFileAs: true,
    openDirectory: true,
    readDirectory: true,
    handlePersistence: true,
  },
  'web-fallback': {
    openFile: true,
    saveFile: true,
    saveFileAs: true,
    openDirectory: false,
    readDirectory: false,
    handlePersistence: false,
  },
  tauri: {
    openFile: true,
    saveFile: true,
    saveFileAs: true,
    openDirectory: true,
    readDirectory: true,
    handlePersistence: false,
  },
  capacitor: {
    openFile: true,
    saveFile: true,
    saveFileAs: true,
    openDirectory: 'limited',
    readDirectory: 'limited',
    handlePersistence: false,
  },
}

export interface FSBridgeAdapter {
  platform: Platform
  isSupported(): boolean
  openFile(options?: FSBridgeOpenOptions): Promise<FSBridgeResult<FSBridgeFile | FSBridgeFile[]>>
  saveFile(file: FSBridgeFile, content: Uint8Array | string, options?: FSBridgeSaveOptions): Promise<FSBridgeResult<boolean>>
  saveFileAs(content: Uint8Array | string, options?: FSBridgeSaveOptions): Promise<FSBridgeResult<FSBridgeFile>>
  openDirectory?(options?: FSBridgeDirectoryOptions): Promise<FSBridgeResult<FSBridgeDirectory>>
  readDirectory?(directory: FSBridgeDirectory): Promise<FSBridgeResult<FSBridgeFile[]>>
  getRecentFiles(): Promise<StoredHandle[]>
  restoreFile(stored: StoredHandle): Promise<FSBridgeResult<FSBridgeFile>>
  removeFromRecent(id: string): Promise<void>
  clearRecent(): Promise<void>
}

export interface FSBridgeConfig {
  appName: string
  maxRecentFiles?: number
  persistByDefault?: boolean
  useNativeFSAccess?: boolean
  preferredAdapter?: Platform
}
