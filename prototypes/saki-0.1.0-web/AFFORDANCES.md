# Affordance → Projection / Intent 清单（K0）

每条用户可执行 affordance 读取的 Projection 与它提交的 typed Intent。所有 Intent 提交都携带 `expectedRevision`（所读 Projection 的当前 revision）与 `subject`（该 Projection 的 key）；过时 revision 由控制面以 conflict 拒绝；每个 Intent 从 pending 到终态使用同一个稳定 receipt id；pending 期间提交控件禁用。Action Offer 来自 Projection，不是客户端推导；导航 affordance 不产生 Intent。高风险操作先弹确认并标明受影响 Project 与 resource。

## 壳层 / 导航

| Affordance | 读取 | 效果 |
|---|---|---|
| 侧边栏「工作」（含 Attention 数量徽标） | `attention`（Attention Inbox） | 导航到 My Work address；徽标只计未解决、需要人处理或阻塞自动化的条目 |
| 侧边栏「项目」 | `projects`（Project index，恢复最近选择） | 导航到所选 Project 当前区段；无已选 Project 时打开 Project selector |
| Project 切换器 | `projects` | 切换 Project 且保留当前区段；不丢弃 draft |
| 内部区段导航（看板/里程碑/变更/会话与运行/追溯/项目设置） | — | 切换 typed address；Work Item、Work Session、Agent Run、Milestone、file、Board filter 等选择保留在 address 参数中，reload 后恢复 |
| 设置入口与关闭 | — | 打开 Settings 记录来源 address；关闭返回原 owner 页面 |

## bootstrap（场景 `fresh-install`）

| Affordance | 读取 | Intent |
|---|---|---|
| 输入本地 secret 并继续 | — | —（本地启动流程；secret 在离开该步骤时即从 state 清除，返回不恢复） |
| 创建本地 Principal | `projects` | `complete-bootstrap` |
| 选择目录候选并复核证据 | 目录候选（Git top level、remote、重复候选、dirty-state，fixture 静态） | — |
| 确认登记 | `projects` | `register-project` |

## 「工作」页

| Affordance | 读取 | Intent |
|---|---|---|
| 需要关注条目的「去处理」 | `attention`（severity / kind / returnAddress） | 导航到 returnAddress（不产生 Intent） |
| 卡片上的唯一 Action Offer（交给 Agent / 回答 / 验收） | `my-work`（每项 `offer` + `offerUnavailableReason`） | offer 携带的 Intent（`claim-work-item` / `answer-intervention` / `accept-deliverable`），subject `my-work` |
| 卡片标题 / 处理中条目的打开 | — | 导航到所属 Project 的 Work Item address（导航不是 mutation） |
| 提交需求（唯一创建入口） | `projects`、`board:<project>`、`project-config:<project>` | `create-work-item`（title、intended outcome、acceptance criteria、projectId、expectedProjectRevision、expectedMappingRevision）；partial / ack-lost 时对话框不关，提供对账检查与安全重试 |

## 「项目」· 看板

| Affordance | 读取 | Intent |
|---|---|---|
| 拖动卡片 / Alt+←→ / 「移动…」菜单 | `board:<project>`（列、卡片、`remoteFingerprint`、checkpoint、mapping health） | `move-work-item`（expected-fingerprint；乐观 overlay 从源列移除并插入目标列，conflict 回滚），subject `board:<project>` |
| 卡片「详情」 | — | 打开 drawer（address 增加 `workItemId`） |
| 里程碑筛选 | `board:<project>` | 导航（filter 进 address；筛选为空显示 filtered Empty 语义） |
| 修复映射 | `board:<project>` 的 `mappingRepairDetail` | `repair-mapping`（带归因；mapping 修复的 owner 是看板侧 K3 流程） |

## 「项目」· Work Item drawer

