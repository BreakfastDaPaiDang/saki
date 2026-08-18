# 场景索引（K0）

每个场景是一组命名、可切换的文档化 fixture。fixture 标明它模拟的 Projection、接受的 Intent 与演示的结果；字段只表达约定，不是最终 wire type。底部工具条可切换场景，也可用 `?scenario=<id>` 直达。

| # | id | 场景 | 模拟的 Projection | 演示的 Intent 与结果 | 覆盖的验收点 |
|---|---|---|---|---|---|
| 1 | `operator-day` | 日常 · 手动模式 | My Work、Project index、Board、Work Item detail、Changes、Session view、Attention Inbox、Automation、Model Supply | `claim-work-item` 成功（交给 Agent）；`answer-intervention` 成功；`accept-deliverable` 成功；`stage-files` / `unstage-files` / `commit` / `push` / `create-pr` 成功 | My Work 四分组与单一 Action Offer；手动领取；等待回答与等待验收同属“等你处理”；Done/Canceled 无验收操作；Changes 到交付 |
| 2 | `fresh-install` | 首次启动 · bootstrap 与项目登记 | 空 Project index、空 My Work、空 Attention | `complete-bootstrap`、`register-project` 成功 | 一次性 bootstrap；复核 Git top level、重复候选、dirty-state；登记后进入 Development Workspace |
| 3 | `auto-mode` | 自动模式 · 自动领取 | Automation（enabled）、My Work（该条目无 offer，显示归因状态） | 无点击领取；policy / Actor / reservation 证据只读展示 | 自动领取不隐藏工作启动原因 |
| 4 | `board-conflict` | 看板 · 远端指纹冲突 | Board | 首次 `move-work-item` 返回 conflict（乐观 overlay 回滚并显示冲突文案）；第二次成功 | 乐观更新、expected-fingerprint、冲突恢复与文字语义 |
| 5 | `binding-repair` | 恢复 · Resource Binding 修复 | Project index（bindingHealth=repair-required）、Development Workspace（blockedRecovery） | `repair-binding` 成功（带归因确认） | Repair required 状态；只读项目；历史可读 |
| 6 | `mapping-repair` | 恢复 · GitHub mapping 修复 | Board（mappingHealth=repair-required）、Project index | `repair-mapping` 成功后看板恢复读写 | 只读修复模式；指出缺失字段；写入在完整扫描前不可用 |
| 7 | `budget-paused` | 自动模式 · 预算耗尽暂停 | Automation（paused、限额耗尽、未知观察）、Attention Inbox（Intervention Request）、Project index | `budget-exception`（高风险确认）/`resume-automation` 成功 | 耗尽创建 Intervention Request 且绝不意味着 Done；一次性例外不扩张 Grant |
| 8 | `offline` | 离线 · GitHub 不可达 | Board（freshness=offline、旧 checkpoint）、Project index | `move-work-item` 不可用（只读）；本地区段（Changes/Sessions）仍可用 | Stale / offline 文字语义；失败来源；不伪造远端写入 |
| 9 | `reconnect-recovery` | 重连恢复 · 结果不明与对账 | Attention Inbox（dispatch-unknown）、Session view | 对账入口（打开所属对象）；`answer-intervention` 跨“重启”仍可回答 | Reconciliation required；恢复入口；会话可恢复与终端不可恢复的区分 |
| 10 | `empty-states` | 空状态 · 新项目首日 | 空 Board（checkpoint 未完成）、空 My Work、空 Attention、空 Sessions | `create-work-item` 成功 | Empty 三语义：不存在 / 筛选排除 / 首次扫描未完成 |
| 11 | `model-supply` | Model Supply · 账号、路由与生成任务 | Model Supply（4 个 Profile、2 条 Route、2 个 Context Policy、5 个 Generation Job、并发队列） | `cancel-generation-job`、`retry-generation-job` 成功；设备码授权为模拟交互（fixture 注明） | 多 Profile 与保护等级；Usage Snapshot 三态；Route 与 Context Policy；队列、取消与重试 |

## 场景与 K0 验收清单的映射

- bootstrap → 场景 2；Project 登记 → 场景 2、10
- My Work 手动领取 → 场景 1；自动领取 → 场景 3
- 等待回答 → 场景 1、9；等待验收 → 场景 1
- Board 冲突 → 场景 4；binding 修复 → 场景 5；mapping 修复 → 场景 6
- 预算暂停 → 场景 7；Changes 到交付 → 场景 1
- model supply → 场景 11；生成任务 → 场景 11
- 离线或陈旧 → 场景 8；重连恢复 → 场景 9
