/**
 * Product-level browser e2e for the Saki K1a web flow on the built bundle:
 * bootstrap exchange, Development Project registration, workspace render,
 * reload/restart restore, and repeat-registration settlement. Drives the real
 * shell in Chromium against the real Host; every interaction is bounded so a
 * server-side stall fails the step instead of hanging the lane.
 */

import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sakiSnapshotEnvironment } from '../../../../scripts/saki-snapshot-environment.ts'

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)
const bin = fileURLToPath(new URL('../lib/bin.js', import.meta.url))
const readyRecord = '{"product":"saki","status":"ready"}'

/** Per-interaction bound; the Host's own Git ceiling is 10 s per command. */
const STEP_MS = 30_000

interface SakiRun {
  readonly child: ReturnType<typeof spawn>
  readonly outcome: Promise<{ code: number | null; stdout: string; stderr: string }>
  stdout(): string
}

async function availablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('temporary Saki port did not resolve to a TCP address')
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error) })
  })
  return address.port
}

async function within<T>(promise: Promise<T>, milliseconds: number, subject: string): Promise<T> {
  let timeout!: ReturnType<typeof setTimeout>
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => { reject(new Error(`${subject} did not settle within ${String(milliseconds)}ms`)) }, milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

/** Spawn the built bundle and resolve once the bootstrap handoff line lands. */
async function startSaki(home: string, port: number): Promise<{ run: SakiRun; url: string; secret: string }> {
  const environment = sakiSnapshotEnvironment()
  environment.DSH_HOME = home
  environment.SAKI_PORT = String(port)
  const child = spawn(process.execPath, [bin], { env: environment, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdin.end()
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  const handoff = new Promise<{ url: string; secret: string }>((resolve, reject) => {
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      const line = stdout.split('\n').find(entry => entry.includes('"bootstrapSecret"'))
      if (line === undefined) return
      try {
        const parsed = JSON.parse(line) as { url: string; bootstrapSecret: string }
        resolve({ url: parsed.url, secret: parsed.bootstrapSecret })
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  })
  child.stdout.on('data', () => undefined)
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  const outcome = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => { resolve({ code, stdout, stderr }) })
  })
  const run: SakiRun = { child, outcome, stdout: () => stdout }
  const announced = await within(handoff, STEP_MS, 'Saki bootstrap handoff')
  expect(stdout).toContain(readyRecord)
  return { run, ...announced }
}

async function stopSaki(run: SakiRun): Promise<void> {
  if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill('SIGKILL')
  await within(run.outcome, 10_000, 'forced Saki child exit')
}

/** Create one commit in a fresh non-bare worktree and return its identity. */
async function makeGitRepository(parent: string, name: string): Promise<{ directory: string; head: string }> {
  const directory = join(parent, name)
  await mkdir(directory, { recursive: true })
  const git = async (...args: string[]): Promise<string> =>
    (await execFileAsync('git', ['-C', directory, ...args])).stdout.trim()
  await git('init')
  await git('config', 'user.email', 'saki-e2e@example.invalid')
  await git('config', 'user.name', 'Saki E2E')
  await writeFile(join(directory, 'README.md'), `# ${name}\n`, 'utf8')
  await git('add', 'README.md')
  await git('commit', '-m', 'initial')
  return { directory, head: await git('rev-parse', 'HEAD') }
}

/** Exchange the launcher-printed bootstrap secret through the Access gate. */
async function passAccessGate(page: Page, secret: string): Promise<void> {
  const gate = page.getByRole('region', { name: '完成本地引导' }).or(page.getByRole('region', { name: '恢复会话' }))
  await gate.waitFor({ state: 'visible', timeout: STEP_MS })
  await page.getByLabel('粘贴 bootstrap secret').fill(secret)
  await page.getByRole('button', { name: /^(完成引导|恢复会话)$/ }).click()
}

/** Register one directory through the selector dialog and land on its workspace. */
async function registerProject(page: Page, directory: string, title: string): Promise<void> {
  await page.getByRole('button', { name: '登记已有目录' }).first().click()
  const dialog = page.getByRole('dialog', { name: '登记 Development Project' })
  await dialog.waitFor({ state: 'visible', timeout: STEP_MS })
  await dialog.getByLabel('本地目录路径').fill(directory)
  await dialog.getByRole('button', { name: '检查目录' }).click()
  // Evidence must render before confirmation is possible.
  await dialog.getByText('GitHub 候选').waitFor({ state: 'visible', timeout: STEP_MS })
  await dialog.getByRole('button', { name: '确认登记' }).click()
  await page.getByRole('button', { name: '返回项目选择' }).waitFor({ state: 'visible', timeout: STEP_MS })
  await page.getByRole('heading', { name: title }).waitFor({ state: 'visible', timeout: STEP_MS })
}

let browser: Browser | undefined
let context: BrowserContext | undefined
const homes: string[] = []
const runs: SakiRun[] = []

function frontendDistAvailable(): boolean {
  try {
    require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')
    return true
  } catch {
    return false
  }
}

const runnable = existsSync(bin) && frontendDistAvailable()

describe.skipIf(!runnable)('Saki web registration flow (built bundle, real browser)', () => {
  beforeAll(async () => {
    browser = await chromium.launch()
    context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } })
  }, 60_000)

  afterAll(async () => {
    for (const run of runs) await stopSaki(run)
    await context?.close()
    await browser?.close()
    for (const home of homes) await rm(home, { recursive: true, force: true })
  })

  it('bootstraps, registers twice, survives reload and restart, and settles repeat registration', async () => {
    const home = await mkdtemp(join(tmpdir(), 'saki-web-e2e-home-'))
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'saki-web-e2e-repo-'))
    homes.push(home, fixtureRoot)
    const first = await makeGitRepository(fixtureRoot, 'fixture-alpha')
    const second = await makeGitRepository(fixtureRoot, 'fixture-beta')
    const port = await availablePort()
    const served = await startSaki(home, port)
    runs.push(served.run)
    const page = await context!.newPage()
    const pageErrors: string[] = []
    page.on('pageerror', (error) => { pageErrors.push(error.message) })

    // The Access gate renders inside the elected Saki surface, so navigate
    // first, then exchange the launcher-printed secret.
    await page.goto(served.url)
    await page.getByRole('button', { name: '项目', exact: true }).click()
    await passAccessGate(page, served.secret)
    await page.getByText('还没有登记任何 Development Project。').waitFor({ state: 'visible', timeout: STEP_MS })

    // First registration → workspace with the confirmed facts.
    await registerProject(page, first.directory, 'fixture-alpha')
    await page.getByText('已连接').waitFor({ state: 'visible', timeout: STEP_MS })
    await page.getByText(first.head.slice(0, 10)).waitFor({ state: 'visible', timeout: STEP_MS })

    // Reload restores the stable workspace address without a new exchange.
    await page.reload()
    await page.getByRole('button', { name: '返回项目选择' }).waitFor({ state: 'visible', timeout: STEP_MS })
    await page.getByRole('heading', { name: 'fixture-alpha' }).waitFor({ state: 'visible', timeout: STEP_MS })

    // Second registration — the repeat-flow path — must settle too.
    await page.getByRole('button', { name: '返回项目选择' }).click()
    await page.getByText('选择一个 Development Project').waitFor({ state: 'visible', timeout: STEP_MS })
    await registerProject(page, second.directory, 'fixture-beta')

    // Re-registering an already-registered directory must settle (receipt or
    // conflict), never stall the dialog.
    await page.getByRole('button', { name: '返回项目选择' }).click()
    await page.getByRole('button', { name: '登记已有目录' }).first().click()
    const dialog = page.getByRole('dialog', { name: '登记 Development Project' })
    await dialog.getByLabel('本地目录路径').fill(first.directory)
    await dialog.getByRole('button', { name: '检查目录' }).click()
    await dialog.getByText('GitHub 候选').waitFor({ state: 'visible', timeout: STEP_MS })
    await dialog.getByRole('button', { name: '确认登记' }).click()
    const settled = page.getByRole('button', { name: '返回项目选择' })
      .or(dialog.getByRole('alert'))
    await settled.first().waitFor({ state: 'visible', timeout: STEP_MS })

    // Restart on the same Installation. The durable browser session survives:
    // this context needs no new exchange and lands on the persisted address.
    await stopSaki(served.run)
    runs.pop()
    const restarted = await startSaki(home, port)
    runs.push(restarted.run)
    await page.goto(restarted.url)
    const backToSelector = page.getByRole('button', { name: '返回项目选择' })
    const selectorHeading = page.getByText('选择一个 Development Project')
    await backToSelector.or(selectorHeading).first().waitFor({ state: 'visible', timeout: STEP_MS })
    if (await backToSelector.isVisible()) await backToSelector.click()
    await selectorHeading.waitFor({ state: 'visible', timeout: STEP_MS })
    await page.getByRole('button', { name: 'fixture-alpha' }).waitFor({ state: 'visible', timeout: STEP_MS })
    await page.getByRole('button', { name: 'fixture-beta' }).waitFor({ state: 'visible', timeout: STEP_MS })

    // A cookie-less context must re-authenticate with the fresh secret.
    const fresh = await browser!.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } })
    try {
      const freshPage = await fresh.newPage()
      await freshPage.goto(restarted.url)
      await freshPage.getByRole('button', { name: '项目', exact: true }).click()
      await passAccessGate(freshPage, restarted.secret)
      await freshPage.getByText('选择一个 Development Project').waitFor({ state: 'visible', timeout: STEP_MS })
      await freshPage.getByRole('button', { name: 'fixture-alpha' }).waitFor({ state: 'visible', timeout: STEP_MS })
    } finally {
      await fresh.close()
    }
    expect(pageErrors).toEqual([])
  }, 300_000)
})
