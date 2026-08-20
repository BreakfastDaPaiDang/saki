/**
 * K0 validation harness: runs the full checklist on desktop (1440×900) and a
 * constrained viewport (480×840) against the production build.
 *
 *   npm run build && node validation/validate.mjs
 *
 * Results (results.json + failure screenshots) land in validation/results/.
 */
import { chromium } from 'playwright'
import { AxeBuilder } from '@axe-core/playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { startPreview } from './server.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const resultsDir = join(root, 'validation', 'results')
mkdirSync(resultsDir, { recursive: true })

const DESKTOP = { width: 1440, height: 900 }
const NARROW = { width: 480, height: 840 }

const results = []
function record(area, viewport, outcome, notes = '') {
  results.push({ area, viewport, outcome, notes })
  console.log(`[${outcome}] ${viewport} · ${area}${notes ? ` — ${notes}` : ''}`)
}

async function check(area, viewport, page, fn) {
  try {
    const notes = await fn()
    record(area, viewport, 'pass', notes ?? '')
  } catch (err) {
    const message = err instanceof Error ? err.message.split('\n')[0] : String(err)
    record(area, viewport, 'fail', message)
    try {
      await page.screenshot({ path: join(resultsDir, `fail-${area.replace(/[^\w一-龥-]+/g, '_')}-${viewport}.png`) })
    } catch {
      // screenshot best-effort
    }
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const server = await startPreview(root)
const BASE = `http://127.0.0.1:${server.port}`
console.log(`preview on :${server.port}`)

const browser = await chromium.launch()

async function pageAt(scenario, hash, viewport) {
  const context = await browser.newContext({ viewport })
  const page = await context.newPage()
  await page.goto(`${BASE}/?scenario=${scenario}${hash}`)
  await page.waitForLoadState('networkidle')
  // The fixture engine simulates 260–500ms query latency; networkidle alone
  // fires before the first Projection renders.
  await page.waitForTimeout(900)
  return page
}

/** Toasts never auto-dismiss; clear them so they cannot overlap dialog footers. */
async function dismissToasts(page) {
  const closes = page.locator('[class*="toast_"]').getByRole('button', { name: '关闭通知' })
  const count = await closes.count()
  for (let i = 0; i < count; i++) await closes.nth(0).click().catch(() => {})
  await page.waitForTimeout(150)
}

async function axeScan(page, area, viewportLabel) {
  const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  const serious = scan.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  const detail = serious.map((v) => `${v.id}(${v.nodes.map((n) => n.target.join(' ')).slice(0, 2).join(', ')})`).join(' | ')
  record(area, viewportLabel, serious.length === 0 ? 'pass' : 'fail', serious.length === 0 ? 'axe 无严重违规' : detail)
}

try {
  // ------------------------------------------------------------ 1. My Work
  for (const [viewport, label] of [[DESKTOP, 'desktop'], [NARROW, 'narrow']]) {
    const page = await pageAt('operator-day', '#/work', viewport)
    await check('My Work 四分组', label, page, async () => {
      for (const group of ['待开始', '处理中', '等你处理', '最近结束']) {
        assert(await page.getByRole('heading', { name: new RegExp(group) }).isVisible(), `缺少分组 ${group}`)
      }
    })
    await check('等待验收在等你处理', label, page, async () => {
      const section = page.locator('section[aria-label="等你处理"]')
      assert(await section.getByRole('button', { name: '验收', exact: true }).count() > 0, '等你处理中没有验收按钮')
    })
    await check('Done/Canceled 无验收操作', label, page, async () => {
      const section = page.locator('section[aria-label="最近结束"]')
      assert((await section.getByRole('button', { name: /验收|审阅/ }).count()) === 0, '最近结束里出现了验收/审阅')
    })
    await check('处理中条目无 mutation offer', label, page, async () => {
      const section = page.locator('section[aria-label="处理中"]')
      assert((await section.getByRole('button', { name: /交给 Agent|验收|回答/ }).count()) === 0, '处理中条目出现了 mutation offer')
      assert(await section.getByText(/Agent 正在处理/).first().isVisible(), '缺少归因状态文本')
    })
    await check('Attention 需要关注分组', label, page, async () => {
      assert(await page.getByRole('heading', { name: /需要关注/ }).isVisible(), '缺少需要关注区')
      assert((await page.getByRole('button', { name: /去处理/ }).count()) > 0, '没有去处理入口')
    })
    await axeScan(page, 'My Work', label)

    // 2. offer flow + 稳定 receipt id
    await check('交给 Agent 预提交复核与稳定 receipt', label, page, async () => {
      await page.getByRole('button', { name: '交给 Agent' }).first().click()
      await page.getByText('Model Route').waitFor()
      await page.getByText('所需权限').waitFor()
      await page.getByRole('button', { name: '确认交给 Agent' }).click()
      // pending toast carries the receipt id; confirmed toast carries the SAME id
      const pendingToast = page.locator('[class*="toast_"]').filter({ hasText: '等待控制面确认' }).last()
      await pendingToast.waitFor({ timeout: 3000 })
      const pendingId = (await pendingToast.textContent()).match(/rcpt-\d+/)?.[0]
      assert(pendingId, 'pending toast 缺少凭据 id')
      const confirmedToast = page.locator('[class*="toast_"]').filter({ hasText: '已交给 Agent' }).last()
      await confirmedToast.waitFor({ timeout: 5000 })
      const confirmedId = (await confirmedToast.textContent()).match(/rcpt-\d+/)?.[0]
      assert(confirmedId === pendingId, `receipt id 不稳定：pending ${pendingId} ≠ confirmed ${confirmedId}`)
    })

    // 3. 重复提交：第二次点击要么被禁用挡住，要么由控制面按相同在途 Intent
    // 去重为同一 receipt——两种情况都绝不产生第二次执行。
    await check('pending 期间重复提交去重', label, page, async () => {
      await dismissToasts(page)
      await page.locator('section[aria-label="等你处理"]').getByRole('button', { name: '回答' }).first().click()
      await page.getByPlaceholder(/字段齐全/).fill('字段齐全，按当前实现导出即可。')
      const confirmBtn = page.getByRole('button', { name: '确认回答' })
      await confirmBtn.click()
      await confirmBtn.click({ force: true, timeout: 1200 }).catch(() => {
        // disabled control refusing the second click is the intended guard
      })
      await page.getByText(/回答已提交/).waitFor({ timeout: 5000 })
      const confirmedCount = await page.locator('[class*="toast_"]').filter({ hasText: '回答已提交' }).count()
      assert(confirmedCount === 1, `回答被确认了 ${confirmedCount} 次`)
    })
    await page.close()
  }

  // ------------------------------------------------------------ 4. Board
  for (const [viewport, label] of [[DESKTOP, 'desktop'], [NARROW, 'narrow']]) {
    const page = await pageAt('operator-day', '#/project/proj-saki/work', viewport)
    await check('看板乐观 overlay（pending 插入目标列）', label, page, async () => {
      if (label === 'narrow') {
        // narrow shows one column at a time: bring the source column into view first
        await page.getByRole('tablist', { name: '选择看板列（窄屏）' }).getByRole('tab', { name: /Ready/ }).click()
      }
      const card = page.locator('[aria-label^="#126 会话列表"]').first()
      await card.focus()
      await page.keyboard.press('Alt+ArrowLeft')
      if (label === 'narrow') {
        await page.getByRole('tablist', { name: '选择看板列（窄屏）' }).getByRole('tab', { name: /Backlog/ }).click()
      }
      // pending: card appears in Backlog with 等待确认 marker
      const backlog = page.locator('section[aria-label^="Backlog"]')
      await backlog.getByText('会话列表支持关键词搜索').waitFor({ timeout: 2500 })
      assert(await backlog.getByText('等待确认').isVisible(), 'pending 时目标列缺少等待确认标记')
      await page.getByText(/已移动到 backlog/).waitFor({ timeout: 5000 })
    })
    await check('区段往返不丢选择', label, page, async () => {
      for (const tab of ['里程碑', '变更', '会话与运行', '追溯', '项目设置', '看板']) {
        await page.getByRole('tab', { name: tab }).click()
        await page.getByRole('tab', { name: tab, selected: true }).waitFor()
      }
    })
    await check('drawer 打开/关闭/焦点返回', label, page, async () => {
      if (label === 'narrow') {
        await page.getByRole('tablist', { name: '选择看板列（窄屏）' }).getByRole('tab', { name: /In Progress/ }).click()
      }
      const card = page.locator('[aria-label^="#123 用户反馈收集"]').first()
      await card.focus()
      await page.keyboard.press('Enter')
      await page.getByRole('dialog', { name: /用户反馈收集/ }).waitFor()
      await page.keyboard.press('Escape')
      await page.getByRole('dialog', { name: /用户反馈收集/ }).waitFor({ state: 'detached' })
      const label2 = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '')
      assert(label2.includes('#123'), `焦点未返回发起卡片：${label2.slice(0, 30)}`)
    })
    await axeScan(page, '项目·看板', label)
    if (label === 'narrow') {
      await check('窄屏看板一次一列 + 列选择器', label, page, async () => {
        const selector = page.getByRole('tablist', { name: '选择看板列（窄屏）' })
        assert(await selector.isVisible(), '窄屏缺少列选择器')
        const visibleColumns = await page.locator('[class*="column_"]').evaluateAll((els) =>
          els.filter((el) => el.offsetParent !== null && el.getAttribute('aria-label')?.includes('项')).length,
        )
        assert(visibleColumns === 1, `窄屏可见列数 ${visibleColumns} ≠ 1`)
      })
    }
    await page.close()
  }

  // 真实拖拽（desktop）
  {
    const page = await pageAt('operator-day', '#/project/proj-saki/work', DESKTOP)
    await check('真实拖拽移动卡片', 'desktop', page, async () => {
      const card = page.locator('[aria-label^="#124 错误码体系"]').first()
      const backlog = page.locator('section[aria-label^="Backlog"]')
      await card.dragTo(backlog)
      await page.getByText(/已移动到 backlog/).waitFor({ timeout: 5000 })
      await backlog.getByText('错误码体系梳理与返回').waitFor()
    })
    await page.close()
  }

  // 看板冲突
  {
    const page = await pageAt('board-conflict', '#/project/proj-saki/work', DESKTOP)
    await check('看板指纹冲突 + 回滚', 'desktop', page, async () => {
      const card = page.locator('[aria-label^="#126 会话列表"]').first()
      await card.focus()
      await page.keyboard.press('Alt+ArrowLeft')
      await page.getByRole('alert').filter({ hasText: '冲突：远端状态已变化' }).waitFor({ timeout: 5000 })
      const ready = page.locator('section[aria-label^="Ready"]')
      await ready.getByText('会话列表支持关键词搜索').waitFor()
      // 冲突后重试成功
      await card.focus()
      await page.keyboard.press('Alt+ArrowLeft')
      await page.getByText(/已移动到 backlog/).waitFor({ timeout: 5000 })
    })
    await page.close()
  }

  // ------------------------------------------------------------ 5. CreateWorkItem
  {
    const page = await pageAt('operator-day', '#/work', DESKTOP)
    await check('CreateWorkItem 完整字段 + confirmed', 'desktop', page, async () => {
      await page.getByRole('button', { name: '提交需求' }).click()
      const dialog = page.getByRole('dialog', { name: '提交需求' })
      await dialog.waitFor()
      await dialog.getByLabel('目标 Project').waitFor()
      // revisions must be real numbers once loaded
      await dialog.getByText(/expected Project revision/).waitFor()
      await page.waitForFunction(() => !document.body.innerText.includes('读取 revision'))
      const title = `验证创建工作项 ${Date.now() % 100000}`
      await dialog.getByPlaceholder(/官网首页加上用户评价/).fill(title)
      await dialog.getByPlaceholder(/用户打开首页/).fill('看到评价')
      await dialog.getByRole('button', { name: '确认提交' }).click()
      await page.getByText(/已创建 Issue/).waitFor({ timeout: 5000 })
      await dialog.waitFor({ state: 'detached' })
      // 新项目出现在 Saki Inbox
      await page.goto(`${BASE}/?scenario=operator-day#/project/proj-saki/work`)
      await page.getByText(title).waitFor({ timeout: 5000 })
    })
    await page.close()
  }
  for (const [viewport, label] of [[DESKTOP, 'desktop'], [NARROW, 'narrow']]) {
    const page = await pageAt('create-item-outcomes', '#/work', viewport)
    await check('CreateWorkItem partial → 对账 → 安全重试', label, page, async () => {
      await dismissToasts(page)
      await page.getByRole('button', { name: '提交需求' }).click()
      const dialog = page.getByRole('dialog', { name: '提交需求' })
      await dialog.waitFor()
      await page.waitForFunction(() => !document.body.innerText.includes('读取 revision'))
      await dialog.getByPlaceholder(/官网首页加上用户评价/).fill('落地页用户见证模块')
      await dialog.getByPlaceholder(/用户打开首页/).fill('首页出现见证模块')
      await dialog.getByRole('button', { name: '确认提交' }).click()
      // partial: dialog stays open with reconciliation-required
      await dialog.getByText(/部分完成/).waitFor({ timeout: 5000 })
      assert(await dialog.isVisible(), '结果未收敛时对话框关闭了')
      await dialog.getByRole('button', { name: /对账检查/ }).click()
      await page.waitForTimeout(600)
      await dialog.getByRole('button', { name: '对账后安全重试' }).click()
      await dialog.waitFor({ state: 'detached', timeout: 5000 })
    })
    await check('CreateWorkItem ack 丢失 → reconciliation', label, page, async () => {
      await dismissToasts(page)
      await page.getByRole('button', { name: '提交需求' }).click()
      const dialog = page.getByRole('dialog', { name: '提交需求' })
      await dialog.waitFor()
      await page.waitForFunction(() => !document.body.innerText.includes('读取 revision'))
      await dialog.getByPlaceholder(/官网首页加上用户评价/).fill('页脚合规链接更新')
      await dialog.getByPlaceholder(/用户打开首页/).fill('页脚合规')
      await dialog.getByRole('button', { name: '确认提交' }).click()
      await dialog.getByText(/acknowledgement 丢失/).waitFor({ timeout: 5000 })
      await dialog.getByRole('button', { name: /对账检查/ }).click()
      await page.waitForTimeout(600)
      await dialog.getByRole('button', { name: '对账后安全重试' }).click()
      await dialog.waitFor({ state: 'detached', timeout: 5000 })
    })
    await page.close()
  }

  // ------------------------------------------------------------ 6. Settings 激活链 + policy 编辑
  {
    const page = await pageAt('operator-day', '#/project/proj-saki/project-settings', DESKTOP)
    await check('同步配置激活链', 'desktop', page, async () => {
      await page.getByText('GitHub 轮询间隔（秒）').waitFor()
      await page.locator('input[type="number"]').first().fill('45')
      await page.getByRole('button', { name: '保存同步配置' }).click()
      await page.getByText('已保存（saved）').waitFor()
      await page.getByText('保存成功不等于已启用').waitFor()
      await page.getByText('已启用（activated）').waitFor({ timeout: 10000 })
      const stepper = page.getByRole('list', { name: '同步激活流程' })
      assert(await stepper.getByText('新 checkpoint（checkpointed）').isVisible(), '激活链缺少 checkpoint 步骤')
    })
    await check('Automation Policy 编辑', 'desktop', page, async () => {
      await page.getByRole('radio', { name: '自动' }).click()
      await page.getByText(/Automation Policy 已更新/).waitFor({ timeout: 5000 })
      // wait for the confirmed projection to settle before the next edit
      await page.waitForFunction(
        () => {
          for (const r of document.querySelectorAll('input[type="radio"]')) if (r.value === 'auto') return r.checked
          return false
        },
        undefined,
        { timeout: 5000 },
      )
      const limitInput = page.locator('input[aria-label="模型请求 / 天 的上限"]')
      await limitInput.fill('250')
      await page.locator('[aria-label="保存 模型请求 / 天 的上限"]').click()
      await page.getByText(/Automation Policy 已更新/).nth(1).waitFor({ timeout: 5000 })
    })
    await check('Binding 在设置中只读 + owner 链接', 'desktop', page, async () => {
      assert((await page.getByRole('button', { name: /重新验证该目录/ }).count()) === 0, '设置里仍有 binding mutation')
      assert(await page.getByText(/修复由各自的 owner 流程承担/).isVisible(), '缺少 owner 说明')
    })
    await page.close()
  }

  // ------------------------------------------------------------ 7. 修复场景
  {
    const page = await pageAt('binding-repair', '#/projects', DESKTOP)
    await check('binding 修复（Projects 页入口）', 'desktop', page, async () => {
      await page.getByRole('button', { name: '修复 官网改版 的 Resource Binding' }).click()
      const dialog = page.getByRole('dialog', { name: /修复 Resource Binding/ })
      await dialog.waitFor()
      assert((await dialog.textContent()).includes('官网改版'), '确认对话框未标明项目')
      await dialog.getByRole('button', { name: '重新验证该目录' }).click()
      await page.getByText(/已重新验证/).waitFor({ timeout: 5000 })
    })
    await page.close()
  }
  {
    const page = await pageAt('mapping-repair', '#/project/proj-saki/work', DESKTOP)
    await check('mapping 修复恢复读写', 'desktop', page, async () => {
      await page.getByText(/需要修复/).first().waitFor()
      assert((await page.getByRole('button', { name: /移动 #/ }).count()) === 0, '修复模式下列片仍可移动')
      await page.getByRole('button', { name: /修复映射/ }).click()
      await page.getByText(/已修复/).waitFor({ timeout: 5000 })
      await page.getByRole('button', { name: /移动 #/ }).first().waitFor()
    })
    await page.close()
  }
  {
    const page = await pageAt('budget-paused', '#/project/proj-saki/project-settings', DESKTOP)
    await check('预算例外（高风险确认）', 'desktop', page, async () => {
      await page.getByText(/预算耗尽|暂停/).first().waitFor()
      await page.getByRole('button', { name: '授权一次性预算例外' }).click()
      const dialog = page.getByRole('dialog', { name: /授权一次性预算例外 · Saki/ })
      await dialog.waitFor()
      assert((await dialog.textContent()).includes('24 小时'), '例外对话框缺少 24 小时过期说明')
      await dialog.getByRole('button', { name: '确认授权例外' }).click()
      await page.getByText(/已记录一次性预算例外/).waitFor({ timeout: 5000 })
    })
    await page.close()
  }
  {
    const page = await pageAt('reconnect-recovery', '#/work', DESKTOP)
    await check('重连恢复 · 需要对账', 'desktop', page, async () => {
      await page.getByText('需要对账').first().waitFor()
      await page.getByRole('button', { name: /处理：一条 Dispatch 结果不明/ }).click()
      await page.waitForURL(/sessions/)
    })
    await page.close()
  }

  // ------------------------------------------------------------ 8. 离线 + Empty ×3
  {
    const page = await pageAt('offline', '#/project/proj-saki/work', DESKTOP)
    await check('离线语义 + 看板只读 + 本地区段可用', 'desktop', page, async () => {
      await page.getByText('离线').first().waitFor()
      await page.getByText(/看板写入/).waitFor()
      assert((await page.getByRole('button', { name: /移动 #/ }).count()) === 0, '离线时仍有移动按钮')
      await page.getByRole('tab', { name: '变更' }).click()
      await page.getByText('已暂存').first().waitFor()
    })
    await page.close()
  }
  {
    const page = await pageAt('empty-states', '#/project/proj-website/work', DESKTOP)
    await check('Empty · 首次扫描未完成', 'desktop', page, async () => {
      await page.getByText(/首次扫描尚未完成/).first().waitFor()
    })
    await page.goto(`${BASE}/?scenario=empty-states#/work`)
    await check('Empty · 不存在', 'desktop', page, async () => {
      await page.getByText('现在没有与你相关的工作').waitFor()
    })
    await page.close()
    const page2 = await pageAt('operator-day', '#/project/proj-saki/work', DESKTOP)
    await check('Empty · 筛选排除', 'desktop', page2, async () => {
      await page2.getByLabel('按里程碑筛选看板').selectOption('v0.1.0')
      await page2.getByText(/筛选结果为空/).waitFor()
      await page2.getByRole('button', { name: '清除筛选' }).click()
      await page2.getByText('用户反馈收集与分析看板').first().waitFor()
    })
    await page2.close()
  }

  // ------------------------------------------------------------ 9. bootstrap secret
  {
    const page = await pageAt('fresh-install', '', DESKTOP)
    await check('bootstrap + secret 即用即清', 'desktop', page, async () => {
      await page.getByText('欢迎使用 Saki').waitFor()
      await page.getByPlaceholder(/7f3a/).fill('test-secret')
      await page.getByRole('button', { name: '继续' }).click()
      await page.getByPlaceholder('例如：你').fill('你')
      await page.getByRole('button', { name: '上一步' }).click()
      const val = await page.getByPlaceholder(/7f3a/).inputValue()
      assert(val === '', `secret 未被清除：${val}`)
      await page.getByPlaceholder(/7f3a/).fill('test-secret')
      await page.getByRole('button', { name: '继续' }).click()
      await page.getByPlaceholder('例如：你').fill('你')
      await page.getByRole('button', { name: '继续' }).click()
      await page.locator('button[class*="candidate"]').first().click()
      await page.getByRole('checkbox').check()
      await page.getByRole('button', { name: '确认登记' }).click()
      await page.getByText(/已完成 bootstrap 并登记了第一个/).waitFor({ timeout: 8000 })
      await page.getByRole('button', { name: '打开 Development Workspace' }).click()
      await page.getByRole('tab', { name: '看板' }).waitFor()
    })
    await page.close()
  }

  // ------------------------------------------------------------ 10. 导航状态
  {
    const page = await pageAt('operator-day', '#/project/proj-saki/work', DESKTOP)
    await check('地址序列化 + reload 恢复', 'desktop', page, async () => {
      const card = page.locator('[aria-label^="#123 用户反馈收集"]').first()
      await card.focus()
      await page.keyboard.press('Enter')
      await page.getByRole('dialog', { name: /用户反馈收集/ }).waitFor()
      assert(page.url().includes('item=wi-123'), '地址缺少 item 参数')
      await page.reload()
      await page.getByRole('dialog', { name: /用户反馈收集/ }).waitFor({ timeout: 8000 })
    })
    await check('Settings 返回原 owner', 'desktop', page, async () => {
      await page.keyboard.press('Escape')
      await page.getByRole('dialog', { name: /用户反馈收集/ }).waitFor({ state: 'detached' })
      await page.getByRole('navigation').getByRole('button', { name: '设置' }).click()
      await page.getByRole('dialog', { name: '设置' }).waitFor()
      await page.keyboard.press('Escape')
      await page.getByRole('dialog', { name: '设置' }).waitFor({ state: 'detached' })
      await page.getByRole('tab', { name: '看板' }).waitFor()
      assert(page.url().includes('/project/proj-saki/'), `关闭设置未返回项目页：${page.url()}`)
    })
    await check('Project 切换保留区段', 'desktop', page, async () => {
      await page.getByRole('tab', { name: '变更' }).click()
      await page.getByRole('tab', { name: '变更', selected: true }).waitFor()
      await page.getByLabel('切换 Development Project').selectOption('proj-website')
      await page.waitForURL(/proj-website\/changes/)
    })
    await page.close()
  }

  // ------------------------------------------------------------ 11. Model Supply
  {
    const page = await pageAt('model-supply', '', DESKTOP)
    await check('Model Supply 内容', 'desktop', page, async () => {
      await page.getByLabel('账号列表').getByText('Codex Pro（个人）').waitFor()
      await page.getByLabel('账号列表').getByText('Kimi 订阅（个人）').waitFor()
      await page.getByText('用量数据暂时不可用').first().waitFor()
      await page.getByText(/local-user-trust/).first().waitFor()
    })
    await check('Generation Job 取消与重试', 'desktop', page, async () => {
      await page.getByRole('button', { name: /取消任务/ }).first().click()
      await page.getByText(/已取消排队中的 Generation Job/).waitFor({ timeout: 5000 })
      // wait for the canceled state inside the jobs list specifically: the
      // projection reload (new revision) has landed only then
      await page.getByRole('list', { name: '生成任务列表' }).getByText('已取消', { exact: false }).waitFor({ timeout: 5000 })
      await page.getByRole('button', { name: /重试任务/ }).first().click()
      await page.getByText(/已重新排队该 Generation Job/).waitFor({ timeout: 5000 })
    })
    await axeScan(page, 'Model Supply', 'desktop')
    await page.close()
  }

  // ------------------------------------------------------------ 12. 多项目隔离
  {
    const page = await pageAt('operator-day', '#/project/proj-saki/changes', DESKTOP)
    await check('多项目隔离：Saki 暂存不影响官网改版', 'desktop', page, async () => {
      // Saki: stage one file (per-file button names include the path)
      await page.getByRole('button', { name: /^暂存 \S/ }).first().click()
      await page.getByText(/已暂存 1 个文件/).waitFor({ timeout: 5000 })
      // 官网改版 changes stays empty
      await page.getByLabel('切换 Development Project').selectOption('proj-website')
      await page.waitForURL(/proj-website\/changes/)
      await page.getByText('无未暂存文件').waitFor({ timeout: 5000 })
      assert((await page.locator('[class*="fileRow"]').count()) === 0, '官网改版 Changes 被 Saki 的暂存污染')
    })
    await page.close()
  }

  // ------------------------------------------------------------ 13. 窄屏会话返回
  {
    const page = await pageAt('operator-day', '#/project/proj-saki/sessions', NARROW)
    await check('窄屏会话列表/详情互斥', 'narrow', page, async () => {
      await page.getByText('#117 修复会话导出格式问题').click()
      await page.getByRole('button', { name: /返回列表/ }).waitFor()
      await page.getByRole('button', { name: /返回列表/ }).click()
      await page.getByText('#117 修复会话导出格式问题').waitFor()
    })
    await page.close()
  }
} finally {
  await browser.close()
  await server.stop()
}

writeFileSync(join(resultsDir, 'results.json'), JSON.stringify(results, null, 2))
const fails = results.filter((r) => r.outcome === 'fail')
console.log(`\n${results.length} checks, ${fails.length} failed`)
process.exit(fails.length ? 1 : 0)
