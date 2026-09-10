/** Real Saki browser planning flow with an isolated repository and controlled external GitHub Provider. */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { expect, it } from 'vitest'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { githubProjectOptionId } from '@breakfastdapaidang/saki-github'
import {
  sakiBoardResultSchema, sakiConfigureGitHubSynchronizationResultSchema,
  sakiCreateWorkItemResultSchema, sakiProjectIndexResultSchema, sakiMilestoneDeliveryIntentResultSchema,
} from '@breakfastdapaidang/saki-host-api/wire'
import { createRepository, registerSnapshotProject, rpc } from '../../../../scripts/fixtures/saki-host-snapshot.ts'
import { sakiSnapshotEnvironment } from '../../../../scripts/saki-snapshot-environment.ts'
import { startWebServerProcess } from './fixtures/web-server-process.ts'
import {
  SAKI_BOARD_SNAPSHOT_CONFIGURATION as config, SAKI_DELIVERY_SNAPSHOT_RELEASE_TARGET as releaseTarget,
  initializeSakiBoardSnapshotMutationState, readSakiBoardSnapshotMutationState,
} from './fixtures/saki-board-fake-github.ts'
import { initialPlanningRemote, readPlanningRemote, writePlanningRemote } from './fixtures/saki-planning-fake-github.ts'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const driver = fileURLToPath(new URL('./fixtures/saki-board-snapshot-driver.ts', import.meta.url))
const stepMs = 120_000
const intentId = () => `intent-${randomUUID()}`

async function keyboardMove(page: Page, title: string, status: string, position?: string): Promise<void> {
  const card = page.getByRole('article').filter({ has: page.getByRole('button', { name: title, exact: true }) })
  await card.getByRole('button', { name: '移动或排序', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '移动工作项', exact: true })
  await dialog.getByLabel('目标状态', { exact: true }).selectOption(status)
  if (position !== undefined) await dialog.getByLabel('放置位置', { exact: true }).selectOption(position)
  await dialog.getByRole('button', { name: '确认移动', exact: true }).click()
}

