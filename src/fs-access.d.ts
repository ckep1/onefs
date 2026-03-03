interface FilePickerAcceptType {
  description?: string
  accept: Record<string, string[]>
}

interface OpenFilePickerOptions {
  multiple?: boolean
  types?: FilePickerAcceptType[]
  startIn?: 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos'
  excludeAcceptAllOption?: boolean
}

interface SaveFilePickerOptions {
  suggestedName?: string
  types?: FilePickerAcceptType[]
  startIn?: 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos'
  excludeAcceptAllOption?: boolean
}

interface DirectoryPickerOptions {
  startIn?: 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos'
  mode?: 'read' | 'readwrite'
  id?: string
}

interface FileSystemFileHandle {
  kind: 'file'
  name: string
  getFile(): Promise<File>
  createWritable(): Promise<FileSystemWritableFileStream>
  move(name: string): Promise<void>
  move(directory: FileSystemDirectoryHandle): Promise<void>
  move(directory: FileSystemDirectoryHandle, name: string): Promise<void>
  remove(): Promise<void>
  queryPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>
  requestPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>
}

interface FileSystemDirectoryHandle {
  kind: 'directory'
  name: string
  values(): AsyncIterableIterator<FileSystemFileHandle | FileSystemDirectoryHandle>
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle>
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FileSystemDirectoryHandle>
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>
  queryPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>
  requestPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>
}

interface FileSystemWritableFileStream extends WritableStream {
  write(data: string | BufferSource | Blob): Promise<void>
  seek(position: number): Promise<void>
  truncate(size: number): Promise<void>
}

interface Window {
  showOpenFilePicker(options?: OpenFilePickerOptions): Promise<FileSystemFileHandle[]>
  showSaveFilePicker(options?: SaveFilePickerOptions): Promise<FileSystemFileHandle>
  showDirectoryPicker(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>
}
