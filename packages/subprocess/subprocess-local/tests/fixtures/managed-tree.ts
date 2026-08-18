import { spawn } from 'node:child_process'
import { publishTreeState } from './tree-state.ts'

const [statePath, behavior = 'hold'] = process.argv.slice(2)
if (statePath === undefined || (behavior !== 'hold' && behavior !== 'exit-before-publication')) {
  throw new Error('usage: managed-tree.ts <state-path> <hold|exit-before-publication>')
}

process.on('SIGTERM', () => {})
process.on('SIGHUP', () => {})
if (behavior === 'exit-before-publication') {
  console.error('fixture-exit-before-publication')
  process.exit(17)
}
const descendant = spawn(process.execPath, [
  '-e',
  'process.on("SIGTERM",()=>{});process.on("SIGHUP",()=>{});setInterval(()=>{},60_000)',
], { stdio: 'ignore' })
if (descendant.pid === undefined) throw new Error('managed descendant did not publish a pid')

await publishTreeState(statePath, {
  root: process.pid,
  descendant: descendant.pid,
  atomicWriteModuleUrl: import.meta.resolve('@deepseek-ai/dsh-atomic-write'),
})
setInterval(() => {}, 60_000)
