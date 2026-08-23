# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.0] - 2026-08-23

### Added

- `readFileRange(directory, entry, { position, length })` for random-access partial reads that never load the whole file when the platform can avoid it. Returns `{ content, fileSize? }`; reads past EOF return the truncated window (possibly zero bytes) rather than an error
  - Capacitor: `Range` request over the webview asset server, with `Content-Range` parsed for the total size; a server that ignores `Range` falls back to slicing the returned body
  - Tauri: seekable file handle (`open`/`seek`/`read`/`close`), with `fileSize` from `fstat` on the open handle
  - web-fs-access: lazy `Blob` slice off the file handle
  - web-fallback: slices content already cached in IndexedDB, otherwise `not_supported`
- `readFileRange` capability flag on `OneFSCapabilities` (true everywhere except web-fallback)
- `OneFSReadRangeOptions` and `OneFSFileRange` exported types
- `invalidRangeReason()` and `parseContentRangeSize()` helpers in `src/utils.ts`, with unit tests
- Per-adapter regression tests for range reads (happy path, Range-ignored fallback, EOF truncation, path-traversal rejection) and for the new Capacitor full-read path

### Changed

- Capacitor full reads in `readFileFromDirectory` now stream through `fetch(Capacitor.convertFileSrc(uri))` instead of the base64 `Filesystem.readFile` bridge, which cost roughly 4x the file size in transient memory per file. The base64 path remains as a fallback when the asset server is unavailable (non-webview environments), and the existing provenance and path-safety checks are unchanged

## [0.6.5] - 2026-06-09

### Fixed

- Capacitor: cancelling the native file picker no longer falls through to a second HTML input picker; plugin-missing and user-cancel are now distinguished, and cancellation returns a `cancelled` result
- Adapter selection no longer crashes in Node/SSR environments: `FSAccessAdapter.isSupported()` now guards `typeof window`, so `createOneFS` falls back gracefully instead of throwing `ReferenceError`
- Capacitor: pruning the recent-files list now also deletes the backing copies in the Documents directory, which previously accumulated as orphans that the library could no longer reach or delete
- Files larger than the cache limit now keep their metadata record (with content omitted) when they have a path, so rename/save/restore keep working for large files on Tauri and Capacitor; pathless oversize files are still skipped
- Capacitor `resolveAuthorizedPath` now checks session paths before stored records (matching Tauri), so renaming a file whose stored record lags no longer blocks subsequent `saveFile`/`deleteFile` in the same session
- Tauri and Capacitor `renameFile` now update stored metadata in place instead of rewriting the record from the caller's in-memory file, which could overwrite newer saved content with a stale copy
- Tauri `restoreFile` now returns `not_found` for directory records instead of a zero-byte file
- web-fs-access `renameFile` now validates-and-rejects unsafe names via `isSafeEntryName` (matching Tauri/Capacitor) instead of silently mangling them with `sanitizeFileName`, and refreshes the persisted handle metadata after a rename
- Fallback file pickers (web-fallback and Capacitor HTML input) now detect cancellation via a window-focus fallback on browsers without the input `cancel` event (pre-16.4 Safari), so the returned promise can no longer hang forever
- IndexedDB connection opening is now memoized, preventing duplicate connections from concurrent first calls

### Added

- `IDBStorage.updateFileMetadata()` for content-preserving metadata updates
- `IDBStorage.onFilesPruned` callback so adapters can clean up resources backing evicted records
- `pickFilesViaInput()` shared helper consolidating the HTML input picker used by the web-fallback and Capacitor adapters
- Regression tests for all of the above plus a node-environment suite asserting SSR safety

## [0.6.4] - 2026-05-11

### Fixed

