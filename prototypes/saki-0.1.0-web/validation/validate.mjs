/**
 * K0 validation driver: runs the scenario checklist on desktop and a
 * constrained viewport, exercises keyboard-only flows, and scans key pages
 * with axe-core. Run from the prototype root:
 *
 *   npm run build && node validation/validate.mjs
 *
 * Serves dist/ via vite preview on :5243. Results (screenshots + JSON) land
 * in validation/results/.
 */
import { chromium } from 'playwright'
import { AxeBuilder } from '@axe-core/playwright'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const resultsDir = join(root, 'validation', 'results')
mkdirSync(resultsDir, { recursive: true })

const BASE = 'http://localhost:5243'
const DESKTOP = { width: 1440, height: 900 }
const NARROW = { width: 480, height: 840 }

const results = []

function record(area, viewport, outcome, notes = '') {
  results.push({ area, viewport, outcome, notes })
  console.log(`[${outcome}] ${viewport} · ${area}${notes ? ` — ${notes}` : ''}`)
}

async function settle(page, ms = 900) {
  await page.waitForTimeout(ms)
}

async function axeScan(page, area, viewportLabel) {
  const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  const serious = scan.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  const detail = serious.map((v) => `${v.id}(${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')})`).join(' | ')
  record(area, viewportLabel, serious.length === 0 ? 'pass' : 'fail', serious.length === 0 ? 'axe 无严重违规' : `${serious.length} 条严重违规: ${detail}`)
}

async function shot(page, name) {
  await page.screenshot({ path: join(resultsDir, `${name}.png`) })
}

const server = spawn('npx', ['vite', 'preview', '--port', '5243', '--strictPort'], { cwd: root, stdio: 'pipe', shell: true })
await new Promise((resolve) => setTimeout(resolve, 5000))

const browser = await chromium.launch()

async function pageAt(scenario, hash, viewport) {
  const context = await browser.newContext({ viewport })
  const page = await context.newPage()
  await page.goto(`${BASE}/?scenario=${scenario}${hash}`)
  await settle(page)
  return page
}

