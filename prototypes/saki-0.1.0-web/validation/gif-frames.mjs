/**
 * Records the K0 demo GIF frames against the production build served by
 * `vite preview` (via the shared server helper). Frames land in the repo's
 * gitignored .playwright-mcp/gif-frames-k0/; encode with the
 * record-browser-gif skill's encoder.
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { startPreview } from './server.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const FRAMES = join(root, '..', '..', '.playwright-mcp', 'gif-frames-k0')
mkdirSync(FRAMES, { recursive: true })

const server = await startPreview(root)
const BASE = `http://127.0.0.1:${server.port}`
const browser = await chromium.launch()
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()

try {
  // 00 My Work: attention groups + four presentation groups
  await page.goto(`${BASE}/?scenario=operator-day#/work`)
  await page.getByRole('heading', { name: '我的工作' }).waitFor()
  await page.getByText('需要关注').waitFor()
  await page.screenshot({ path: `${FRAMES}/00-my-work.png` })

  // 01 交给 Agent pre-submit review
  await page.getByRole('button', { name: '交给 Agent' }).first().click()
  await page.getByText('Model Route').waitFor()
  await page.screenshot({ path: `${FRAMES}/01-offer-confirm.png` })
  await page.getByRole('button', { name: '取消' }).click()

  // 02 Board
  await page.goto(`${BASE}/?scenario=operator-day#/project/proj-saki/work`)
  await page.locator('[aria-label^="#123 用户反馈收集"]').waitFor()
  await page.screenshot({ path: `${FRAMES}/02-board.png` })

  // 03 Work item drawer with open intervention
  await page.locator('[aria-label^="#123 用户反馈收集"]').first().focus()
  await page.keyboard.press('Enter')
  await page.getByRole('dialog', { name: /用户反馈收集/ }).waitFor()
  await page.getByText('等待你处理').waitFor()
  await page.screenshot({ path: `${FRAMES}/03-drawer.png` })

  // 04 Sessions & runs timeline
  await page.goto(`${BASE}/?scenario=operator-day#/project/proj-saki/sessions`)
  await page.getByText('运行时间线').waitFor()
  await page.screenshot({ path: `${FRAMES}/04-sessions.png` })

  // 05 Board conflict with rollback
  await page.goto(`${BASE}/?scenario=board-conflict#/project/proj-saki/work`)
  await page.locator('[aria-label^="#126 会话列表"]').waitFor()
  await page.locator('[aria-label^="#126 会话列表"]').first().focus()
  await page.keyboard.press('Alt+ArrowLeft')
  await page.getByRole('alert').waitFor()
  await page.screenshot({ path: `${FRAMES}/05-conflict.png` })

  // 06 Model Supply
  await page.goto(`${BASE}/?scenario=model-supply#/settings/model-supply`)
  await page.getByLabel('账号列表').getByText('Codex Pro（个人）').waitFor()
  await page.getByRole('heading', { name: 'Generation Jobs' }).waitFor()
  await page.screenshot({ path: `${FRAMES}/06-model-supply.png` })
} finally {
  await browser.close()
  await server.stop()
}
console.log('frames done')