- Tauri and Capacitor `readDirectory`/`scanDirectory` now preserve real filenames containing repeated dots instead of sanitizing them into different names
- Tauri and Capacitor directory scans now skip unsafe native entries (`/`, `\`, null byte, `.`, `..`) without altering valid filenames
- Tauri and Capacitor `renameFile` now validate-and-reject unsafe names instead of silently stripping characters, so renaming to `...thinking.txt` no longer writes a different filename
- Tauri `splitParentPath` now picks the separator from the dominant separator of the parent portion rather than the last separator character, avoiding malformed paths when both `/` and `\` appear

### Added

- `isSafeEntryName` validator in `src/utils.ts` plus a dedicated unit-test suite locking the accept/reject contract
- Regression tests for Tauri and Capacitor scans with repeated-dot filenames, rename validator behavior, and mixed-separator path handling
- ESLint dev tooling and config so `npm run lint` runs as part of release validation

### Security

- Bumped `vite` to ^7, `vite-plugin-dts` to ^5, and `vitest` to ^4 to clear advisories in their transitive deps (esbuild dev-server request leak, rollup path traversal, vite WebSocket file read, postcss XSS, minimatch/picomatch/brace-expansion ReDoS, lodash prototype pollution, ajv ReDoS)
- Added `postcss`, `rollup`, and `picomatch` overrides to pin patched versions until vite/vitest publish updated lockfiles

## [0.6.3] - 2026-04-10

### Security

- Capacitor `deleteFile` and `renameFile` now enforce file provenance before destructive operations (must match persisted storage or active adapter session path)
- Added Capacitor Documents-path validation to reject invalid or traversal-like paths before file reads/renames/deletes

### Fixed

- Capacitor `readFileFromDirectory` now correctly allows root Documents reads when `openDirectory()` returns `path: ''`
- Tauri path joining and rename parent-path handling now preserve native separators (`/` and `\`) to avoid Windows path corruption
- Build output now excludes test declaration files from the published package tarball

### Added

- Regression tests for Capacitor root-directory reads and destructive-operation authorization checks
- Regression tests for Tauri Windows path handling and destructive-operation authorization checks

## [0.6.2] - 2026-03-03

### Performance

- Parallel file reads in `openFile` across all adapters — multiple selected files load concurrently via `Promise.all`
- Batched stat calls in Tauri `readDirectory` and `scanDirectory` — chunks of 25 via `Promise.all` instead of sequential native bridge calls
- Scan mutex on Tauri and Capacitor — serializes concurrent `scanDirectory` calls to prevent native bridge contention
- IDB prune batching — all excess entries deleted in a single transaction instead of individual deletes
- IDB prune buffer — pruning only triggers when count exceeds threshold by 5, avoiding prune on every store
- Deferred IDB persistence — `openFile`/`saveFile` return immediately, IDB writes happen in background via `storeFileDeferred`
- Parallel file reads and copies in Capacitor file picker
- Faster base64 encoding — native `Buffer` fast path for Node/Bun, increased chunk size (32KB) for browser fallback

### Fixed

- Tauri `readDirectory` preserves native entry ordering (files and directories interleaved) instead of grouping by type

## [0.6.1] - 2026-03-03

### Added

- `deleteFile(file)` — delete files on web-fs-access, Tauri, and Capacitor
- `renameFile(file, newName)` — rename files on web-fs-access, Tauri, and Capacitor
- `deleteFile` and `renameFile` capability flags in `OneFSCapabilities`
- `FileSystemFileHandle.remove()` and `.move()` type declarations for web-fs-access
- `FileSystemDirectoryHandle.removeEntry()` type declaration
- 87 unit tests covering utilities, IDB storage, adapter selection, and facade methods

### Security

- Tauri `deleteFile`/`renameFile` now verify the file was opened through the adapter (IDB lookup) before allowing destructive operations
- Web-fs-access `deleteFile`/`renameFile` request `readwrite` permission before operating, matching the `saveFile` pattern

## [0.6.0] - 2026-03-03

### Security Hardening

- Add path sanitization and validation across all adapters (`sanitizeFileName`, `isPathWithin`, `normalizePath`) to defend against path traversal when consuming code passes untrusted data into file/entry objects
- Validate `appName` in IDB storage — reject empty strings and special characters
- Add `maxCacheSize` (default 50MB) to IDB storage to cap cached file content
- Replace `generateId()` with `crypto.randomUUID()`
- Make `getTauriFileUrl()` internal — was unnecessarily exported as a public API
- Sanitize download filenames in picker-idb adapter
- Strip null bytes in filename sanitization

### Breaking Changes

- `readAsJSON()` now returns `OneFSResult<T>` instead of throwing `SyntaxError`
- `getEntryUrl()` now returns `Promise<OneFSResult<string>>` instead of `Promise<string | null>`

### Added

- `getFileUrl()` exposed on `OneFS` facade with `OneFSResult<string>` return type
- `dispose()` method on `OneFS`, all adapters, and `IDBStorage` for connection cleanup
- `onError` callback in `OneFSReadDirectoryOptions` for stat error reporting
- `normalizePath`, `isPathWithin`, `sanitizeFileName`, `toArrayBuffer` utility exports
- FSAccessAdapter `readDirectory` now honors `skipStats` and `onError` options

### Fixed

- `readDirectory` options (`skipStats`, `onError`) now forwarded from facade to adapters
- Capacitor picker default changed from `'audio/*'` to `'*/*'` — was leftover from an audio app
- Capacitor capabilities corrected: `canSaveInPlace` → `false`, `openDirectory`/`readDirectory` → `'limited'`
- `getFileName()` now handles Windows-style backslash paths
- `content.buffer as ArrayBuffer` replaced with `toArrayBuffer()` that correctly handles `byteOffset` for `Uint8Array` views
- `uint8ArrayToBase64` rewritten with chunked processing to avoid stack overflow on large files
- Stale IDB cache on restore now returns errors instead of silently serving cached content
- IDB pruning race condition — fire-and-forget with proper error suppression
- JSDoc corrected: `scanDirectory` and `getEntryUrl` available on Tauri and Capacitor
- `supportsDirectories` getter delegates to `capabilities.openDirectory`
- Deduplicated `onError` in `OneFSScanOptions` (inherits from `OneFSReadDirectoryOptions`)
- Added missing Vite externals for all 6 peer dependencies

## [0.5.0] - 2025-12-13

### Added

- `OneFSScanOptions.onError` callback for handling subdirectory scan errors (replaces console.error)
- `readFileFromDirectory()` now supports `maxBytes` option for partial file reads
- CapacitorAdapter: Partial reads use Range headers via `convertFileSrc` for efficient memory usage

### Changed

- `scanDirectory()` errors are now silent by default; use `onError` callback to handle them
- Removed unused `StoredFile` import from CapacitorAdapter

### Fixed

- Added `@capacitor/core` to devDependencies for build consistency

## [0.4.1] - 2025-12-08

### Fixed

- CapacitorAdapter: Fixed file picker filter to allow non-audio files when using `@capawesome/capacitor-file-picker`
- CapacitorAdapter: Added defensive checks for missing `entry.name` in `readDirectory` and `scanDirectory`

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
