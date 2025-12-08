export type OneFSErrorCode =
  | 'cancelled'
  | 'permission_denied'
  | 'not_supported'
  | 'not_found'
  | 'io_error'
  | 'unknown'

export interface OneFSError {
  code: OneFSErrorCode
  message: string
  cause?: unknown
}

export type OneFSResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: OneFSError }

/**
 * Create a successful result.
 */
export function ok<T>(data: T): OneFSResult<T> {
  return { ok: true, data }
}

/**
 * Create an error result.
 */
export function err<T>(code: OneFSErrorCode, message: string, cause?: unknown): OneFSResult<T> {
  return { ok: false, error: { code, message, cause } }
}

/**
 * Represents a file with its content loaded into memory.
 * Content is always a Uint8Array - use OneFS helper methods to convert:
 * - `readAsText(file)` for UTF-8 string
 * - `readAsJSON(file)` for parsed JSON
 * - `readAsBlob(file)` for Blob
 */
export interface OneFSFile {
  /** Unique identifier for this file instance */
  id: string
  /** File name (e.g., "document.txt") */
  name: string
  /** Full filesystem path (Tauri/Capacitor only, undefined on web) */
  path?: string
  /** File content as bytes - use readAsText() for string conversion */
  content: Uint8Array
  /** MIME type (e.g., "text/plain", "application/json") */
  mimeType: string
  /** File size in bytes */
  size: number
  /** Last modified timestamp (milliseconds since epoch) */
  lastModified: number
  /** Native file handle (web-fs-access only) - enables in-place saving */
  handle?: FileSystemFileHandle
}

/**
 * Represents a directory entry without loaded content.
 * Use `readFileFromDirectory()` to load a specific file's content.
 */
export interface OneFSEntry {
  /** Entry name (e.g., "document.txt" or "subfolder") */
  name: string
  /** Whether this is a file or directory */
  kind: 'file' | 'directory'
  /** File size in bytes (files only) */
  size?: number
  /** Last modified timestamp (files only) */
  lastModified?: number
  /** Full filesystem path (Tauri/Capacitor only) */
  path?: string
  /** Native handle (web-fs-access only) */
  handle?: FileSystemHandle
}

export interface OneFSOpenOptions {
  /** File extensions to accept (e.g., ['.json', '.txt']) */
  accept?: string[]
  /** Allow selecting multiple files */
  multiple?: boolean
  /** Starting directory for the picker */
  startIn?: 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos'
  /** Whether to persist file/handle for later restoration (default: true) */
  persist?: boolean
}

export interface OneFSSaveOptions {
  /** Suggested file name for the save dialog */
  suggestedName?: string
  /** File extensions to accept */
  accept?: string[]
  /** Starting directory for the picker */
  startIn?: 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos'
  /** Whether to persist file/handle for later restoration (default: true) */
  persist?: boolean
}

export interface OneFSDirectoryOptions {
  /** Starting directory for the picker */
  startIn?: 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos'
  /** Access mode - 'readwrite' enables saving files to the directory */
  mode?: 'read' | 'readwrite'
  /** Whether to persist directory handle for later restoration (default: true) */
  persist?: boolean
}

export interface OneFSReadDirectoryOptions {
  /** Skip stat() calls for faster scanning (size/lastModified will be undefined) */
  skipStats?: boolean
}

export interface OneFSScanOptions extends OneFSReadDirectoryOptions {
  /** File extensions to include (e.g., ['.mp3', '.flac']). If not set, all files are included. */
  extensions?: string[]
  /** Callback for progress updates during recursive scan */
  onProgress?: (scanned: number, found: number) => void
  /** AbortSignal for cancellation support */
  signal?: AbortSignal
}

export type PermissionMode = 'read' | 'readwrite'
export type PermissionStatus = 'granted' | 'denied' | 'prompt'

/**
 * Represents a directory reference.
 */
export interface OneFSDirectory {
  /** Unique identifier for this directory instance */
  id: string
  /** Directory name */
  name: string
  /** Full filesystem path (Tauri/Capacitor only) */
  path?: string
  /** Native directory handle (web-fs-access only) */
  handle?: FileSystemDirectoryHandle
}

/**
 * Metadata for a stored file or directory handle.
 * Used by getRecentFiles() to list previously opened items.
 */
export interface StoredHandle {
  id: string
  name: string
  /** Full path (Tauri only) */
  path?: string
  type: 'file' | 'directory'
  storedAt: number
}

/**
 * Internal storage format for file content in IndexedDB.
 */
export interface StoredFile {
  id: string
  name: string
  path?: string
  content: Uint8Array
  mimeType: string
  size: number
  lastModified: number
  storedAt: number
}

export type Platform = 'web-fs-access' | 'web-fallback' | 'tauri' | 'capacitor'

/**
 * Describes what operations are available on the current platform.
 */
