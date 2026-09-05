import { defineConfig } from 'tsdown'

/** Build the public, browser-safe constants, Host-only, and fixture entries with one shared module identity. */
export default defineConfig({
  entry: [
    'lib/types/index.js',
    'lib/types/constants.js',
    'lib/types/host.js',
    'lib/types/fixtures.js',
  ],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
