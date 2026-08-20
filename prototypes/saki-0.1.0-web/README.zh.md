# Saki 0.1.0 Web 低保真交互 prototype（K0 / issue #42）

[English](README.md) | 中文

这是 Saki 0.1.0 两个新增顶层页面（「工作」与「项目」）的可点击、可键盘操作的低保真 prototype。它验证：保留现有 DSH 壳层（Conversation、New Session、Settings）时，Host Operator 与小白用户都能在 desktop 与受限 viewport 上完成 0.1.0 的任务流。

它不是生产代码：fixture 字段只用于表达[前端约定](../../../docs/saki/architecture/0.1.0-frontend-contract.zh.md)，不是最终 wire type；布局、密度与配色也不是验收条件。底部场景工具条仅属 K0，不进入生产实现。

## 运行

```sh
npm ci
npm run dev        # http://localhost:5242
npm run build      # tsc --noEmit + vite build
node validation/validate.mjs   # Playwright + axe checklist against the production build
```

可用 `?scenario=<id>` 直达某个场景，例如 `http://localhost:5242/?scenario=board-conflict`。

## 怎么读这个 prototype

- 底部琥珀色条是 **prototype 工具**（不是产品 UI）：切换十二个命名场景或打开场景索引；索引同时以文档形式维护在 [SCENARIOS.md](SCENARIOS.md)。
- 应用内有一个模拟控制面（`src/fixtures/engine.ts`），只暴露契约中的三个操作：`query`（完整 Projection + revision）、`submit`（typed Intent + expected revision → 从 pending 到终态保持同一个稳定 receipt id）、`onChanged`（失效通知 → 完整重查）。过时的 expected revision 会以 conflict 拒绝。组件不 join 后端记录、不按 Work Item Status 猜按钮；每个 Action Offer 与白话原因都来自 Projection。
- 键盘：Tab 可达全部交互控件；看板卡片聚焦后 `Enter` 开详情、`Alt+←/→` 移动列（与「移动…」菜单同为拖拽等效）；对话框与抽屉 Esc 关闭并把焦点还给发起控件。
- 桌面与受限 viewport（<720px）都能完成全部流程，不要求多个 pane 同时可见：侧边栏变为抽屉、看板一次一列（列选择器切换）、详情抽屉全屏、会话与运行列表/详情互斥显示。

## 目录

- `src/contract/` — 从约定镜像的 Projection / Intent / Action Offer / 视图地址 / 状态语义类型
- `src/fixtures/` — 模拟控制面 + 命名场景；每个场景声明它模拟的 Projection、接受的 Intent 与演示的结果
- `src/client/` — snapshot store、导航（typed `SakiViewAddress`，hash + localStorage 持久化）、React 绑定
- `src/shell/` — AppFrame / 侧边栏占位（保留 DSH 元素）+ prototype 工具条
- `src/pages/` — bootstrap、「工作」、「项目」六个内部区段、继承的 Conversation / New Session 占位、Settings 对话框（Model Supply 分节）
- `validation/` — Playwright + axe 检查清单及其结果

## 仓库门控

prototype 位于 pnpm workspace glob 之外，因此 package 级门控（knip、publint、workspace constraints、按文件 coverage）不适用于它；仓库级暂存门控仍然适用：本 README 维护双语配对，暂存的源码通过 lint 与空白检查，K0 Agent Note 通过 note 格式与翻译配对门控。

## 交付物

- 场景索引：[SCENARIOS.md](SCENARIOS.md)
- affordance → Projection/Intent 清单：[AFFORDANCES.md](AFFORDANCES.md)
- 未决产品问题：[OPEN-QUESTIONS.md](OPEN-QUESTIONS.md)
- 验证记录：[VALIDATION.md](VALIDATION.md)
