import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The prototype is a standalone app: it must run under plain `vite dev`,
// unlike apps/web which only boots inside the dsh host.
export default defineConfig({
  plugins: [react()],
  server: { port: 5242, strictPort: true },
})
