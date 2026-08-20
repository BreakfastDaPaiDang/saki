# 场景索引（K0）

每个场景是一组命名、可切换的文档化 fixture。fixture 标明它模拟的 Projection、接受的 Intent 与演示的结果；字段只表达约定，不是最终 wire type。底部工具条可切换场景，也可用 `?scenario=<id>` 直达。

| # | id | 场景 | 模拟的 Projection | 演示的 Intent 与结果 | 覆盖的验收点 |
|---|---|---|---|---|---|
| 1 | `operator-day` | 日常 · 手动模式 | My Work、Project index、Board、Work Item detail、Changes、Session view、Attention Inbox、Automation、Project config、Model Supply | `claim-work-item` 成功；`answer-intervention`（clarification 文本）成功；`accept-deliverable` 成功；`stage-files` / `unstage-files` / `commit` / `push` / `create-pr` 成功；`create-work-item` confirmed | My Work 四分组与单一 Action Offer；等待回答与等待验收同属“等你处理”；Done/Canceled 无验收操作；“打开”是导航不是 Intent；Changes 到交付 |
| 2 | `fresh-install` | 首次启动 · bootstrap 与项目登记 | 空 Project index、空 My Work、空 Attention | `complete-bootstrap`、`register-project` 成功 | 一次性 bootstrap（secret 用后即从 state 清除）；复核 Git top level、重复候选、dirty-state；登记后进入 Development Workspace |
| 3 | `auto-mode` | 自动模式 · 自动领取 | Automation（enabled）、My Work（该条目无 offer，显示归因状态） | 无点击领取；policy / Actor / reservation 证据只读展示 | 自动领取不隐藏工作启动原因 |
| 4 | `board-conflict` | 看板 · 远端指纹冲突 | Board | 首次 `move-work-item` 返回 conflict（乐观 overlay：源列移除 + 目标列插入，随后回滚）；第二次成功 | 乐观 overlay、expected-fingerprint、冲突恢复与文字语义 |
| 5 | `binding-repair` | 恢复 · Resource Binding 修复 | Project index（bindingHealth=repair-required）、Development Workspace（blockedRecovery） | `repair-binding` 成功（Projects 页入口，带归因确认）；Project Settings 中 Binding 只读并链接到该 owner 流程 | Repair required 状态；只读项目；历史可读 |
| 6 | `mapping-repair` | 恢复 · GitHub mapping 修复 | Board（mappingHealth=repair-required）、Project index | `repair-mapping`（看板入口）成功后看板恢复读写 | 只读修复模式；指出缺失字段；写入在完整扫描前不可用 |
| 7 | `budget-paused` | 自动模式 · 预算耗尽暂停 | Automation（paused、限额耗尽、未知观察）、Attention Inbox（approval 型 Intervention Request）、Project index | `budget-exception`（approval：批准/拒绝，高风险确认）/ `resume-automation` 成功 | 耗尽创建 Intervention Request 且绝不意味着 Done；一次性例外不扩张 Grant |
| 8 | `offline` | 离线 · GitHub 不可达 | Board（freshness=offline、旧 checkpoint、看板写入 unavailable）、Project index | 远端写入操作不可用（只读）；本地区段仍可用 | Stale / offline / unavailable 文字语义；失败来源；不伪造远端写入 |
| 9 | `reconnect-recovery` | 重连恢复 · 结果不明与对账 | Attention Inbox（dispatch-unknown）、Session view | 对账入口（打开所属对象）；`answer-intervention` 跨“重启”仍可回答 | Reconciliation required；恢复入口；会话可恢复与终端不可恢复的区分 |
| 10 | `empty-states` | 空状态 · 新项目首日 | 空 Board（checkpoint 未完成）、空 My Work、空 Attention、空 Sessions | — | Empty 三语义：不存在（My Work）/ 未扫描（Board）；筛选为空见 `operator-day` 看板筛选 |
| 11 | `create-item-outcomes` | 新建工作项 · 部分失败与结果不明 | Board、Project config | `create-work-item`：第一次 partial（Issue 已创建、未加入 Project、修复动作）；第二次 acknowledgement lost → reconciliation → 对账检查后安全重试；同名重交幂等确认 | 未收敛不关窗；不盲目重复创建；expected Project revision + expected GitHub mapping revision 都在表单可见 |
| 12 | `model-supply` | Model Supply · 账号、路由与生成任务 | Model Supply（4 个 Profile、2 条 Route、2 个 Context Policy、5 个 Generation Job、并发队列） | `cancel-generation-job`、`retry-generation-job` 成功；设备码授权为模拟交互（fixture 注明） | 多 Profile 与保护等级；Usage Snapshot 三态；Route 与 Context Policy；队列、取消与重试 |

## 场景与 K0 验收清单的映射

- bootstrap → 场景 2；Project 登记 → 场景 2、10
- My Work 手动领取 → 场景 1；自动领取 → 场景 3
- 等待回答 → 场景 1、9；等待验收 → 场景 1
- Board 冲突 → 场景 4；binding 修复 → 场景 5；mapping 修复 → 场景 6
- 预算暂停 → 场景 7；Changes 到交付 → 场景 1
- CreateWorkItem 完整字段与非快乐路径 → 场景 11
- model supply → 场景 12；生成任务 → 场景 12
- 离线或陈旧 → 场景 8；重连恢复 → 场景 9
- 状态语义覆盖：confirmed（全部）、refreshing（任何重查）、optimistic（看板移动 pending）、stale（场景 8/项目索引）、offline（场景 8）、unavailable（场景 8 看板写入）、conflict（场景 4、stale revision）、repair-required（场景 5、6）、reconciliation-required（场景 9、11）、intervention-required（场景 1、7）、empty（场景 10 + 筛选为空）
