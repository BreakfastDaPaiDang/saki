import { defineConfig } from 'tsdown'

const shared = {
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
} as const

/** Build each public entry independently so the private package needs no undeclared shared chunk. */
export default defineConfig([
  { ...shared, entry: ['lib/types/index.js'] },
  { ...shared, entry: ['lib/types/bin.js'] },
])
