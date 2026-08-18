# 验证记录（K0）

验证方式：`npm run build && node validation/validate.mjs`（Playwright + axe-core，对 `vite preview` 服务的生产构建跑真实浏览器）。原始结果存于 `validation/results/results.json`，逐场景截图在同目录。最近一次运行：**48 项检查全部通过**。

## 逐场景清单（desktop 1440×900 与受限 viewport 480×840）

| 检查 | desktop | 窄屏 |
|---|---|---|
| My Work 四分组（待开始/处理中/等你处理/最近结束） | pass | pass |
| 等待验收在“等你处理”；Done/Canceled 无验收操作 | pass | pass |
| 每项最多一个 Action Offer 与白话原因；交给 Agent 预提交复核（Profile/Route/权限/Binding/限制） | pass | pass |
| 手动领取 confirmed（receipt 可见） | pass | pass |
| axe-core（wcag2a/aa）无严重违规 | pass | pass |
| Work Item drawer 打开、Esc 关闭、焦点返回发起卡片 | pass | pass |
| 六个内部区段往返不丢选择 | pass | pass |
| 窄屏看板单列堆叠、不要求多 pane 同屏 | — | pass |

desktop 场景（含键盘操作）：

- bootstrap：一次性 secret → 创建 Principal → 复核 Git top level/重复候选/dirty-state → 确认登记 → 进入 Development Workspace（pass）。
- 看板冲突：`Alt+←` 键盘移动 → 乐观 overlay → 冲突文案可见；重试 confirmed（pass）。
- mapping 修复：只读修复模式可见；修复后恢复读写（pass）。
- 预算暂停：暂停证据、耗尽维度与未知观察可见（pass）。
- 离线：离线文字语义、看板只读（无移动操作）；变更区段仍可用（pass）。
- 重连恢复：「需要对账」以白话出现在「工作」的需要关注区（pass）。
- 空状态：首次扫描未完成的 Empty 语义（pass）。
- Model Supply：多 Profile、Usage Snapshot 三态、local-user-trust、Context Policy、Generation Job 队列；axe 无严重违规（pass）。

## 键盘与无障碍

- Tab 可达主导航；看板卡片聚焦后 `Enter` 开 drawer、`Alt+←/→` 移动列（与拖拽等价）、每张卡有「移动…」菜单；dialog/drawer Esc 关闭并把焦点还给发起控件（pass）。
- 会话草稿往返保留：项目 → 会话与运行 → 打开会话 → 输入草稿 → 回「工作」→ 重进会话，草稿恢复（pass）。
- axe-core 扫描覆盖「工作」、看板、Model Supply 三处关键页面，均无严重违规；扫描曾发现并已修复：主色按钮对比度、紫色 chip 对比度、tablist 角色缺失、list 语义滥用、drawer 未处理 Esc。

## GIF

`k0-prototype-demo.gif`（17s）展示真实 prototype 路径：「工作」（需要关注 + 四分组）→ 交给 Agent 预提交复核 → 看板 → Work Item drawer（等待回答）→ 会话与运行时间线 → 看板冲突 → Model Supply。录制自本分支 `vite preview` 服务的生产构建；fixture 驱动的 prototype 录制，不替代后续生产 PR 从真实 Saki server/model flow 录制的 GIF。