it('plans K2-created Issues through confirmed remote moves, conflict, failure, and mapping repair', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'saki-k3-browser-'))
  const frames = join(root, '.playwright-mcp', `planning-${randomUUID()}`)
  await mkdir(frames, { recursive: true })
  let browser: Browser | undefined
  let server: ReturnType<typeof startWebServerProcess> | undefined
  let page: Page | undefined
  let serverDiagnostics = ''
  try {
    const admission = join(scratch, 'admission')
    const remotePath = join(scratch, 'remote.json')
    await writeFile(admission, 'complete\n')
    await writePlanningRemote(remotePath, initialPlanningRemote())
    const repository = await createRepository(scratch)
    const env = sakiSnapshotEnvironment()
    Object.assign(env, {
      DSH_HOME: join(scratch, 'home'), SAKI_PORT: '0', TSX_TSCONFIG_PATH: join(root, 'tsconfig.json'),
      SAKI_BOARD_SNAPSHOT_PROVIDER_STATE: admission,
      SAKI_PLANNING_BROWSER_FIXTURE: '1', SAKI_PLANNING_BROWSER_STATE: remotePath,
    })
    server = startWebServerProcess(process.execPath, ['--import', 'tsx/esm', driver], env, stepMs)
    server.child.stderr.on('data', (chunk: string) => { serverDiagnostics += chunk })
    const { url, secret } = await server.ready
    const port = Number(new URL(url).port)
    // Registration rechecks the repository and creates its workspace; keep the browser step budget and Windows' larger fixture budget.
    const registered = await registerSnapshotProject(port, secret, repository,
      process.platform === 'win32' ? {} : { timeoutMs: stepMs })
    expect(registered.confirmed.ok, JSON.stringify(registered.confirmed)).toBe(true)
    const projectId = registered.confirmed.receipt.projectId
    const credentials = { cookie: registered.cookie, requestToken: registered.exchangeValue.access.requestToken }
    if (registered.selection.head.kind !== 'commit') throw new Error('Fixture repository has no Commit')
    const head = registered.selection.head.objectId
    await initializeSakiBoardSnapshotMutationState(admission, head)
    const remoteDelivery = await readSakiBoardSnapshotMutationState(admission)
    await writeFileAtomic(`${admission}.mutation.json`, `${JSON.stringify({ ...remoteDelivery, pushedCommitId: head })}\n`, { mode: 0o600 })
    const configured = sakiConfigureGitHubSynchronizationResultSchema.parse((await rpc(port, 'control/submit', {
      type: 'configure-github-synchronization', intentId: intentId(), projectId,
      expectedSynchronizationRevision: 0, patch: config,
    }, credentials)).value)
    expect(configured.ok, JSON.stringify(configured)).toBe(true)
    const board = async (refresh: 'interactive' | 'cached' = 'cached') => {
      const result = sakiBoardResultSchema.parse((await rpc(port, 'control/query', { type: 'board', projectId, refresh }, credentials)).value)
      if (!result.ok) throw new Error(`Board unavailable: ${result.reason}`)
      return result.projection
    }
    await expect.poll(async () => (await board()).effectiveMutationAvailability.available, { timeout: stepMs }).toBe(true)
    const confirmed = await board()
    if (confirmed.mapping.state !== 'valid') throw new Error('Initial mapping unavailable')
    const index = sakiProjectIndexResultSchema.parse((await rpc(port, 'control/query', { type: 'project-index' }, credentials)).value)
    if (!index.ok) throw new Error('Initial Project index unavailable')
    const project = index.projection.projects.find(project => project.id === projectId)!
    const createRequest = {
      type: 'create-work-item', intentId: intentId(), projectId,
      expected: {
        projectRevision: project.revision, synchronizationRevision: confirmed.synchronizationRevision,
        mappingRevision: confirmed.mapping.configurationRevision,
      },
      title: 'Plan the next Saki release', intendedOutcome: 'A reviewable release scope.',
      acceptanceCriteria: ['Move through the authoritative Project statuses.', 'Retain the complete confirmed Board on read failure.'],
    }
    const create = sakiCreateWorkItemResultSchema.parse((await rpc(port, 'control/submit', createRequest, credentials)).value)
    expect(create.ok, JSON.stringify(create)).toBe(true)
    const milestoneSaved = sakiMilestoneDeliveryIntentResultSchema.parse((await rpc(port, 'control/submit', {
      type: 'save-milestone-delivery', intentId: intentId(), projectId,
      expectedDeliveryRevision: null, expectedRegistryRevision: index.projection.revision,
      expectedProjectRevision: project.revision, phase: 'in-progress',
      release: {
        repositoryId: config.repositoryNodeId, projectId: config.projectNodeId,
        milestoneId: releaseTarget.milestoneId, milestoneNumber: releaseTarget.milestoneNumber,
        tagName: releaseTarget.tagName, releaseCommitId: head,
        upstreamRepositoryId: releaseTarget.upstreamRepositoryId,
        upstreamRepositoryDatabaseId: releaseTarget.upstreamRepositoryDatabaseId,
        upstreamRepositoryNameWithOwner: releaseTarget.upstreamRepositoryNameWithOwner, upstreamCommitId: head,
      },
    }, credentials)).value)
    expect(milestoneSaved.ok, JSON.stringify(milestoneSaved)).toBe(true)
    await board('interactive')
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1180, height: 820 }, locale: 'zh-CN' })
    const separator = registered.cookie.indexOf('=')
    await context.addCookies([{ name: registered.cookie.slice(0, separator), value: registered.cookie.slice(separator + 1), url }])
    page = await context.newPage()
    page.setDefaultTimeout(20_000)
    const errors: string[] = []
    page.on('pageerror', (error) => { errors.push(error.message) })
    await page.goto(url)
    await page.getByRole('button', { name: '项目', exact: true }).click()
    await page.getByRole('button', { name: /^Snapshot project repository / }).click()
    const createdTitle = '#103 Plan the next Saki release'
    await page.getByRole('button', { name: createdTitle, exact: true }).waitFor()
    expect(await page.getByText('Excluded draft card', { exact: true }).count()).toBe(0)
    expect(await page.getByRole('button', { name: /创建 Issue|新建工作项/ }).count()).toBe(0)
    await page.screenshot({ path: join(frames, '00-board.png') })
    await page.getByRole('button', { name: createdTitle, exact: true }).click()
    await page.getByText('Retain the complete confirmed Board on read failure.', { exact: true }).waitFor()
    await page.reload()
    await page.getByRole('heading', { name: createdTitle, exact: true }).waitFor()
    await page.getByText('Retain the complete confirmed Board on read failure.', { exact: true }).waitFor()
    await page.screenshot({ path: join(frames, '01-detail.png') })
    await page.getByRole('button', { name: '返回看板', exact: true }).click()
    await expect.poll(() => page!.getByRole('button', { name: createdTitle, exact: true }).evaluate(element => element === document.activeElement)).toBe(true)
    await keyboardMove(page, '#30 Unplanned repository issue', 'ready')
    await expect.poll(async () => (await board()).confirmed?.items.find(item => item.issueNumber === 30)?.status, { timeout: stepMs }).toBe('ready')
    const joined = await readPlanningRemote(remotePath)
    expect(joined.operations.slice(-2)).toEqual(['project-item-add', 'project-item-status-set'])
    await keyboardMove(page, createdTitle, 'ready', 'top')
    await expect.poll(async () => (await board()).confirmed?.items.filter(item => item.status === 'ready')
      .sort((left, right) => left.order - right.order)[0]?.issueNumber, { timeout: stepMs }).toBe(103)
    expect((await readPlanningRemote(remotePath)).operations.slice(-2)).toEqual(['project-item-status-set', 'project-item-position-set'])
    await keyboardMove(page, createdTitle, 'in-progress')
    await expect.poll(async () => (await board()).confirmed?.items.find(item => item.issueNumber === 103)?.status, { timeout: stepMs }).toBe('in-progress')
    const moving = page.getByRole('article').filter({ has: page.getByRole('button', { name: createdTitle, exact: true }) })
    await expect.poll(() => moving.getAttribute('draggable')).toBe('true')
    const reviewColumn = page.getByRole('region', { name: '评审中', exact: true })
    await reviewColumn.scrollIntoViewIfNeeded()
    await moving.scrollIntoViewIfNeeded()
    const from = await moving.boundingBox()
    const to = await reviewColumn.boundingBox()
    if (from === null || to === null) throw new Error('Drag destinations have no visible geometry')
    await page.mouse.move(from.x + 8, from.y + 8)
    await page.mouse.down()
    await page.mouse.move(from.x + 25, from.y + 15, { steps: 4 })
    await page.mouse.move(to.x + to.width / 2, to.y + 75, { steps: 15 })
    await page.mouse.move(to.x + to.width / 2 + 2, to.y + 77)
    await page.mouse.up()
    await expect.poll(async () => (await board()).confirmed?.items.find(item => item.issueNumber === 103)?.status, { timeout: stepMs }).toBe('in-review')
    await page.screenshot({ path: join(frames, '02-moved.png') })
    await keyboardMove(page, createdTitle, 'done')
    await expect.poll(async () => (await readPlanningRemote(remotePath)).issues.find(row => row.fact.number === 103)?.fact.state).toBe('closed')
    await moving.getByRole('button', { name: '重新打开', exact: true }).click()
    await expect.poll(async () => (await readPlanningRemote(remotePath)).issues.find(row => row.fact.number === 103)?.fact.state).toBe('open')
    await expect.poll(async () => (await board()).confirmed?.items.find(item => item.issueNumber === 103)?.status, { timeout: stepMs }).toBe('in-review')
    await moving.getByRole('button', { name: '移动或排序', exact: true }).click()
    const concurrent = await readPlanningRemote(remotePath)
    const changed = concurrent.issues.find(row => row.fact.number === 103)!
    changed.fact = { ...changed.fact, title: 'Plan the next Saki release — updated remotely', updatedAt: changed.fact.updatedAt + 1 }
    concurrent.items = concurrent.items.map(item => item.content.kind === 'issue' && item.content.issue.id === changed.fact.id
      ? { ...item, statusOptionId: config.statusOptionNodeIds.backlog, updatedAt: item.updatedAt + 1 } : item)
    await writePlanningRemote(remotePath, concurrent)
    await page.getByRole('dialog', { name: '移动工作项', exact: true }).getByLabel('目标状态', { exact: true }).selectOption('ready')
    await page.getByRole('dialog', { name: '移动工作项', exact: true }).getByRole('button', { name: '确认移动', exact: true }).click()
    await page.getByText('远端已变化，已恢复最新确认位置。请检查后重新操作。', { exact: false }).first().waitFor()
    const externalClose = await readPlanningRemote(remotePath)
    const closed = externalClose.issues.find(row => row.fact.number === 30)!
    closed.fact = { ...closed.fact, state: 'closed', updatedAt: closed.fact.updatedAt + 1 }
    await writePlanningRemote(remotePath, externalClose)
    await page.getByRole('button', { name: '刷新远端事实', exact: true }).click()
    await page.getByText('Issue 已在外部关闭，请明确归类为完成或取消。', { exact: true }).waitFor()
    expect((await board()).confirmed?.items.find(item => item.issueNumber === 30)?.status).toBe('ready')
    await keyboardMove(page, '#30 Unplanned repository issue', 'done')
    await expect.poll(async () => (await board()).confirmed?.items.find(item => item.issueNumber === 30)?.status,
      { timeout: stepMs }).toBe('done')
    const partialRemote = await readPlanningRemote(remotePath)
    partialRemote.failAddInspection = true
    await writePlanningRemote(remotePath, partialRemote)
    const partialRequest = { ...createRequest, intentId: intentId(), title: 'Recover Project membership' }
    const partial = sakiCreateWorkItemResultSchema.parse((await rpc(port, 'control/submit', partialRequest, credentials)).value)
    expect(partial).toMatchObject({ ok: false, receipt: { state: 'partial-failure', stage: 'project-item-add' } })
    await page.getByRole('button', { name: '刷新远端事实', exact: true }).click()
    const partialCard = page.getByRole('article').filter({ has: page.getByRole('button', { name: '#104 Recover Project membership', exact: true }) })
    await partialCard.getByText('尚未加入 GitHub Project', { exact: true }).waitFor()
    await page.getByRole('button', { name: '返回「工作」查看提交与恢复', exact: true }).waitFor()
    const recoverable = await readPlanningRemote(remotePath)
    recoverable.failAddInspection = false
    await writePlanningRemote(remotePath, recoverable)
    expect(sakiCreateWorkItemResultSchema.parse((await rpc(port, 'control/submit', partialRequest, credentials)).value)).toMatchObject({ ok: true })
    await expect.poll(async () => (await board()).confirmed?.items.find(item => item.issueNumber === 104)?.notInProject,
      { timeout: stepMs }).toBe(false)
    await writeFileAtomic(admission, 'transient-transport\n', { mode: 0o600 })
    await page.getByRole('button', { name: '刷新远端事实', exact: true }).click()
    await page.getByText('本次扫描未发布：GitHub 读取失败', { exact: true }).waitFor()
    await page.getByRole('button', { name: '#30 Unplanned repository issue', exact: true }).waitFor()
    await page.screenshot({ path: join(frames, '03-retained.png') })
    await writeFileAtomic(admission, 'complete\n', { mode: 0o600 })
    const replaced = await readPlanningRemote(remotePath)
    replaced.replacementField = true
    replaced.items = replaced.items.map(item => ({ ...item, statusOptionId: item.statusOptionId === undefined ? undefined : githubProjectOptionId(`replacement-${item.statusOptionId}`) }))
    await writePlanningRemote(remotePath, replaced)
    await page.getByRole('button', { name: '刷新远端事实', exact: true }).click()
    await page.getByText('状态写入暂不可用，其他只读功能仍可使用。', { exact: true }).waitFor()
    await page.getByRole('button', { name: '状态映射', exact: true }).click()
    await page.getByLabel('GitHub 单选字段', { exact: true }).selectOption({ label: 'Replacement Status' })
    for (const [label, option] of [['收件箱', 'inbox'], ['待规划', 'backlog'], ['可开始', 'ready'], ['进行中', 'inProgress'], ['评审中', 'inReview'], ['完成', 'done'], ['取消', 'canceled']]) {
      await page.getByLabel(label!, { exact: true }).selectOption({ label: option! })
    }
    await page.screenshot({ path: join(frames, '04-repair.png') })
    await page.getByRole('button', { name: '保存并重新扫描', exact: true }).click()
    await expect.poll(async () => (await board()).effectiveMutationAvailability.available, { timeout: stepMs }).toBe(true)
    await page.getByRole('button', { name: '里程碑', exact: true }).click()
    await page.getByRole('button', { name: 'saki-v0.1.0 · 推进中', exact: true }).click()
    await page.getByRole('button', { name: '刷新远端事实', exact: true }).click()
    await page.getByRole('button', { name: '#27 Publish a read-only GitHub Board Projection', exact: true }).waitFor()
    await page.getByRole('link', { name: 'saki-v0.1.0', exact: true }).waitFor()
    await page.screenshot({ path: join(frames, '05-milestone.png') })
    await page.setViewportSize({ width: 420, height: 840 })
    await page.getByRole('button', { name: '打开侧边栏', exact: true }).waitFor()
    await expect.poll(async () => (await page!.getByRole('heading', { name: 'Saki 0.1.0', exact: true, level: 1 }).boundingBox())?.x).toBeLessThan(100)
    await page.getByRole('button', { name: '#27 Publish a read-only GitHub Board Projection', exact: true }).click()
    await page.getByRole('heading', { name: '规格与验收条件', exact: true }).waitFor()
    await expect.poll(() => page!.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: join(frames, '06-mobile-detail.png'), animations: 'disabled' })
    await page.getByRole('button', { name: '看板', exact: true }).click()
    await page.getByRole('button', { name: '状态映射', exact: true }).click()
    await page.getByLabel('GitHub 单选字段', { exact: true }).waitFor()
    await expect.poll(() => page!.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect(errors).toEqual([])
  } catch (error) {
    console.error(serverDiagnostics)
    if (page !== undefined && !page.isClosed()) {
      await page.screenshot({ path: join(frames, 'failure.png'), timeout: 5_000 }).catch(() => undefined)
      console.error('Planning browser failure', await page.locator('body').innerText({ timeout: 5_000 }).catch(() => ''), frames)
    }
    throw error
  } finally {
    await browser?.close()
    await server?.stop()
    await rm(scratch, { recursive: true, force: true })
  }
}, 600_000)
