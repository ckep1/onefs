# fsbridge

Cross-platform file system abstraction for web, Tauri, and Capacitor.

## Features

- **File System Access API** with handle persistence via IndexedDB
- **Fallback mode** using file picker + IndexedDB storage
- **Tauri integration** via @tauri-apps/plugin-dialog and @tauri-apps/plugin-fs
- **Capacitor integration** via @capacitor/filesystem
- **Automatic platform detection** with configurable overrides
- **Optional persistence** - skip IndexedDB storage when not needed

## Installation

```bash
bun add fsbridge
```

## Usage

```typescript
import { createFSBridge } from 'fsbridge'

const fs = createFSBridge({ appName: 'myapp' })

// Open a file
const file = await fs.openFile({ accept: ['.json', '.txt'] })
if (file) {
  const text = fs.readAsText(file)
  console.log(text)
}

// Save to the same file (if handle available)
await fs.saveFile(file, 'updated content')

// Save as new file
const newFile = await fs.saveFileAs('content', {
  suggestedName: 'document.txt'
})

// Open multiple files
const files = await fs.openFiles({ accept: ['.png', '.jpg'] })

// Get recent files
const recent = await fs.getRecentFiles()
const restored = await fs.restoreFile(recent[0])
```

## Configuration

```typescript
const fs = createFSBridge({
  appName: 'myapp',
  maxRecentFiles: 10,         // Max files to remember (default: 10)
  persistByDefault: true,     // Store files/handles in IndexedDB (default: true)
  useNativeFSAccess: true,    // Use File System Access API when available (default: true)
  preferredAdapter: 'tauri',  // Force specific adapter
})
```

## Per-Operation Options

```typescript
// Don't persist this file
const file = await fs.openFile({ persist: false })

// Save without adding to recent
await fs.saveFileAs(content, { persist: false })
```

## Platform Detection

```typescript
console.log(fs.platform)
// 'web-fs-access' | 'web-fallback' | 'tauri' | 'capacitor'

console.log(fs.supportsDirectories)
// true if openDirectory() is available

console.log(fs.supportsHandlePersistence)
// true if file handles can be restored across sessions
```

## Helper Methods

```typescript
fs.readAsText(file)       // string
fs.readAsJSON(file)       // parsed JSON
fs.readAsDataURL(file)    // data:mime;base64,...
fs.readAsBlob(file)       // Blob
fs.readAsObjectURL(file)  // blob:...
```

## Adapters

| Adapter | Platform | Directories | Handle Persistence |
|---------|----------|-------------|-------------------|
| FSAccessAdapter | Modern browsers | Yes | Yes |
| PickerIDBAdapter | All browsers | No | No (content only) |
| TauriAdapter | Tauri apps | Yes | No |
| CapacitorAdapter | Capacitor apps | Limited | No |
