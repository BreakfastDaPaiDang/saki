import { defineConfig } from 'tsdown'

/** Build the Host-only library and CLI entries. */
export default defineConfig({
  entry: [
    'lib/types/index.js',
    'lib/types/bin.js',
  ],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
