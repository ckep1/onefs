# fsbridge

Cross-platform file system abstraction for web, Tauri, and Capacitor.

## Features

- **File System Access API** with handle persistence via IndexedDB
- **Fallback mode** using file picker + IndexedDB storage
- **Tauri integration** via @tauri-apps/plugin-dialog and @tauri-apps/plugin-fs
- **Capacitor integration** via @capacitor/filesystem
- **Automatic platform detection** with configurable overrides
- **Type-safe error handling** with discriminated result types
- **Lazy directory loading** - list entries without loading file contents
- **Automatic storage pruning** - keeps recent files within configured limit

## Installation

```bash
npm install fsbridge
# or
bun add fsbridge
```

## Quick Start

```typescript
import { createFSBridge } from 'fsbridge'

const fs = createFSBridge({ appName: 'myapp' })

// Open a file
const result = await fs.openFile({ accept: ['.json', '.txt'] })
if (result.ok) {
  const text = fs.readAsText(result.data)
  console.log(text)
} else {
  if (result.error.code === 'cancelled') {
    console.log('User cancelled')
  } else {
    console.error(result.error.message)
  }
}

// Save to the same file
const saveResult = await fs.saveFile(file, 'updated content')

// Save as new file
const newFile = await fs.saveFileAs('content', {
  suggestedName: 'document.txt'
})
```

## Important: Platform Differences

FSBridge abstracts platform differences, but some behaviors vary. Always check capabilities before assuming behavior.

### Content is Always `Uint8Array`

File content is always returned as `Uint8Array`, never as a string. Use helper methods to convert:

```typescript
const file = (await fs.openFile()).data

// Convert to string
const text = fs.readAsText(file)

// Parse as JSON
const json = fs.readAsJSON<MyType>(file)

// Get as Blob for images
const blob = fs.readAsBlob(file)
```

### Save Behavior Varies by Platform

The `saveFile()` method behaves differently depending on the platform:

| Platform | Behavior |
|----------|----------|
| web-fs-access | Saves in-place to original file location |
| tauri | Saves in-place to original file location |
| web-fallback | **Triggers a download** (cannot save in-place) |
| capacitor | Saves to app's Data directory (not original location) |

Check `capabilities.canSaveInPlace` to detect this:

```typescript
if (fs.capabilities.canSaveInPlace) {
  // Will save to original location
  await fs.saveFile(file, newContent)
} else {
  // Will trigger download or save to app directory
  // Consider showing a different UI
  await fs.saveFile(file, newContent)
}
```

### Path Property Varies

The `file.path` property has different meanings:

| Platform | `file.path` value |
|----------|------------------|
| web-fs-access | `undefined` (no path access in browser) |
| web-fallback | `undefined` |
| tauri | Real filesystem path (e.g., `/home/user/doc.txt`) |
| capacitor | Synthetic identifier (e.g., `fsbridge_123_doc.txt`) |

### Directory Support

Directory operations are not available on all platforms:

| Platform | `openDirectory` | `readDirectory` |
|----------|-----------------|-----------------|
| web-fs-access | Full support | Full support |
| web-fallback | Not supported | Not supported |
| tauri | Full support | Full support |
| capacitor | Documents only | Documents only |

```typescript
if (fs.supportsDirectories) {
  const dir = await fs.openDirectory()
  // ...
}
```

## Directory Operations

Directories are loaded lazily to avoid memory issues with large folders:

```typescript
// Open directory picker
const dirResult = await fs.openDirectory()
if (!dirResult.ok) return

// List entries (metadata only - no content loaded)
const entriesResult = await fs.readDirectory(dirResult.data)
if (!entriesResult.ok) return

for (const entry of entriesResult.data) {
  console.log(entry.name, entry.kind, entry.size)

  if (entry.kind === 'file') {
    // Load specific file content on demand
    const fileResult = await fs.readFileFromDirectory(dirResult.data, entry)
    if (fileResult.ok) {
      const content = fs.readAsText(fileResult.data)
    }
  }
}
```

### FSBridgeEntry

Directory entries include metadata without content:

```typescript
interface FSBridgeEntry {
  name: string              // "document.txt" or "subfolder"
  kind: 'file' | 'directory'
  size?: number             // File size in bytes (files only)
  lastModified?: number     // Timestamp (files only)
  path?: string             // Full path (Tauri/Capacitor only)
  handle?: FileSystemHandle // Native handle (web-fs-access only)
}
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

Example:

```typescript
const result = await fs.openFile()

