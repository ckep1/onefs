# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2025-12-08

### Changed

- TauriAdapter now only supports Tauri v2 (removed v1 detection)
- Platform detection simplified to check only `__TAURI_INTERNALS__`
- CapacitorAdapter now uses Documents directory (exposed in iOS Files app)
- Capacitor capabilities upgraded: full directory support, in-place saves

### Fixed

- Added `@tauri-apps/api` as peer dependency for `convertFileSrc` support
- Added defensive check for missing `entry.name` in directory scanning

### Added

- `getTauriFileUrl(filePath)` utility function for getting efficient asset URLs without loading files into memory
- `TauriAdapter.getFileUrl(file)` method for getting asset URLs from OneFSFile objects
- `getEntryUrl(entry)` method for getting streaming URLs from directory entries without loading content
- `scanDirectory(directory, options)` for recursive directory scanning with:
  - `extensions` filter (e.g., `['.mp3', '.flac']`)
  - `onProgress` callback for progress updates
  - `signal` for AbortController cancellation support
  - `skipStats` option for faster scanning
- `OneFSReadDirectoryOptions.skipStats` option to skip stat() calls for faster scanning
- Additional audio MIME types: FLAC, AAC, M4A, Opus, AIFF
- New exported types: `OneFSReadDirectoryOptions`, `OneFSScanOptions`
- CapacitorAdapter: `scanDirectory()` for recursive file scanning
- CapacitorAdapter: `getFileUrl()` and `getEntryUrl()` using `Capacitor.convertFileSrc()`
- CapacitorAdapter: Optional `@capawesome/capacitor-file-picker` support for proper native picker
- CapacitorAdapter: Files copied to Documents on import for Files app visibility

## [0.3.1] - 2025-12-07

### BREAKING CHANGES

This release renames all public APIs from `FSBridge*` to `OneFS*` for consistency with the package name.

**Migration guide:**

| Old Name | New Name |
|----------|----------|
| `FSBridge` | `OneFS` |
| `createFSBridge` | `createOneFS` |
| `FSBridgeFile` | `OneFSFile` |
| `FSBridgeDirectory` | `OneFSDirectory` |
| `FSBridgeEntry` | `OneFSEntry` |
| `FSBridgeResult` | `OneFSResult` |
| `FSBridgeError` | `OneFSError` |
| `FSBridgeErrorCode` | `OneFSErrorCode` |
| `FSBridgeCapabilities` | `OneFSCapabilities` |
| `FSBridgeConfig` | `OneFSConfig` |
| `FSBridgeAdapter` | `OneFSAdapter` |
| `FSBridgeOpenOptions` | `OneFSOpenOptions` |
| `FSBridgeSaveOptions` | `OneFSSaveOptions` |
| `FSBridgeDirectoryOptions` | `OneFSDirectoryOptions` |

IndexedDB database name changed from `fsbridge-{appName}` to `onefs-{appName}`.
Capacitor synthetic paths changed from `fsbridge_*` to `onefs_*`.

## [0.2.1] - 2025-11-30

### Added

- **Permission management** for web-fs-access platform
  - `queryPermission(target, mode)` - Check current permission status on files/directories
  - `requestPermission(target, mode)` - Request permission (must be called during user gesture)
  - Returns `'granted'` and `ok(true)` on platforms without permission APIs

- **Named directory storage** for web-fs-access platform
  - `setNamedDirectory(key, directory)` - Store a directory by key (separate from recent files)
  - `getNamedDirectory(key, mode?)` - Retrieve and request permission on stored directory
  - `removeNamedDirectory(key)` - Remove a named directory from storage
  - Useful for app preferences like output directories

- **New types**
  - `PermissionMode` - `'read' | 'readwrite'`
  - `PermissionStatus` - `'granted' | 'denied' | 'prompt'`

### Changed

- `restoreDirectory()` now accepts optional `mode` parameter to specify permission level
- IndexedDB schema version bumped to 2 (adds `namedHandles` store)

## [0.1.0] - 2025-11-28

### Added

- Initial release
- Cross-platform file system abstraction for web, Tauri, and Capacitor
- File System Access API adapter with handle persistence via IndexedDB
- Fallback adapter using file picker + IndexedDB storage
- Tauri adapter via @tauri-apps/plugin-dialog and @tauri-apps/plugin-fs
- Capacitor adapter via @capacitor/filesystem
- Automatic platform detection with configurable overrides
- Type-safe error handling with discriminated result types
- Lazy directory loading
- Automatic storage pruning for recent files
- Helper methods for content conversion (text, JSON, Blob, DataURL, ObjectURL)
