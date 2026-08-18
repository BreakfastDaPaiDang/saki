import { chromium } from 'playwright'
const FRAMES = 'D:/saki-worktrees/issue-42-k0-prototype/.playwright-mcp/gif-frames-k0'
const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
const page = await context.newPage()

// 00 My Work with attention + groups
await page.goto('http://localhost:5243/?scenario=operator-day#/work')
await page.getByRole('heading', { name: '我的工作' }).waitFor()
await page.getByText('需要关注').waitFor()
await page.screenshot({ path: `${FRAMES}/00-my-work.png` })

// 01 交给 Agent pre-submit dialog
await page.getByRole('button', { name: '交给 Agent' }).first().click()
await page.getByText('Model Route').waitFor()
await page.screenshot({ path: `${FRAMES}/01-offer-confirm.png` })
await page.getByRole('button', { name: '取消' }).click()

// 02 Board
await page.goto('http://localhost:5243/?scenario=operator-day#/project/proj-saki/work')
await page.locator('[aria-label^="#123 用户反馈收集"]').waitFor()
await page.screenshot({ path: `${FRAMES}/02-board.png` })

// 03 Work item drawer
await page.locator('[aria-label^="#123 用户反馈收集"]').first().focus()
await page.keyboard.press('Enter')
await page.getByRole('dialog', { name: /用户反馈收集/ }).waitFor()
await page.getByText('等待你回答').waitFor()
await page.screenshot({ path: `${FRAMES}/03-drawer.png` })

// 04 Sessions & runs
await page.goto('http://localhost:5243/?scenario=operator-day#/project/proj-saki/sessions')
await page.getByText('运行时间线').waitFor()
await page.screenshot({ path: `${FRAMES}/04-sessions.png` })

// 05 Board conflict
await page.goto('http://localhost:5243/?scenario=board-conflict#/project/proj-saki/work')
await page.locator('[aria-label^="#126 会话列表"]').waitFor()
await page.locator('[aria-label^="#126 会话列表"]').first().focus()
await page.keyboard.press('Alt+ArrowLeft')
await page.getByRole('alert').waitFor()
await page.screenshot({ path: `${FRAMES}/05-conflict.png` })

// 06 Model Supply
await page.goto('http://localhost:5243/?scenario=model-supply#/settings/model-supply')
await page.getByLabel('账号列表').getByText('Codex Pro（个人）').waitFor()
await page.getByRole('heading', { name: 'Generation Jobs' }).waitFor()
await page.screenshot({ path: `${FRAMES}/06-model-supply.png` })

await browser.close()
console.log('frames done')