if (!result.ok) {
  switch (result.error.code) {
    case 'cancelled':
      // User clicked cancel - not an error
      break
    case 'permission_denied':
      showPermissionDialog()
      break
    case 'not_supported':
      showFallbackUI()
      break
    default:
      console.error('Failed:', result.error.message)
  }
  return
}

const file = result.data
```

## Configuration

```typescript
const fs = createFSBridge({
  appName: 'myapp',           // Required - used for IndexedDB database name
  maxRecentFiles: 10,         // Max files to remember (default: 10)
  persistByDefault: true,     // Store files/handles in IndexedDB (default: true)
  useNativeFSAccess: true,    // Use File System Access API when available (default: true)
  preferredAdapter: 'tauri',  // Force specific adapter (optional)
})
```

## Per-Operation Options

```typescript
// Don't persist this file to recent list
const file = await fs.openFile({ persist: false })

// Save without adding to recent
await fs.saveFileAs(content, { persist: false })
```

## Platform Detection

```typescript
console.log(fs.platform)
// 'web-fs-access' | 'web-fallback' | 'tauri' | 'capacitor'

console.log(fs.capabilities)
// {
//   openFile: true,
//   saveFile: true,
//   saveFileAs: true,
//   openDirectory: true,
//   readDirectory: true,
//   handlePersistence: true,
//   canSaveInPlace: true,
// }

console.log(fs.supportsDirectories)      // boolean
console.log(fs.supportsHandlePersistence) // boolean
```

## Platform Capabilities Matrix

| Capability | web-fs-access | web-fallback | tauri | capacitor |
|------------|---------------|--------------|-------|-----------|
| openFile | Yes | Yes | Yes | Yes |
| saveFile | Yes | Yes (download) | Yes | Yes (app dir) |
| saveFileAs | Yes | Yes (download) | Yes | Yes (app dir) |
| openDirectory | Yes | No | Yes | Limited |
| readDirectory | Yes | No | Yes | Limited |
| handlePersistence | Yes | No | No | No |
| canSaveInPlace | Yes | No | Yes | No |

## FSBridgeFile

```typescript
interface FSBridgeFile {
  id: string              // Unique identifier
  name: string            // File name (e.g., "document.txt")
  path?: string           // Full path (Tauri/Capacitor only)
  content: Uint8Array     // File content as bytes
  mimeType: string        // MIME type (e.g., "text/plain")
  size: number            // File size in bytes
  lastModified: number    // Timestamp (ms since epoch)
  handle?: FileSystemFileHandle  // Native handle (web-fs-access only)
}
```

## Helper Methods

```typescript
fs.readAsText(file)       // string (UTF-8)
fs.readAsJSON(file)       // parsed JSON
fs.readAsDataURL(file)    // data:mime;base64,...
fs.readAsBlob(file)       // Blob
fs.readAsObjectURL(file)  // blob:... (remember to revoke!)
```

## Recent Files

```typescript
// Get recent files
const recent = await fs.getRecentFiles()
// Returns StoredHandle[] with { id, name, path?, type, storedAt }

// Restore a file
const file = await fs.restoreFile(recent[0])

// On web-fs-access: Re-reads from disk (may prompt for permission)
// On other platforms: Returns cached content from IndexedDB

// Remove from recent
await fs.removeFromRecent(id)

// Clear all
await fs.clearRecent()
```

## Exports

```typescript
// Main factory
import { createFSBridge, FSBridge } from 'fsbridge'

// Types
import type {
  FSBridgeFile,
  FSBridgeDirectory,
  FSBridgeEntry,
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

## Platform-Specific Setup

### Tauri

Add the required plugins to your `Cargo.toml`:

```toml
[dependencies]
tauri-plugin-dialog = "2"
tauri-plugin-fs = "2"
```

And initialize them in your Tauri app:

```rust
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### Capacitor

Install the filesystem plugin:

```bash
npm install @capacitor/filesystem
npx cap sync
```

## Future Improvements

The following features are planned but not yet implemented:

- **Streaming support** for large files (ReadableStream)
- **File watching** for external changes (FileSystemObserver)
- **Recursive directory operations** for deep folder structures

## License

MIT
