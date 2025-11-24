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

export interface FSBridgeAdapter {
  platform: Platform
  isSupported(): boolean
  openFile(options?: FSBridgeOpenOptions): Promise<FSBridgeFile | FSBridgeFile[] | null>
  saveFile(file: FSBridgeFile, content: Uint8Array | string, options?: FSBridgeSaveOptions): Promise<boolean>
  saveFileAs(content: Uint8Array | string, options?: FSBridgeSaveOptions): Promise<FSBridgeFile | null>
  openDirectory?(options?: FSBridgeDirectoryOptions): Promise<FSBridgeDirectory | null>
  readDirectory?(directory: FSBridgeDirectory): Promise<FSBridgeFile[]>
  getRecentFiles(): Promise<StoredHandle[]>
  restoreFile(stored: StoredHandle): Promise<FSBridgeFile | null>
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