| Affordance | 读取 | Intent |
|---|---|---|
| 提交 Intervention 回答（clarification：文本；approval：批准/拒绝；repair-link：修复入口） | `work-item:<id>`（interventions、offer） | `answer-intervention`（结构化 response），subject `work-item:<id>` |
| 详情 offer（如验收） | `work-item:<id>` 的 `offer` | offer 携带的 Intent，subject `work-item:<id>` |
| 打开会话与运行 / 查看追溯 | — | 导航到对应 address |

## 「项目」· 变更

| Affordance | 读取 | Intent |
|---|---|---|
| 暂存 / 全部暂存 / 取消暂存（逐文件） | `changes:<project>`（staged / unstaged / untracked、eligibility） | `stage-files` / `unstage-files`，subject `changes:<project>` |
| 提交 | `changes:<project>` | `commit`（expectedIndexTree；HEAD 不匹配即 conflict） |
| 推送（高风险确认） | `changes:<project>` | `push`（expectedCommit + targetRef） |
| 创建 PR（标题预填可编辑） | `changes:<project>` | `create-pr` |

## 「项目」· 会话与运行

| Affordance | 读取 | Intent |
|---|---|---|
| 选择会话 | `sessions:<project>`（列表 + 选中详情、时间线、关联摘要） | 导航（address 增加 `workSessionId` / `agentRunId`） |
| 打开会话 | — | 记录 return address 后导航到继承的 Conversation |
| 复制运行链接 | — | —（本地操作，不产生 Intent） |

## 「项目」· 项目设置（K7 owner 流）

| Affordance | 读取 | Intent |
|---|---|---|
| 修改默认 Agent Profile | `project-config:<project>` | `set-default-agent-profile`（field-scoped，expected config revision） |
| 触发方式（手动/自动）、启用的动作、类型化预算上限 | `automation:<project>` | `update-automation-policy`（field-scoped：`triggerMode` / `action:<id>` / `limit:<dimension>`） |
| 自动交付 / 自动 Done 的 Outcome Evidence 规则 | `automation:<project>` 的 `evidenceRules` | 只读展示 |
| 同步轮询配置保存 | `project-config:<project>` | `update-sync-config`；保存成功后展示激活链：saved → revalidating → scanning → checkpointed → activated（保存成功 ≠ 已启用） |
| 恢复自动化 | `automation:<project>` | `resume-automation`（确认弹窗标明 Project） |
| 授权一次性预算例外（高风险） | `automation:<project>`（limits、pauseReason、unknownObservations） | `budget-exception`（approval；24 小时过期、不扩张 Grant） |
| Resource Binding / GitHub 映射 | `workspace:<project>`、`projects`、`board:<project>` | 只读；修复分别链接到 Projects 页（K1 登记/rebind）与看板（K3 mapping repair）owner 流程 |

## Projects 页

| Affordance | 读取 | Intent |
|---|---|---|
| 打开项目 | `projects` | 导航到 Development Workspace |
| 修复 Binding（repair-required 时；高风险确认） | `projects` | `repair-binding`（重新验证既有目录；不删除文件或 Git 资源），subject `projects` |

## Settings · Model Supply 分节

| Affordance | 读取 | Intent |
|---|---|---|
| 取消排队中的 Generation Job | `model-supply`（jobs、并发） | `cancel-generation-job`，subject `model-supply` |
| 重试失败的 Generation Job | `model-supply` | `retry-generation-job`，subject `model-supply` |
| 添加账号 / 重新授权（设备码） | `model-supply`（profiles） | —（fixture 注明：真实实现走 `beginAuthorization` / `continueAuthorization`，prototype 只演示交互形态） |

## 继承页面（DSH 拥有，prototype 占位）

| Affordance | 读取 | 效果 |
|---|---|---|
| Conversation 草稿 / view tab / details 开关 | 本地 UI state（非 Projection） | 离开并返回后恢复（证明 Project 切换不丢 draft） |
| New Session 开始 | — | 导航到 Conversation |