export interface OneFSCapabilities {
  /** Can open files via picker */
  openFile: boolean
  /** Can save to an existing file (in-place for fs-access/tauri, download for fallback) */
  saveFile: boolean
  /** Can save as a new file */
  saveFileAs: boolean
  /** Can open directory picker (false, true, or 'limited' for Capacitor) */
  openDirectory: boolean | 'limited'
  /** Can list directory contents */
  readDirectory: boolean | 'limited'
  /** Can persist and restore file handles across sessions (web-fs-access only) */
  handlePersistence: boolean
  /**
   * Can save to the original file location without download.
   * - true: web-fs-access (with handle), tauri (with path)
   * - false: web-fallback (triggers download), capacitor (saves to app directory)
   */
  canSaveInPlace: boolean
  /** Can check and request permissions on files/directories (web-fs-access only) */
  permissions: boolean
}

export const PLATFORM_CAPABILITIES: Record<Platform, OneFSCapabilities> = {
  'web-fs-access': {
    openFile: true,
    saveFile: true,
    saveFileAs: true,
    openDirectory: true,
    readDirectory: true,
    handlePersistence: true,
    canSaveInPlace: true,
    permissions: true,
  },
  'web-fallback': {
    openFile: true,
    saveFile: true,
    saveFileAs: true,
    openDirectory: false,
    readDirectory: false,
    handlePersistence: false,
    canSaveInPlace: false,
    permissions: false,
  },
  tauri: {
    openFile: true,
    saveFile: true,
    saveFileAs: true,
    openDirectory: true,
    readDirectory: true,
    handlePersistence: false,
    canSaveInPlace: true,
    permissions: false,
  },
  capacitor: {
    openFile: true,
    saveFile: true,
    saveFileAs: true,
    openDirectory: true,
    readDirectory: true,
    handlePersistence: false,
    canSaveInPlace: true,
    permissions: false,
  },
}

/**
 * Adapter interface implemented by each platform backend.
 */
export interface OneFSAdapter {
  platform: Platform

  /** Check if this adapter can run in the current environment */
  isSupported(): boolean

  /** Open file picker and return selected file(s) with content */
  openFile(options?: OneFSOpenOptions): Promise<OneFSResult<OneFSFile | OneFSFile[]>>

  /** Save content to an existing file (behavior varies by platform - see canSaveInPlace) */
  saveFile(file: OneFSFile, content: Uint8Array | string, options?: OneFSSaveOptions): Promise<OneFSResult<boolean>>

  /** Open save dialog and write content to new file */
  saveFileAs(content: Uint8Array | string, options?: OneFSSaveOptions): Promise<OneFSResult<OneFSFile>>

  /** Open directory picker (optional - check capabilities first) */
  openDirectory?(options?: OneFSDirectoryOptions): Promise<OneFSResult<OneFSDirectory>>

  /** List directory contents as entries (metadata only, no content loaded) */
  readDirectory?(directory: OneFSDirectory, options?: OneFSReadDirectoryOptions): Promise<OneFSResult<OneFSEntry[]>>

  /** Load a specific file from a directory */
  readFileFromDirectory?(directory: OneFSDirectory, entry: OneFSEntry): Promise<OneFSResult<OneFSFile>>

  /** Recursively scan directory for files (Tauri/Capacitor only) */
  scanDirectory?(directory: OneFSDirectory, options?: OneFSScanOptions): Promise<OneFSResult<OneFSEntry[]>>

  /** Get efficient URL for file playback without loading into memory (Tauri only) */
  getFileUrl?(file: OneFSFile): Promise<string>

  /** Get efficient URL for entry without loading content (Tauri only) */
  getEntryUrl?(entry: OneFSEntry): Promise<string | null>

  /** Get list of recently opened files/directories */
  getRecentFiles(): Promise<StoredHandle[]>

  /** Restore a previously opened file from storage */
  restoreFile(stored: StoredHandle): Promise<OneFSResult<OneFSFile>>

  /** Restore a previously opened directory from storage (optional - check capabilities) */
  restoreDirectory?(stored: StoredHandle, mode?: PermissionMode): Promise<OneFSResult<OneFSDirectory>>

  /** Remove a file from recent list */
  removeFromRecent(id: string): Promise<void>

  /** Clear all recent files */
  clearRecent(): Promise<void>

  /** Check current permission status (optional - check capabilities.permissions) */
  queryPermission?(target: OneFSFile | OneFSDirectory, mode: PermissionMode): Promise<PermissionStatus>

  /** Request permission (optional - check capabilities.permissions) */
  requestPermission?(target: OneFSFile | OneFSDirectory, mode: PermissionMode): Promise<OneFSResult<boolean>>

  /** Store a directory by named key (optional - check capabilities.handlePersistence) */
  setNamedDirectory?(key: string, directory: OneFSDirectory): Promise<OneFSResult<boolean>>

  /** Retrieve a named directory (optional - check capabilities.handlePersistence) */
  getNamedDirectory?(key: string, mode?: PermissionMode): Promise<OneFSResult<OneFSDirectory>>

  /** Remove a named directory (optional - check capabilities.handlePersistence) */
  removeNamedDirectory?(key: string): Promise<void>
}

export interface OneFSConfig {
  /** Application name - used for IndexedDB database naming */
  appName: string
  /** Maximum number of recent files to store (default: 10) */
  maxRecentFiles?: number
  /** Whether to persist files/handles by default (default: true) */
  persistByDefault?: boolean
  /** Whether to use File System Access API when available (default: true) */
  useNativeFSAccess?: boolean
  /** Force a specific adapter (useful for testing) */
  preferredAdapter?: Platform
}
