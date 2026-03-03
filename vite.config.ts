import { defineConfig } from 'vite'
import { resolve } from 'path'
import dts from 'vite-plugin-dts'

export default defineConfig({
  plugins: [
    dts({
      insertTypesEntry: true,
    }),
  ],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'OneFS',
      formats: ['es', 'cjs'],
      fileName: (format) => `index.${format === 'es' ? 'js' : 'cjs'}`,
    },
    rollupOptions: {
      external: [
        '@tauri-apps/plugin-dialog',
        '@tauri-apps/plugin-fs',
        '@tauri-apps/api/core',
        '@capacitor/filesystem',
        '@capacitor/core',
        '@capawesome/capacitor-file-picker',
      ],
    },
    sourcemap: true,
    minify: false,
  },
})
