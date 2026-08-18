# Saki 0.1.0 Web 低保真交互 prototype（K0 / issue #42）

这是 Saki 0.1.0 两个新增顶层页面（「工作」与「项目」）的可点击、可键盘操作的低保真 prototype。它验证：保留现有 DSH 壳层（Conversation、New Session、Settings）且只增加两个顶层页面时，Host Operator 与小白用户都能完成 0.1.0 的关键任务。

它不是生产代码：fixture 字段只用于表达 [前端约定](../../../docs/saki/architecture/0.1.0-frontend-contract.zh.md)，不是最终 wire type；视觉（布局、密度、配色）也不是验收条件。

## 运行

```sh
npm install
npm run dev        # http://localhost:5242
npm run build      # tsc --noEmit + vite build
```

可用 `?scenario=<id>` 直达某个场景，例如 `http://localhost:5242/?scenario=board-conflict`。

## 怎么读这个 prototype

- 底部琥珀色条是 **prototype 工具条**（不是产品 UI）：切换 11 个命名场景、打开场景索引。场景索引同时以文档形式维护在 [SCENARIOS.md](SCENARIOS.md)。
- 应用内有一个模拟控制面（`src/fixtures/engine.ts`），只暴露契约中的三个操作：`query`（完整 Projection + revision）、`submit`（typed Intent + expected revision → receipt）、`onChanged`（失效通知 → 重新查询完整 Projection）。UI 不 join 后端记录、不按 Work Item Status 猜按钮；每个 Action Offer 与原因都来自 Projection。
- 键盘：Tab 走全部交互控件；看板卡片聚焦后 `Enter` 开详情、`Alt+←/→` 移动列（等效拖拽）、每张卡还有「移动…」菜单；对话框 Esc 关闭并把焦点还给发起控件。`Alt+←/→` 等键盘移动与拖拽都会携带已确认远端指纹。
- 桌面与受限 viewport（<720px）都能完成全部流程：窄屏下侧边栏变为抽屉、看板列纵向堆叠、详情抽屉全屏、会话与运行列表/详情互斥显示，不要求多个 pane 同时可见。

## 目录

- `src/contract/` — 从约定镜像的 Projection / Intent / Action Offer / View Address / 状态语义类型
- `src/fixtures/` — 模拟控制面 + 命名场景（每个场景声明它模拟的 Projection、接受的 Intent 与演示结果）
- `src/client/` — snapshot store、导航（typed `SakiViewAddress`，hash + localStorage 持久化）、React 绑定
- `src/shell/` — AppFrame / 侧边栏占位（保留 DSH 元素）+ prototype 工具条
- `src/pages/` — bootstrap、「工作」、「项目」六个内部区段、继承的 Conversation / New Session 占位、Settings 对话框（Model Supply 分节）

## 交付物

- 场景索引：[SCENARIOS.md](SCENARIOS.md)
- 每条 affordance 对应的 Projection / Intent：[AFFORDANCES.md](AFFORDANCES.md)
- 需要产品决定的未决问题：[OPEN-QUESTIONS.md](OPEN-QUESTIONS.md)
- 验证记录（desktop / 受限 viewport / 键盘 / axe）：[VALIDATION.md](VALIDATION.md)
