# fsbridge

Cross-platform file system abstraction for web, Tauri, and Capacitor.

## Features

- **File System Access API** with handle persistence via IndexedDB
- **Fallback mode** using file picker + IndexedDB storage
- **Tauri integration** via @tauri-apps/plugin-dialog and @tauri-apps/plugin-fs
- **Capacitor integration** via @capacitor/filesystem
- **Automatic platform detection** with configurable overrides
- **Type-safe error handling** with discriminated result types
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
const result = await fs.openFile({ accept: ['.json', '.txt'] })
if (result.ok) {
  const text = fs.readAsText(result.data)
  console.log(text)
} else {
  // Handle error with full context
  if (result.error.code === 'cancelled') {
    console.log('User cancelled')
  } else {
    console.error(result.error.message)
  }
}

// Save to the same file (if handle available)
const saveResult = await fs.saveFile(file, 'updated content')
if (!saveResult.ok && saveResult.error.code === 'permission_denied') {
  console.log('Need write permission')
}

// Save as new file
const newFileResult = await fs.saveFileAs('content', {
  suggestedName: 'document.txt'
})

// Open multiple files
const filesResult = await fs.openFiles({ accept: ['.png', '.jpg'] })
if (filesResult.ok) {
  for (const file of filesResult.data) {
    console.log(file.name)
  }
}

// Get recent files
const recent = await fs.getRecentFiles()
const restored = await fs.restoreFile(recent[0])
```

## Error Handling

All async operations return `FSBridgeResult<T>`:

```typescript
type FSBridgeResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: FSBridgeError }

interface FSBridgeError {
  code: FSBridgeErrorCode
  message: string
  cause?: unknown  // Original error if available
}

type FSBridgeErrorCode =
  | 'cancelled'           // User cancelled operation
  | 'permission_denied'   // No permission to access file/directory
  | 'not_supported'       // Operation not supported on this platform
  | 'not_found'           // File/handle not found
  | 'io_error'            // Generic I/O error
  | 'unknown'             // Unknown error
```

Example error handling:

```typescript
const result = await fs.openFile()

if (!result.ok) {
  switch (result.error.code) {
    case 'cancelled':
      // User clicked cancel - this is normal, not an error
      break
    case 'permission_denied':
      showPermissionDialog()
      break
    case 'not_supported':
      showFallbackUI()
      break
    default:
      console.error('File operation failed:', result.error.message)
  }
  return
}

// result.data is the file
const file = result.data
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

console.log(fs.capabilities)
// { openFile: true, saveFile: true, openDirectory: true, ... }

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

## Platform Capabilities

| Capability | web-fs-access | web-fallback | tauri | capacitor |
|------------|---------------|--------------|-------|-----------|
| openFile | Yes | Yes | Yes | Yes |
| saveFile | Yes | Yes | Yes | Yes |
| saveFileAs | Yes | Yes | Yes | Yes |
| openDirectory | Yes | No | Yes | Limited |
| readDirectory | Yes | No | Yes | Limited |
| handlePersistence | Yes | No | No | No |

### Platform Details

**web-fs-access** (Modern browsers with File System Access API)
- Full read/write access to files
- Handle persistence allows reopening files across sessions without picker
- Best experience for desktop web apps

**web-fallback** (All browsers)
- Uses `<input type="file">` for opening
- Downloads files to save (no in-place editing)
- Content stored in IndexedDB for recent files
- No directory support

**tauri** (Tauri desktop apps)
- Native file dialogs
- Full filesystem access via Tauri plugins
- Path-based operations (no handle persistence)

**capacitor** (Capacitor mobile apps)
- Uses native file picker for opening
- Limited to Documents directory for directory operations
- Content stored in app's data directory

## Exports

```typescript
// Main factory
import { createFSBridge, FSBridge } from 'fsbridge'

// Types
import type {
  FSBridgeFile,
  FSBridgeDirectory,
  FSBridgeResult,
  FSBridgeError,
  FSBridgeErrorCode,
  FSBridgeCapabilities,
  Platform,
  StoredHandle,
} from 'fsbridge'

// Helpers
import { ok, err, PLATFORM_CAPABILITIES } from 'fsbridge'

// Individual adapters (for advanced use)
import {
  FSAccessAdapter,
  PickerIDBAdapter,
  TauriAdapter,
  CapacitorAdapter,
} from 'fsbridge'
```