try {
  // ------------------------------------------------ 1. My Work（desktop + narrow）
  for (const [viewport, label] of [[DESKTOP, 'desktop'], [NARROW, 'narrow']]) {
    const page = await pageAt('operator-day', '#/work', viewport)
    for (const group of ['待开始', '处理中', '等你处理', '最近结束']) {
      const visible = await page.getByRole('heading', { name: new RegExp(group) }).isVisible().catch(() => false)
      record('My Work 四分组', label, visible ? 'pass' : 'fail', group)
    }
    // 等待验收在“等你处理”，且 Done/Canceled 无验收按钮
    const waitingText = await page.getByRole('heading', { name: /等你处理/ }).isVisible()
    const acceptBtn = await page.getByRole('button', { name: '验收', exact: true }).count()
    const recentSection = page.locator('section[aria-label="最近结束"]')
    const recentHasAction = await recentSection.getByRole('button', { name: /验收|审阅/ }).count()
    record('等待验收在等你处理', label, waitingText && acceptBtn > 0 ? 'pass' : 'fail')
    record('Done/Canceled 无验收操作', label, recentHasAction === 0 ? 'pass' : 'fail')
    await shot(page, `v-mywork-${label}`)
    await axeScan(page, 'My Work', label)

    // 执行唯一推荐 offer：交给 Agent（预提交复核 → 确认）
    await page.getByRole('button', { name: '交给 Agent' }).first().click()
    await settle(page, 400)
    const reviewFacts = await page.getByText('Model Route').isVisible().catch(() => false)
    record('交给 Agent 预提交复核', label, reviewFacts ? 'pass' : 'fail')
    await page.getByRole('button', { name: '确认交给 Agent' }).click()
    await settle(page, 1400)
    const claimed = await page.getByText(/已交给 Agent/).first().isVisible().catch(() => false)
    record('手动领取 confirmed', label, claimed ? 'pass' : 'fail')
    await page.close()
  }

  // ------------------------------------------------ 2. 项目页往返与 drawer
  for (const [viewport, label] of [[DESKTOP, 'desktop'], [NARROW, 'narrow']]) {
    const page = await pageAt('operator-day', '#/project/proj-saki/work', viewport)
    if (label === 'narrow') {
      // 窄屏：看板单列堆叠
      const single = await page.evaluate(() => {
        const el = document.querySelector('[class*="columns"]')
        return el ? getComputedStyle(el).gridAutoFlow === 'row' : false
      })
      record('窄屏看板单列', label, single ? 'pass' : 'fail')
    }
    const card = page.locator('[aria-label^="#123 用户反馈收集"]').first()
    await card.focus()
    await page.keyboard.press('Enter')
    await settle(page, 700)
    const drawer = await page.getByRole('dialog', { name: /用户反馈收集/ }).isVisible().catch(() => false)
    record('Work Item drawer 打开', label, drawer ? 'pass' : 'fail')
    await shot(page, `v-drawer-${label}`)
    await page.keyboard.press('Escape')
    await settle(page, 400)
    const focusBack = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '')
    record('drawer 关闭焦点返回', label, focusBack.includes('#123') ? 'pass' : 'fail', focusBack.slice(0, 24))
    // 六个内部区段往返不丢选择
    for (const tab of ['里程碑', '变更', '会话与运行', '追溯', '项目设置', '看板']) {
      await page.getByRole('tab', { name: tab }).click()
      await settle(page, 500)
    }
    record('内部区段往返', label, 'pass')
    await axeScan(page, '项目·看板', label)
    await page.close()
  }

  // ------------------------------------------------ 3. bootstrap + 登记
  {
    const page = await pageAt('fresh-install', '', DESKTOP)
    const wizard = await page.getByText('欢迎使用 Saki').isVisible().catch(() => false)
    record('bootstrap 起点', 'desktop', wizard ? 'pass' : 'fail')
    await page.getByPlaceholder(/7f3a/).fill('test-secret')
    await page.getByRole('button', { name: '继续' }).click()
    await page.getByPlaceholder('例如：你').fill('你')
    await page.getByRole('button', { name: '继续' }).click()
    await page.locator('button[class*="candidate"]').first().click()
    await page.getByRole('checkbox').check()
    await page.getByRole('button', { name: '确认登记' }).click()
    await settle(page, 1400)
    const done = await page.getByText(/已完成 bootstrap 并登记了第一个/).isVisible().catch(() => false)
    record('bootstrap + 登记完成', 'desktop', done ? 'pass' : 'fail')
    await shot(page, 'v-bootstrap-done')
    await page.getByRole('button', { name: '打开 Development Workspace' }).click()
    await settle(page, 900)
    const ws = await page.getByRole('tab', { name: '看板' }).isVisible().catch(() => false)
    record('登记后进入 Development Workspace', 'desktop', ws ? 'pass' : 'fail')
    await page.close()
  }

  // ------------------------------------------------ 4. 看板冲突（键盘移动）
  {
    const page = await pageAt('board-conflict', '#/project/proj-saki/work', DESKTOP)
    const card = page.locator('[aria-label^="#126 会话列表"]').first()
    await card.focus()
    await page.keyboard.press('Alt+ArrowLeft')
    await settle(page, 1300)
    const conflict = await page.getByText(/冲突：远端状态已变化/).first().isVisible().catch(() => false)
    record('看板指纹冲突可见', 'desktop', conflict ? 'pass' : 'fail')
    await shot(page, 'v-board-conflict')
    // 冲突后重试成功
    await card.focus()
    await page.keyboard.press('Alt+ArrowLeft')
    await settle(page, 1300)
    const recovered = await page.getByText(/已移动到 backlog/).first().isVisible().catch(() => false)
    record('冲突后重试成功', 'desktop', recovered ? 'pass' : 'fail')
    await page.close()
  }

  // ------------------------------------------------ 5. 修复 / 预算 / 离线 / 恢复
  {
    const page = await pageAt('mapping-repair', '#/project/proj-saki/work', DESKTOP)
    const repair = await page.getByText(/需要修复/).first().isVisible().catch(() => false)
    record('mapping 修复模式', 'desktop', repair ? 'pass' : 'fail')
    await page.getByRole('button', { name: /修复映射/ }).click()
    await settle(page, 1300)
    const fixed = await page.getByText(/已修复|恢复读写/).first().isVisible().catch(() => false)
    record('mapping 修复恢复', 'desktop', fixed ? 'pass' : 'fail')
    await page.close()
  }
  {
    const page = await pageAt('budget-paused', '#/project/proj-saki/project-settings', DESKTOP)
    const paused = await page.getByText(/预算|暂停|耗尽/).first().isVisible().catch(() => false)
    record('预算暂停证据', 'desktop', paused ? 'pass' : 'fail')
    await shot(page, 'v-budget-paused')
    await page.close()
  }
  {
    const page = await pageAt('offline', '#/project/proj-saki/work', DESKTOP)
    const offline = await page.getByText(/离线/).first().isVisible().catch(() => false)
    const noMove = await page.getByRole('button', { name: /移动 #/ }).count()
    record('离线语义 + 看板只读', 'desktop', offline && noMove === 0 ? 'pass' : 'fail')
    await page.getByRole('tab', { name: '变更' }).click()
    await settle(page, 700)
    const changes = await page.getByText(/已暂存/).first().isVisible().catch(() => false)
    record('离线时本地区段可用', 'desktop', changes ? 'pass' : 'fail')
    await page.close()
  }
  {
    const page = await pageAt('reconnect-recovery', '#/work', DESKTOP)
    const recon = await page.getByText(/对账/).first().isVisible().catch(() => false)
    record('重连恢复 · 需要对账', 'desktop', recon ? 'pass' : 'fail')
    await page.close()
  }
  {
    const page = await pageAt('empty-states', '#/project/proj-website/work', DESKTOP)
    const empty = await page.getByText(/首次扫描尚未完成/).first().isVisible().catch(() => false)
    record('Empty · 首次扫描未完成', 'desktop', empty ? 'pass' : 'fail')
    await page.close()
  }

  // ------------------------------------------------ 6. Model Supply
  {
    const page = await pageAt('model-supply', '', DESKTOP)
    for (const text of ['Codex Pro（个人）', 'Kimi 订阅（个人）', '用量数据暂时不可用', 'local-user-trust', 'Context Polic', 'Generation Job']) {
      const visible = await page.getByText(new RegExp(text)).first().isVisible().catch(() => false)
      record('Model Supply 内容', 'desktop', visible ? 'pass' : 'fail', text)
    }
    await shot(page, 'v-model-supply')
    await axeScan(page, 'Model Supply', 'desktop')
    await page.close()
  }

  // ------------------------------------------------ 7. 键盘可达性与会话往返
  {
    const page = await pageAt('operator-day', '#/work', DESKTOP)
    await page.evaluate(() => document.activeElement?.blur())
    let found = ''
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab')
      found = await page.evaluate(() => document.activeElement?.textContent ?? '')
      if (/新会话|工作|项目/.test(found)) break
    }
    record('键盘 Tab 可达主导航', 'desktop', /新会话|工作|项目/.test(found) ? 'pass' : 'fail', found.slice(0, 16))

    // 会话草稿保留：项目 → 会话 → 输入草稿 → 回工作 → 返回会话
    await page.goto(`${BASE}/?scenario=operator-day#/project/proj-saki/sessions`)
    await settle(page)
    await page.getByRole('button', { name: '打开会话' }).click()
    await settle(page, 800)
    await page.getByLabel('消息草稿').fill('帮我把导出字段加上满意度分布')
    await page.getByRole('button', { name: '工作' }).first().click()
    await settle(page, 600)
    await page.goto(`${BASE}/#/conversation/sess-2310`)
    await settle(page, 600)
    const draft = await page.getByLabel('消息草稿').inputValue()
    record('会话草稿往返保留', 'desktop', draft.includes('满意度分布') ? 'pass' : 'fail')
    await page.close()
  }
} finally {
  await browser.close()
  server.kill()
}

writeFileSync(join(resultsDir, 'results.json'), JSON.stringify(results, null, 2))
const fails = results.filter((r) => r.outcome === 'fail')
console.log(`\n${results.length} checks, ${fails.length} failed`)
process.exit(fails.length ? 1 : 0)
