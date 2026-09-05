import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { observeProcessExit, waitForFile } from './process-exit-coordination.ts'
import type { ProcessExitObservation } from './process-exit-coordination.ts'

const [kind, trigger, root, coordination = 'normal'] = process.argv.slice(2)
if ((kind !== 'ordinary' && kind !== 'terminal')
  || (trigger !== 'direct' && trigger !== 'uncaught-exception'
    && trigger !== 'unhandled-rejection' && trigger !== 'dispose')
  || (coordination !== 'normal' && coordination !== 'preexisting-handshakes'
    && coordination !== 'exit-before-publication' && coordination !== 'exit-before-proceed')
  || root === undefined) {
  throw new Error('usage: process-exit-host.ts <ordinary|terminal> <direct|uncaught-exception|unhandled-rejection|dispose> <root> <normal|preexisting-handshakes|exit-before-publication|exit-before-proceed>')
}

const treeState = join(root, 'tree.json')
const ready = join(root, 'ready')
const proceed = join(root, 'proceed')
const managedTree = fileURLToPath(new URL('./managed-tree.ts', import.meta.url))
const managedTreeBehavior = coordination === 'exit-before-publication' ? 'exit-before-publication' : 'hold'
const managedTreeArgv = [process.execPath, ...process.execArgv, managedTree, treeState, managedTreeBehavior]

const listenersBefore = process.listenerCount('exit')
const ctx = new Context()
const fiber = await ctx.plugin(LocalSubprocessRuntime)
const listenersAfterLoad = process.listenerCount('exit')
let managedTreeExited: Promise<ProcessExitObservation>
let terminateManagedTree: () => Promise<void>
if (kind === 'ordinary') {
  const handle = ctx.subprocess.spawn({
    argv: managedTreeArgv,
    cwd: process.cwd(),
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 1024 },
      stderr: { maxBytes: 1024 },
    },
    graceMs: trigger === 'dispose' || coordination === 'exit-before-proceed' ? 100 : 30_000,
  })
  managedTreeExited = observeProcessExit(
    handle.done,
    'managed tree',
    () => handle.collected.stderr?.readFrom(0).text ?? '',
  )
  terminateManagedTree = async () => {
    handle.terminate()
    await handle.done.catch(() => {})
  }
} else {
  const handle = await ctx.subprocess.spawnTerminal({
    argv: managedTreeArgv,
    cwd: process.cwd(),
    rows: 24,
    cols: 80,
    graceMs: trigger === 'dispose' || coordination === 'exit-before-proceed' ? 100 : 30_000,
  })
  handle.output.setEncoding('utf8')
  let output = ''
  handle.output.on('data', (chunk: string) => { output += chunk })
  managedTreeExited = observeProcessExit(handle.done, 'managed terminal tree', () => output)
  terminateManagedTree = async () => {
    await handle.terminate().catch(() => {})
    await handle.done.catch(() => {})
  }
}

if (coordination === 'preexisting-handshakes') {
  await waitForFile(treeState, managedTreeExited, 'fixture tree-state setup')
  await writeFile(proceed, 'proceed')
  await writeFile(join(root, 'preexisting-handshakes'), 'prepared')
}

await waitForFile(treeState, managedTreeExited, 'tree-state publication')
const published = JSON.parse(await readFile(treeState, 'utf8')) as { root?: unknown; descendant?: unknown }
if (!Number.isSafeInteger(published.root) || !Number.isSafeInteger(published.descendant)) {
  throw new Error('managed tree published invalid process ids')
}
await writeFile(ready, 'ready')
// The outer observer needs live identities even when proceed already exists or an early exit is requested.
await waitForFile(join(root, 'observed'), managedTreeExited, 'process identity observation')
if (coordination === 'exit-before-proceed') await terminateManagedTree()
await waitForFile(proceed, managedTreeExited, 'proceed signal')

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
