/** Real manual Work flow through the Saki bundle, durable Host, and controlled external providers. */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { expect, it } from 'vitest'
import { sakiBoardResultSchema, sakiConfigureGitHubSynchronizationResultSchema, sakiMyWorkResultSchema } from '@breakfastdapaidang/saki-host-api/wire'
import { createRepository, registerSnapshotProject, rpc } from '../../../../scripts/fixtures/saki-host-snapshot.ts'
import { sakiSnapshotEnvironment } from '../../../../scripts/saki-snapshot-environment.ts'
import { startWebServerProcess } from './fixtures/web-server-process.ts'
import { SAKI_BOARD_SNAPSHOT_CONFIGURATION as config, initializeSakiBoardSnapshotMutationState } from './fixtures/saki-board-fake-github.ts'
import { initialPlanningRemote, readPlanningRemote, writePlanningRemote } from './fixtures/saki-planning-fake-github.ts'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const driver = fileURLToPath(new URL('./fixtures/saki-board-snapshot-driver.ts', import.meta.url))
const stepMs = 120_000

it('creates one Issue, gives it to an Agent, answers its question, and returns to its Session', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'saki-k2-work-'))
  const frames = join(root, '.playwright-mcp', `work-${randomUUID()}`)
  await mkdir(frames, { recursive: true })
  let browser: Browser | undefined
  let server: ReturnType<typeof startWebServerProcess> | undefined
  let page: Page | undefined
  let diagnostics = ''
  const errors: string[] = []
  const browserDiagnostics: string[] = []
  try {
    const admission = join(scratch, 'admission')
    const remotePath = join(scratch, 'remote.json')
    await writeFile(admission, 'complete\n')
    await writePlanningRemote(remotePath, initialPlanningRemote())
    const repository = await createRepository(scratch)
    const env = sakiSnapshotEnvironment()
    Object.assign(env, { DSH_HOME: join(scratch, 'home'), SAKI_PORT: '0', TSX_TSCONFIG_PATH: join(root, 'tsconfig.json'), SAKI_BOARD_SNAPSHOT_PROVIDER_STATE: admission, SAKI_PLANNING_BROWSER_FIXTURE: '1', SAKI_PLANNING_BROWSER_STATE: remotePath, SAKI_WORK_BROWSER_FIXTURE: '1' })
    server = startWebServerProcess(process.execPath, ['--import', 'tsx/esm', driver], env, stepMs)
    server.child.stderr.on('data', (chunk: string) => { diagnostics += chunk })
    const { url, secret } = await server.ready
    const port = Number(new URL(url).port)
    const registered = await registerSnapshotProject(port, secret, repository, process.platform === 'win32' ? {} : { timeoutMs: stepMs })
    expect(registered.confirmed.ok, JSON.stringify(registered.confirmed)).toBe(true)
    const projectId = registered.confirmed.receipt.projectId
    const credentials = { cookie: registered.cookie, requestToken: registered.exchangeValue.access.requestToken }
    if (registered.selection.head.kind !== 'commit') throw new Error('Fixture repository has no Commit')
    await initializeSakiBoardSnapshotMutationState(admission, registered.selection.head.objectId)
    const configured = sakiConfigureGitHubSynchronizationResultSchema.parse((await rpc(port, 'control/submit', { type: 'configure-github-synchronization', intentId: `intent-${randomUUID()}`, projectId, expectedSynchronizationRevision: 0, patch: config }, credentials)).value)
    expect(configured.ok, JSON.stringify(configured)).toBe(true)
    await expect.poll(async () => {
      const result = sakiBoardResultSchema.parse((await rpc(port, 'control/query', { type: 'board', projectId, refresh: 'cached' }, credentials)).value)
      return result.ok && result.projection.effectiveMutationAvailability.available
    }, { timeout: stepMs }).toBe(true)
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1180, height: 820 }, locale: 'zh-CN' })
    const separator = registered.cookie.indexOf('=')
    await context.addCookies([{ name: registered.cookie.slice(0, separator), value: registered.cookie.slice(separator + 1), url }])
    page = await context.newPage(); page.setDefaultTimeout(30_000)
    page.on('pageerror', (error) => { errors.push(error.message) })
    page.on('console', (message) => { if (message.type() === 'warning' || message.type() === 'error') browserDiagnostics.push(message.text()) })
    page.on('response', (response) => { if (response.status() >= 400) browserDiagnostics.push(`${String(response.status())} ${new URL(response.url()).pathname}`) })
    await page.goto(url)
    await page.getByRole('button', { name: '工作', exact: true }).click()
    await page.getByLabel('目标项目', { exact: true }).selectOption(projectId)
    await page.getByLabel('标题', { exact: true }).fill('Preserve changes in the manual workflow')
    await page.getByLabel('预期结果', { exact: true }).fill('The operator can inspect the Agent result.')
    await page.getByLabel('验收标准（每行一项）', { exact: true }).fill('Create exactly one Issue.\nPreserve existing changes.')
    await page.reload()
    await expect.poll(() => page!.getByLabel('标题', { exact: true }).inputValue()).toBe('Preserve changes in the manual workflow')
    await page.screenshot({ path: join(frames, '00-requirement.png') })
    await page.getByRole('button', { name: '创建 Issue 并加入收件箱', exact: true }).click()
    await page.getByText('已完成', { exact: true }).waitFor()
    expect((await readPlanningRemote(remotePath)).operations.filter(operation => operation === 'issue-create')).toHaveLength(1)
    await page.getByRole('button', { name: '关闭结果', exact: true }).click()
    await page.getByRole('region', { name: '提交新需求', exact: true }).getByRole('button', { name: '打开项目看板', exact: true }).click()
    const boardCard = page.getByRole('article').filter({ has: page.getByRole('button', { name: '#103 Preserve changes in the manual workflow', exact: true }) })
    await boardCard.getByRole('button', { name: '移动或排序', exact: true }).click()
    const move = page.getByRole('dialog', { name: '移动工作项', exact: true })
    await move.getByLabel('目标状态', { exact: true }).selectOption('ready')
    await move.getByRole('button', { name: '确认移动', exact: true }).click()
    await expect.poll(async () => {
      const result = sakiBoardResultSchema.parse((await rpc(port, 'control/query', { type: 'board', projectId, refresh: 'cached' }, credentials)).value)
      return result.ok && result.projection.confirmed?.items.find(item => item.issueNumber === 103)?.status
    }, { timeout: stepMs }).toBe('ready')
    await page.screenshot({ path: join(frames, '01-board.png') })
    await page.getByRole('button', { name: '工作', exact: true }).click()
    const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name: '#103 Preserve changes in the manual workflow', exact: true }) })
    await card.getByRole('button', { name: '交给 Agent', exact: true }).waitFor()
    await page.screenshot({ path: join(frames, '01-my-work.png') })
    await card.getByRole('button', { name: '交给 Agent', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '交给 Agent', exact: true })
    await dialog.getByText('模型：saki-test / controllable', { exact: true }).waitFor()
    await page.screenshot({ path: join(frames, '02-confirm-agent.png') })
    await dialog.getByRole('button', { name: '确认执行', exact: true }).click()
    await card.getByRole('button', { name: '回答问题', exact: true }).waitFor({ timeout: stepMs })
    await card.getByRole('button', { name: '回答问题', exact: true }).click()
    await page.getByLabel('Should this Agent Run preserve the current repository state before continuing?', { exact: true }).fill('Preserve the existing changes and report the result.')
    await page.screenshot({ path: join(frames, '03-intervention.png') })
    await page.reload()
    await card.getByRole('button', { name: '回答问题', exact: true }).click()
    await expect.poll(() => page!.getByLabel('Should this Agent Run preserve the current repository state before continuing?', { exact: true }).inputValue()).toBe('Preserve the existing changes and report the result.')
    await page.getByRole('dialog', { name: '回答问题', exact: true }).getByRole('button', { name: '确认执行', exact: true }).click()
    await expect.poll(async () => {
      const work = sakiMyWorkResultSchema.parse((await rpc(port, 'control/query', { type: 'my-work' }, credentials)).value)
      return work.ok && work.projection.items.find(item => item.workItem.issueNumber === 103)?.intervention === undefined
    }, { timeout: stepMs }).toBe(true)
    await card.getByRole('button', { name: '查看工作项与结果', exact: true }).click()
    await page.getByRole('heading', { name: '#103 Preserve changes in the manual workflow', exact: true }).waitFor()
    await page.screenshot({ path: join(frames, '04-work-item.png') })
    await page.getByRole('button', { name: '打开 Session', exact: true }).first().click()
    await page.getByText('The existing repository changes are preserved. The requirement is ready for human inspection.', { exact: true }).waitFor({ timeout: stepMs })
    expect(await page.getByText(/未知 surface 事件/u).count()).toBe(0)
    await page.screenshot({ path: join(frames, '05-session.png') })
    await page.getByRole('button', { name: '工作', exact: true }).click()
    await card.getByRole('button', { name: '查看工作项与结果', exact: true }).waitFor()
    await page.reload()
    await card.getByRole('button', { name: '查看工作项与结果', exact: true }).waitFor()
    expect((await readPlanningRemote(remotePath)).operations.filter(operation => operation === 'issue-create')).toHaveLength(1)
    expect(errors).toEqual([])
  } catch (error) {
    console.error(diagnostics, errors, browserDiagnostics)
    if (page !== undefined && !page.isClosed()) {
      await page.screenshot({ path: join(frames, 'failure.png'), timeout: 5_000 }).catch(() => undefined)
      console.error('Work browser failure', await page.locator('body').innerText({ timeout: 5_000 }).catch(() => ''), frames)
    }
    throw error
  } finally {
    await browser?.close(); await server?.stop(); await rm(scratch, { recursive: true, force: true })
  }
}, 600_000)
