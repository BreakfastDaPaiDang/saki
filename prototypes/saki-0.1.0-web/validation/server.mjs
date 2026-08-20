/**
 * Preview-server helper for the validation harness: unique free port,
 * readiness polling, early-exit detection, and full process-tree teardown
 * that is awaited before the caller exits.
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'

export async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

export async function startPreview(root) {
  const port = await freePort()
  // Spawn vite's bin directly with node: no shell wrapper, so the pid we track
  // is the real process and tree teardown is reliable on Windows.
  const viteBin = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url))
  const child = spawn(process.execPath, [viteBin, 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  let stderr = ''
  let exited = null
  child.stderr.on('data', (d) => (stderr += String(d)))
  child.on('exit', (code) => {
    exited = code
  })

  const deadline = Date.now() + 30_000
  let ready = false
  while (Date.now() < deadline) {
    if (exited !== null) throw new Error(`vite preview exited early (code ${exited}): ${stderr.slice(-500)}`)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`)
      if (res.ok) {
        ready = true
        break
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  if (!ready) throw new Error(`vite preview not ready within 30s: ${stderr.slice(-500)}`)

  async function stop() {
    if (exited !== null) return
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
    await new Promise((resolve) => {
      const poll = setInterval(() => {
        if (exited !== null) {
          clearInterval(poll)
          resolve()
        }
      }, 100)
      setTimeout(() => {
        clearInterval(poll)
        resolve()
      }, 5000)
    })
  }

  return { port, stop }
}
