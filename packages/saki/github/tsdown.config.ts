import { defineConfig } from 'tsdown'

/** Build the public root, browser-safe constants, and invariant entries. */
export default defineConfig({
  entry: [
    'lib/types/index.js',
    'lib/types/constants.js',
    'lib/types/invariant.js',
  ],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
