export function generateId(): string {
  return crypto.randomUUID()
}

const MIME_TYPES: Record<string, string> = {
  txt: 'text/plain',
  json: 'application/json',
  js: 'text/javascript',
  mjs: 'text/javascript',
  ts: 'text/typescript',
  tsx: 'text/typescript',
  jsx: 'text/javascript',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  md: 'text/markdown',
  xml: 'application/xml',
  csv: 'text/csv',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  zip: 'application/zip',
  tar: 'application/x-tar',
  gz: 'application/gzip',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  opus: 'audio/opus',
  aiff: 'audio/aiff',
  aif: 'audio/aiff',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
}

export function getMimeType(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase()
  return MIME_TYPES[ext ?? ''] ?? 'application/octet-stream'
}

export function getFileName(path: string): string {
  return path.split(/[/\\]/).pop() || path
}

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
  }
  const CHUNK = 32768
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length))
    binary += String.fromCharCode.apply(null, slice as unknown as number[])
  }
  return btoa(binary)
}

export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

export function normalizePath(path: string): string {
  const segments = path.replace(/\\/g, '/').split('/')
  const result: string[] = []
  for (const seg of segments) {
    if (seg === '..') {
      result.pop()
    } else if (seg && seg !== '.') {
      result.push(seg)
    }
  }
  const normalized = result.join('/')
  return path.startsWith('/') ? '/' + normalized : normalized
}

export function isPathWithin(child: string, parent: string): boolean {
  const normalChild = normalizePath(child)
  const normalParent = normalizePath(parent)
  const prefix = normalParent.endsWith('/') ? normalParent : normalParent + '/'
  return normalChild === normalParent || normalChild.startsWith(prefix)
}

export function sanitizeFileName(name: string): string {
  return name.replace(/[/\\\0]/g, '').replace(/\.\./g, '')
}

/**
 * Open a hidden <input type="file"> picker. Resolves with the selected files,
 * or null when the user cancels. Uses the input `cancel` event where available,
 * with a window-focus fallback for browsers without it (pre-16.4 Safari) so the
 * promise cannot hang forever on cancel. Must be called from a user gesture.
 */
export function pickFilesViaInput(options: { accept?: string; multiple?: boolean }): Promise<FileList | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    if (options.accept) input.accept = options.accept
    input.multiple = options.multiple ?? false

    let settled = false
    const finish = (files: FileList | null) => {
      if (settled) return
      settled = true
      window.removeEventListener('focus', onFocus)
      resolve(files)
    }
    const onFocus = () => {
      // The change event can arrive after focus returns from the picker
      setTimeout(() => finish(input.files?.length ? input.files : null), 1000)
    }

    input.onchange = () => finish(input.files?.length ? input.files : null)
    if ('oncancel' in input) {
      input.oncancel = () => finish(null)
    } else {
      window.addEventListener('focus', onFocus)
    }
    input.click()
  })
}

/**
 * Validate a random-access read window. Returns a reason string when the
 * request is unusable, or null when it is well formed.
 */
export function invalidRangeReason(position: number, length: number): string | null {
  if (!Number.isInteger(position) || position < 0) {
    return 'position must be a non-negative integer'
  }
  if (!Number.isInteger(length) || length < 0) {
    return 'length must be a non-negative integer'
  }
  return null
}

/**
 * Read the total resource size out of a `Content-Range` response header
 * (`bytes 0-99/12345`). Returns undefined when the server sends `*` or a
 * malformed value.
 */
export function parseContentRangeSize(header: string | null | undefined): number | undefined {
  const total = header?.split('/')[1]?.trim()
  if (!total || total === '*') return undefined
  const size = Number(total)
  return Number.isFinite(size) && size >= 0 ? size : undefined
}

export function isSafeEntryName(name: string): boolean {
  return (
    name.length > 0 &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0') &&
    name !== '.' &&
    name !== '..'
  )
}
