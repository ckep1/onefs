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
