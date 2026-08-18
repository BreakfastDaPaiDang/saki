import { once } from 'node:events'
import { watch } from 'node:fs'
import { access, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'

const [kind, trigger, root] = process.argv.slice(2)
if ((kind !== 'ordinary' && kind !== 'terminal')
  || (trigger !== 'direct' && trigger !== 'uncaught-exception'
    && trigger !== 'unhandled-rejection' && trigger !== 'dispose')
  || root === undefined) {
  throw new Error('usage: process-exit-host.ts <ordinary|terminal> <direct|uncaught-exception|unhandled-rejection|dispose> <root>')
}

const treeState = join(root, 'tree.json')
const ready = join(root, 'ready')
const proceed = join(root, 'proceed')
const managedTree = fileURLToPath(new URL('./managed-tree.ts', import.meta.url))
const managedTreeArgv = [process.execPath, ...process.execArgv, managedTree, treeState]

function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

async function waitForFile(path: string, managedTreeExited: Promise<never>): Promise<void> {
  const watcher = watch(dirname(path))
  try {
    for (;;) {
      const controller = new AbortController()
      const changed = once(watcher, 'change', { signal: controller.signal }).then(() => undefined).catch((error: unknown) => {
        if (!controller.signal.aborted) throw error
      })
      try {
        try {
          await access(path)
          return
        } catch (error) {
          if (!isENOENT(error)) throw error
        }
        await Promise.race([changed, managedTreeExited])
      } finally {
        controller.abort()
      }
    }
  } finally {
    watcher.close()
  }
}

const listenersBefore = process.listenerCount('exit')
const ctx = new Context()
const fiber = await ctx.plugin(LocalSubprocessRuntime)
const listenersAfterLoad = process.listenerCount('exit')
let managedTreeExited: Promise<never>
if (kind === 'ordinary') {
  const handle = ctx.subprocess.spawn({
    argv: managedTreeArgv,
    cwd: process.cwd(),
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 1024 },
      stderr: { maxBytes: 1024 },
    },
    graceMs: trigger === 'dispose' ? 100 : 30_000,
  })
  managedTreeExited = handle.done.then((outcome) => {
    const stderr = handle.collected.stderr?.readFrom(0).text.trim()
    throw new Error(`managed tree exited before publication (code ${outcome.exitCode}, signal ${outcome.signal}): ${stderr ?? ''}`)
  })
} else {
  const handle = await ctx.subprocess.spawnTerminal({
    argv: managedTreeArgv,
    cwd: process.cwd(),
    rows: 24,
    cols: 80,
    graceMs: 30_000,
  })
  handle.output.setEncoding('utf8')
  let output = ''
  handle.output.on('data', (chunk: string) => { output += chunk })
  managedTreeExited = handle.done.then((outcome) => {
    throw new Error(`managed terminal tree exited before publication (code ${outcome.exitCode}, signal ${outcome.signal}): ${output.trim()}`)
  })
}

await waitForFile(treeState, managedTreeExited)
const published = JSON.parse(await readFile(treeState, 'utf8')) as { root?: unknown; descendant?: unknown }
if (!Number.isSafeInteger(published.root) || !Number.isSafeInteger(published.descendant)) {
  throw new Error('managed tree published invalid process ids')
}
await writeFile(ready, 'ready')
await waitForFile(proceed, managedTreeExited)

if (trigger === 'dispose') {
  await fiber.dispose()
  await writeFile(join(root, 'dispose.json'), JSON.stringify({
    listenersBefore,
    listenersAfterLoad,
    listenersAfterDispose: process.listenerCount('exit'),
  }))
} else if (trigger === 'direct') {
  process.exit(23)
} else if (trigger === 'uncaught-exception') {
  setImmediate(() => { throw new Error('host-exit-uncaught-exception') })
  await new Promise(() => {})
} else {
  void Promise.reject(new Error('host-exit-unhandled-rejection'))
  await new Promise(() => {})
}
