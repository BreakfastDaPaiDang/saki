import { defineConfig } from 'tsdown'

/** Build the public root and browser-safe constants entries. */
export default defineConfig({
  entry: [
    'lib/types/index.js',
    'lib/types/constants.js',
  ],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
