// @vitest-environment node
import { describe, test, expect } from 'vitest'
import { FSAccessAdapter } from '../adapters/fs-access'
import { TauriAdapter } from '../adapters/tauri'
import { CapacitorAdapter } from '../adapters/capacitor'
import { createOneFS } from '../index'

describe('Node/SSR environment safety', () => {
  test('adapter isSupported checks do not throw without window', () => {
    expect(new FSAccessAdapter('ssr-test').isSupported()).toBe(false)
    expect(new TauriAdapter('ssr-test').isSupported()).toBe(false)
    expect(new CapacitorAdapter('ssr-test').isSupported()).toBe(false)
  })

  test('createOneFS falls back to web-fallback without throwing', () => {
    const fs = createOneFS({ appName: 'ssr-test' })
    expect(fs.platform).toBe('web-fallback')
  })
})
