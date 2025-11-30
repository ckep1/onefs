# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
