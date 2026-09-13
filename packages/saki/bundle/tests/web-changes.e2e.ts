/** Browser Git review against the assembled Saki Host and an isolated real repository. */
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { appendFile, mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { chromium, type Browser, type Page } from 'playwright'
import { expect, it } from 'vitest'
import { sakiBoardResultSchema, sakiConfigureGitHubSynchronizationResultSchema, sakiCreateCommitResultSchema } from '@breakfastdapaidang/saki-host-api/wire'
import { createRepository, inspectSnapshotRepositoryGitState, registerSnapshotProject, rpc } from '../../../../scripts/fixtures/saki-host-snapshot.ts'
import { sakiSnapshotEnvironment } from '../../../../scripts/saki-snapshot-environment.ts'
import { startWebServerProcess } from './fixtures/web-server-process.ts'
import { SAKI_BOARD_SNAPSHOT_CONFIGURATION as config, initializeSakiBoardSnapshotMutationState } from './fixtures/saki-board-fake-github.ts'
import { initialPlanningRemote, writePlanningRemote } from './fixtures/saki-planning-fake-github.ts'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const driver = fileURLToPath(new URL('./fixtures/saki-board-snapshot-driver.ts', import.meta.url))
const stepMs = 600_000

it('reviews, stages, unstages, and recovers one local commit after its response is lost', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'saki-k4-changes-'))
  const frames = join(root, '.playwright-mcp', `changes-${randomUUID()}`)
  await mkdir(frames, { recursive: true })
  const recordStep = async (step: string) => {
    await appendFile(join(frames, 'steps.jsonl'), `${JSON.stringify({ step, at: new Date().toISOString() })}\n`)
  }
  let browser: Browser | undefined
  let server: ReturnType<typeof startWebServerProcess> | undefined
  let page: Page | undefined
  let diagnostics = ''
  const errors: string[] = []
  try {
    const admission = join(scratch, 'admission'); const remotePath = join(scratch, 'remote.json')
    await writeFile(admission, 'complete\n'); await writePlanningRemote(remotePath, initialPlanningRemote())
    const repository = await createRepository(scratch)
    await writeFile(join(repository, 'existing.txt'), 'Keep this inherited work.\n')
    const env = sakiSnapshotEnvironment()
    Object.assign(env, { DSH_HOME: join(scratch, 'home'), SAKI_PORT: '0', TSX_TSCONFIG_PATH: join(root, 'tsconfig.json'), SAKI_BOARD_SNAPSHOT_PROVIDER_STATE: admission, SAKI_CHANGES_BROWSER_FIXTURE: '1', SAKI_PLANNING_BROWSER_FIXTURE: '1', SAKI_PLANNING_BROWSER_STATE: remotePath })
    server = startWebServerProcess(process.execPath, ['--import', 'tsx/esm', driver], env, stepMs)
    server.child.stderr.on('data', (chunk: string) => { diagnostics += chunk })
    const { url, secret } = await server.ready
    const { stdout: head } = await promisify(execFile)('git', ['rev-parse', 'HEAD'], {
      cwd: root, env, windowsHide: true, timeout: 20_000, encoding: 'utf8',
    })
    await writeFile(join(frames, 'recording.json'), `${JSON.stringify({
      head: head.trim(),
      origin: new URL(url).origin, serverPid: server.child.pid, scratch,
      transport: 'real Saki Host and local Git; controlled GitHub fixture',
      viewport: { width: 1180, height: 900 }, startedAt: new Date().toISOString(),
    }, null, 2)}\n`)
    const port = Number(new URL(url).port)
    const registered = await registerSnapshotProject(port, secret, repository, { registrationTimeoutMs: 240_000 })
    expect(registered.confirmed.ok, JSON.stringify(registered.confirmed)).toBe(true)
    await recordStep('registered')
    const projectId = registered.confirmed.receipt.projectId
    const credentials = { cookie: registered.cookie, requestToken: registered.exchangeValue.access.requestToken }
    if (registered.selection.head.kind !== 'commit') throw new Error('Fixture repository has no Commit')
    await initializeSakiBoardSnapshotMutationState(admission, registered.selection.head.objectId)
    const configured = sakiConfigureGitHubSynchronizationResultSchema.parse((await rpc(port, 'control/submit', { type: 'configure-github-synchronization', intentId: `intent-${randomUUID()}`, projectId, expectedSynchronizationRevision: 0, patch: config }, credentials)).value)
    expect(configured.ok, JSON.stringify(configured)).toBe(true)
    await expect.poll(async () => {
      const result = sakiBoardResultSchema.parse((await rpc(port, 'control/query', { type: 'board', projectId, refresh: 'cached' }, credentials)).value)
      return result.ok && result.projection.confirmed !== undefined
    }, { timeout: stepMs }).toBe(true)
    await writeFile(join(repository, 'tracked.txt'), 'Reviewed implementation.\n')
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1180, height: 900 }, locale: 'zh-CN' })
    const separator = registered.cookie.indexOf('=')
    await context.addCookies([{ name: registered.cookie.slice(0, separator), value: registered.cookie.slice(separator + 1), url }])
    page = await context.newPage(); page.setDefaultTimeout(stepMs)
    page.on('pageerror', (error) => { errors.push(error.message) })
    await page.goto(url)
    await page.getByRole('button', { name: '项目', exact: true }).click()
    await page.getByRole('button').filter({ has: page.getByText('repository', { exact: true }) }).click()
    await page.getByRole('button', { name: '#27 Publish a read-only GitHub Board Projection', exact: true }).click()
    await page.getByRole('heading', { name: '#27 Publish a read-only GitHub Board Projection', exact: true }).waitFor()
    await page.getByRole('button', { name: '变更', exact: true }).last().click()
    const tracked = page.getByRole('listitem').filter({ has: page.getByText('tracked.txt', { exact: true }) })
    const inherited = page.getByRole('listitem').filter({ has: page.getByText('existing.txt', { exact: true }) })
    await inherited.getByText('与登记时已有变更一致', { exact: true }).waitFor()
    await recordStep('changes-observed')
    console.error('Changes Diff started', new Date().toISOString())
    await tracked.getByRole('button', { name: '未暂存 Diff', exact: true }).click()
    await page.getByText('+Reviewed implementation.', { exact: true }).waitFor()
    console.error('Changes Diff completed', new Date().toISOString())
    await page.screenshot({ path: join(frames, '00-review.png') })
    await tracked.getByRole('button', { name: '暂存文件', exact: true }).click()
    await page.getByText('操作已完成。', { exact: true }).waitFor()
    expect((await inspectSnapshotRepositoryGitState(repository)).stagedPaths).toEqual(['tracked.txt'])
    await recordStep('staged')
    await page.getByRole('button', { name: '确认结果', exact: true }).click()
    const stagedDiff = tracked.getByRole('button', { name: '暂存区 Diff', exact: true })
    await stagedDiff.or(page.getByRole('alert')).first().waitFor()
    expect(await page.getByRole('alert').allTextContents()).toEqual([])
    await stagedDiff.click()
    await page.getByText('+Reviewed implementation.', { exact: true }).waitFor()
    await page.screenshot({ path: join(frames, '01-staged.png') })
    await tracked.getByRole('button', { name: '取消暂存', exact: true }).click()
    await page.getByText('操作已完成。', { exact: true }).waitFor()
    expect((await inspectSnapshotRepositoryGitState(repository)).stagedPaths).toEqual([])
    await recordStep('unstaged')
    await page.getByRole('button', { name: '确认结果', exact: true }).click()
    await tracked.getByRole('button', { name: '暂存文件', exact: true }).click()
    await page.getByText('操作已完成。', { exact: true }).waitFor()
    await page.getByRole('button', { name: '确认结果', exact: true }).click()
    await page.getByLabel('提交说明', { exact: true }).fill('Review the local implementation')
    await recordStep('restaged')
    await page.reload()
    await expect.poll(() => page!.getByLabel('提交说明', { exact: true }).inputValue(), { timeout: stepMs }).toBe('Review the local implementation')
    await page.getByRole('button', { name: '检查并提交…', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '确认本地提交', exact: true })
    await dialog.getByText('tracked.txt', { exact: true }).waitFor()
    expect(await dialog.getByText('existing.txt', { exact: true }).count()).toBe(0)
    await page.screenshot({ path: join(frames, '02-confirm.png') })
    const submitted: unknown[] = []
    let discard = true
    await page.route('**/saki/control/submit', async (route) => {
      const body = route.request().postDataJSON() as { payload: { type: string } }
      if (body.payload.type !== 'create-commit') { await route.continue(); return }
      submitted.push(body.payload)
      if (!discard) { await route.continue(); return }
      discard = false
      const response = await route.fetch({ timeout: stepMs })
      const envelope = await response.json() as { result: { value: unknown } }
      const result = sakiCreateCommitResultSchema.parse(envelope.result.value)
      expect(result.ok).toBe(true)
      await route.abort('failed')
    })
    await dialog.getByRole('button', { name: '创建本地提交', exact: true }).click()
    await page.getByText('尚未确认操作结果。请核对原操作后再继续。', { exact: true }).waitFor()
    expect((await inspectSnapshotRepositoryGitState(repository)).commitCount).toBe(2)
    await recordStep('commit-response-discarded')
    await page.screenshot({ path: join(frames, '03-unconfirmed.png') })
    await page.reload()
    await page.getByRole('button', { name: '核对 / 重试原操作', exact: true }).click()
    await page.getByText('操作已完成。', { exact: true }).waitFor()
    expect(submitted).toHaveLength(2); expect(submitted[1]).toEqual(submitted[0])
    const state = await inspectSnapshotRepositoryGitState(repository)
    expect(state.commitCount).toBe(2); expect(state.stagedPaths).toEqual([]); expect(state.unstagedPaths).toEqual([])
    expect(await readFile(join(repository, 'existing.txt'), 'utf8')).toBe('Keep this inherited work.\n')
    await page.getByText(state.headObjectId, { exact: true }).first().waitFor()
    await expect.poll(() => tracked.count(), { timeout: stepMs }).toBe(0)
    await recordStep('commit-recovered-and-refreshed')
    await page.screenshot({ path: join(frames, '04-recovered.png') })
    await page.getByRole('button', { name: '确认结果', exact: true }).click()
    await page.setViewportSize({ width: 390, height: 844 })
    await inherited.getByText('与登记时已有变更一致', { exact: true }).waitFor()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: join(frames, '05-mobile.png') })
    await page.getByRole('button', { name: '返回工作项', exact: true }).click()
    await page.getByRole('heading', { name: '#27 Publish a read-only GitHub Board Projection', exact: true }).waitFor()
    expect(errors).toEqual([])
  } catch (error) {
    console.error(diagnostics, errors)
    if (page !== undefined && !page.isClosed()) {
      await page.screenshot({ path: join(frames, 'failure.png'), timeout: 5_000 }).catch(() => undefined)
      console.error('Changes browser failure', await page.locator('body').innerText({ timeout: 5_000 }).catch(() => ''), frames)
    }
    throw error
  } finally {
    await browser?.close(); await server?.stop()
    await writeFile(join(frames, 'host-processes.log'), diagnostics)
    await rm(scratch, { recursive: true, force: true })
  }
// The diagnostic run measures completion across all native Git observations.
}, 3_600_000)
