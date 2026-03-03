import 'fake-indexeddb/auto'
import { describe, test, expect } from 'vitest'
import { createOneFS, OneFS, PLATFORM_CAPABILITIES } from '../index'

describe('createOneFS', () => {
  test('returns a OneFS instance', () => {
    const fs = createOneFS({ appName: 'test' })
    expect(fs).toBeInstanceOf(OneFS)
  })

  test('falls back to web-fallback when no native APIs available', () => {
    const fs = createOneFS({ appName: 'test' })
    expect(fs.platform).toBe('web-fallback')
  })

  test('capabilities match platform', () => {
    const fs = createOneFS({ appName: 'test' })
    expect(fs.capabilities).toEqual(PLATFORM_CAPABILITIES[fs.platform])
  })

  test('supportsDirectories reflects capabilities', () => {
    const fs = createOneFS({ appName: 'test' })
    const expected = !!PLATFORM_CAPABILITIES[fs.platform].openDirectory
    expect(fs.supportsDirectories).toBe(expected)
  })

  test('web-fallback does not support directories', () => {
    const fs = createOneFS({ appName: 'test', preferredAdapter: 'web-fallback' })
    expect(fs.supportsDirectories).toBe(false)
  })

  test('supportsHandlePersistence is false for web-fallback', () => {
    const fs = createOneFS({ appName: 'test' })
    expect(fs.supportsHandlePersistence).toBe(false)
  })

  test('dispose does not throw', () => {
    const fs = createOneFS({ appName: 'test' })
    expect(() => fs.dispose()).not.toThrow()
  })

  test('preferredAdapter falls back when unsupported', () => {
    const fs = createOneFS({ appName: 'test', preferredAdapter: 'tauri' })
    expect(fs.platform).toBe('web-fallback')
  })
})
