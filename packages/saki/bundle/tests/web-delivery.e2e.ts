/** Explicit delivery gestures against the assembled Host, real local Git, and controlled remote evidence. */
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { expect, it } from 'vitest'
import { sakiBoardResultSchema, sakiBranchDeliveryIntentResultSchema, sakiConfigureGitHubSynchronizationResultSchema, sakiDeliveryWorkspaceResultSchema } from '@breakfastdapaidang/saki-host-api/wire'
import { createRepository, registerSnapshotProject, rpc } from '../../../../scripts/fixtures/saki-host-snapshot.ts'
import { sakiSnapshotEnvironment } from '../../../../scripts/saki-snapshot-environment.ts'
import { startWebServerProcess } from './fixtures/web-server-process.ts'
import { SAKI_BOARD_SNAPSHOT_CONFIGURATION, initializeSakiBoardSnapshotMutationState, readSakiBoardSnapshotMutationState } from './fixtures/saki-board-fake-github.ts'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const driver = fileURLToPath(new URL('./fixtures/saki-board-snapshot-driver.ts', import.meta.url))
const stepMs = 600_000

it('recovers push and PR creation without duplicate effects, then accepts the exact successful CI commit', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'saki-k4-delivery-'))
  const frames = join(root, '.playwright-mcp', `delivery-${randomUUID()}`)
  await mkdir(frames, { recursive: true })
  let browser: Browser | undefined
  let page: Page | undefined
  let server: ReturnType<typeof startWebServerProcess> | undefined
  let diagnostics = ''
  const errors: string[] = []
  const step = async (name: string) => { await appendFile(join(frames, 'steps.jsonl'), `${JSON.stringify({ name, at: new Date().toISOString() })}\n`) }
  try {
    const admission = join(scratch, 'admission'); const ciPath = join(scratch, 'ci')
    await writeFile(admission, 'complete\n'); await writeFile(ciPath, 'failure\n')
    const repository = await createRepository(scratch)
    const env = sakiSnapshotEnvironment()
    Object.assign(env, { DSH_HOME: join(scratch, 'home'), SAKI_PORT: '0', TSX_TSCONFIG_PATH: join(root, 'tsconfig.json'),
      SAKI_BOARD_SNAPSHOT_PROVIDER_STATE: admission, SAKI_DELIVERY_SNAPSHOT: '1', SAKI_DELIVERY_BROWSER_FIXTURE: '1',
      SAKI_DELIVERY_BROWSER_CI: ciPath, SAKI_CHANGES_BROWSER_FIXTURE: '1' })
    server = startWebServerProcess(process.execPath, ['--import', 'tsx/esm', driver], env, stepMs)
    server.child.stderr.on('data', (chunk: string) => { diagnostics += chunk })
    const { url, secret } = await server.ready
    const port = Number(new URL(url).port)
    const registered = await registerSnapshotProject(port, secret, repository, { registrationTimeoutMs: stepMs })
    expect(registered.confirmed.ok, JSON.stringify(registered.confirmed)).toBe(true)
    if (registered.selection.head.kind !== 'commit') throw new Error('Missing local Commit')
    const commitId = registered.selection.head.objectId
    await initializeSakiBoardSnapshotMutationState(admission, commitId)
    const projectId = registered.confirmed.receipt.projectId
    const credentials = { cookie: registered.cookie, requestToken: registered.exchangeValue.access.requestToken }
    const configured = sakiConfigureGitHubSynchronizationResultSchema.parse((await rpc(port, 'control/submit', {
      type: 'configure-github-synchronization', intentId: `intent-${randomUUID()}`, projectId, expectedSynchronizationRevision: 0, patch: SAKI_BOARD_SNAPSHOT_CONFIGURATION,
    }, credentials)).value)
    expect(configured.ok, JSON.stringify(configured)).toBe(true)
    await expect.poll(async () => {
      const board = sakiBoardResultSchema.parse((await rpc(port, 'control/query', { type: 'board', projectId, refresh: 'cached' }, credentials)).value)
      return board.ok && board.projection.confirmed !== undefined
    }, { timeout: stepMs }).toBe(true)
    await step('registered-and-configured')
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1180, height: 1000 }, locale: 'zh-CN' })
    const separator = registered.cookie.indexOf('=')
    await context.addCookies([{ name: registered.cookie.slice(0, separator), value: registered.cookie.slice(separator + 1), url }])
    page = await context.newPage(); page.setDefaultTimeout(stepMs)
    page.on('pageerror', (error) => { errors.push(error.message) })
    await page.goto(url)
    await page.getByRole('button', { name: '项目', exact: true }).click({ timeout: 30_000 })
    await step('project-page-opened')
    await page.getByRole('button').filter({ has: page.getByText('repository', { exact: true }) }).click()
    await page.getByRole('button', { name: '#27 Publish a read-only GitHub Board Projection', exact: true }).click()
    await page.getByRole('heading', { name: '#27 Publish a read-only GitHub Board Projection', exact: true }).waitFor()
    await page.getByRole('button', { name: '交付', exact: true }).last().click()
    await step('delivery-page-opened')
    await page.getByText(commitId, { exact: true }).first().waitFor()
    await step('local-commit-observed')
    const board = sakiBoardResultSchema.parse((await rpc(port, 'control/query', { type: 'board', projectId, refresh: 'cached' }, credentials)).value)
    const workItemId = board.ok ? board.projection.confirmed?.items[0]?.id : undefined
    const workspace = sakiDeliveryWorkspaceResultSchema.parse((await rpc(port, 'control/query', {
      type: 'delivery-workspace', projectId, workItemId, refresh: 'interactive',
    }, credentials)).value)
    expect(workspace, JSON.stringify(workspace)).toMatchObject({ ok: true, projection: {
      actions: { save: { available: true } }, pushCredentialHelper: 'git-credential-manager',
    } })
    await page.getByLabel('发布分支', { exact: true }).fill('saki/snapshot-delivery')
    await page.getByLabel('PR 目标分支', { exact: true }).fill('main')
    await page.getByRole('button', { name: '确认交付选择', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: '确认执行', exact: true }).click()
    await page.getByText('请求已完成。', { exact: true }).waitFor()
    await page.getByRole('button', { name: '确认结果', exact: true }).click()
    await step('commit-selected')
    await page.screenshot({ path: join(frames, '00-selected.png') })
    const submissions = new Map<string, unknown[]>()
    await page.route('**/saki/control/submit', async (route) => {
      const envelope = route.request().postDataJSON() as { payload: { type: string } }
      const type = envelope.payload.type
      if (type !== 'push-branch-delivery' && type !== 'create-branch-delivery-pull-request') { await route.continue(); return }
      const previous = submissions.get(type) ?? []
      previous.push(envelope.payload); submissions.set(type, previous)
      if (previous.length !== 1) { await route.continue(); return }
      const response = await route.fetch({ timeout: stepMs })
      const body = await response.json() as { result: { value: unknown } }
      expect(sakiBranchDeliveryIntentResultSchema.parse(body.result.value).ok).toBe(true)
      await route.abort('failed')
    })
    await page.getByRole('button', { name: '确认并 push', exact: true }).click()
    await page.getByRole('dialog').getByText('git-credential-manager', { exact: true }).waitFor()
    await page.screenshot({ path: join(frames, '01-push-confirmation.png') })
    await page.getByRole('dialog').getByRole('button', { name: '确认执行', exact: true }).click()
    await page.getByText('尚未确认结果。保留了原请求，请恢复确认，勿重新发起操作。', { exact: true }).waitFor()
    expect((await readSakiBoardSnapshotMutationState(admission)).pushCount).toBe(1)
    await page.reload()
    await page.getByRole('button', { name: '恢复原请求', exact: true }).click()
    await page.getByText('请求已完成。', { exact: true }).waitFor()
    expect(submissions.get('push-branch-delivery')?.[1]).toEqual(submissions.get('push-branch-delivery')?.[0])
    expect((await readSakiBoardSnapshotMutationState(admission)).pushCount).toBe(1)
    await page.getByRole('button', { name: '确认结果', exact: true }).click()
    await step('push-recovered')
    await page.getByLabel('PR 标题', { exact: true }).fill('Deliver snapshot Work Item')
    await page.getByLabel('PR 描述', { exact: true }).fill('Carries the selected Commit through human acceptance.')
    await expect.poll(() => page!.getByRole('button', { name: '创建 PR', exact: true }).isEnabled(), { timeout: 30_000 }).toBe(true)
    await page.getByRole('button', { name: '创建 PR', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: '确认执行', exact: true }).click()
    await page.getByText('尚未确认结果。保留了原请求，请恢复确认，勿重新发起操作。', { exact: true }).waitFor()
    await page.screenshot({ path: join(frames, '02-pr-response-lost.png') })
    await page.reload()
    await page.getByRole('button', { name: '恢复原请求', exact: true }).click()
    await page.getByText('请求已完成。', { exact: true }).waitFor()
    expect(submissions.get('create-branch-delivery-pull-request')?.[1]).toEqual(submissions.get('create-branch-delivery-pull-request')?.[0])
    expect((await readSakiBoardSnapshotMutationState(admission)).pullRequestCreateCount).toBe(1)
    await page.getByRole('button', { name: '确认结果', exact: true }).click()
    await page.getByRole('button', { name: '移到 In review', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: '确认执行', exact: true }).click()
    await page.getByText('请求已完成。', { exact: true }).waitFor()
    await page.getByRole('button', { name: '确认结果', exact: true }).click()
    await expect.poll(() => page!.getByRole('button', { name: '人工验收并完成', exact: true }).isDisabled(), { timeout: stepMs }).toBe(true)
    expect((await readSakiBoardSnapshotMutationState(admission)).issueState).toBe('open')
    await step('failed-ci-blocks-acceptance')
    await page.screenshot({ path: join(frames, '03-ci-failed.png') })
    await writeFile(ciPath, 'success\n')
    await page.getByRole('button', { name: '刷新交付证据', exact: true }).click()
    await expect.poll(() => page!.getByRole('button', { name: '人工验收并完成', exact: true }).isEnabled(), { timeout: stepMs }).toBe(true)
    await page.getByRole('button', { name: '人工验收并完成', exact: true }).click()
    await page.getByRole('dialog').getByText(commitId, { exact: true }).waitFor()
    await page.getByRole('dialog').getByRole('button', { name: '确认执行', exact: true }).click()
    await page.getByText('请求已完成。', { exact: true }).waitFor()
    await page.getByRole('region', { name: '验收记录', exact: true }).waitFor()
    const remote = await readSakiBoardSnapshotMutationState(admission)
    expect(remote).toMatchObject({ pushCount: 1, pullRequestCreateCount: 1, issueState: 'closed', issueStateDispatchCount: 1 })
    await step('accepted')
    await page.screenshot({ path: join(frames, '04-accepted.png') })
    await page.getByRole('button', { name: '确认结果', exact: true }).click()
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('heading', { name: '交付', exact: true }).scrollIntoViewIfNeeded()
    await expect.poll(async () => (await page!.getByRole('main').last().boundingBox())?.width, { timeout: 5_000 }).toBeGreaterThan(300)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: join(frames, '05-mobile.png') })
    await page.getByRole('button', { name: '返回工作项', exact: true }).click()
    await page.getByRole('heading', { name: '#27 Publish a read-only GitHub Board Projection', exact: true }).waitFor()
    await page.getByRole('button', { name: '交付', exact: true }).last().click()
    await page.getByRole('region', { name: '验收记录', exact: true }).waitFor()
    expect(errors).toEqual([])
    await writeFile(join(frames, 'result.json'), `${JSON.stringify({ remote, submissions: Object.fromEntries(submissions), commitId }, null, 2)}\n`)
  } catch (error) {
    console.error(diagnostics, errors, frames)
    if (page !== undefined && !page.isClosed()) {
      await page.screenshot({ path: join(frames, 'failure.png'), timeout: 5_000 }).catch(() => undefined)
      console.error(await page.locator('body').innerText({ timeout: 5_000 }).catch(() => ''))
    }
    throw error
  } finally {
    await browser?.close(); await server?.stop()
    await writeFile(join(frames, 'host-processes.log'), diagnostics)
    await rm(scratch, { recursive: true, force: true })
  }
}, 3_600_000)
