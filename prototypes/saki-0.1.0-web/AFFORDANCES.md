# Affordance → Projection / Intent 清单（K0）

每条用户可执行 affordance 读取的 Projection 与它提交的 typed Intent。所有 Intent 提交都携带 expected Projection revision；Action Offer 来自 Projection，不是客户端推导；高风险操作先弹确认并标明受影响 Project 与 resource。

## 壳层 / 导航

| Affordance | 读取 | 效果 |
|---|---|---|
| 侧边栏「工作」（含 Attention 数量徽标） | `attention`（Attention Inbox） | 导航到 My Work address |
| 侧边栏「项目」 | `projects`（Project index，恢复最近选择） | 导航到所选 Project 的 Work address；无已选 Project 时打开 Project selector |
| Project 切换器 | `projects` | 切换 Work/Changes/Sessions/Terminal/Project Settings 上下文；不丢弃 draft |
| 内部区段导航（看板/里程碑/变更/会话与运行/追溯/项目设置） | — | 切换 typed address；选择状态保留在 address 参数中 |

## bootstrap（场景 `fresh-install`）

| Affordance | 读取 | Intent |
|---|---|---|
| 输入本地 secret 并继续 | — | —（本地启动流程，prototype 注明单次使用） |
| 创建本地 Principal | — | `complete-bootstrap` |
| 选择目录候选并复核证据 | 目录候选（Git top level、remote、重复候选、dirty-state，fixture 静态） | — |
| 确认登记 | — | `register-project` |

## 「工作」页

| Affordance | 读取 | Intent |
|---|---|---|
| 卡片上的唯一 Action Offer（交给 Agent / 打开 / 回答 / 验收） | `my-work`（每项 `offer` + `offerUnavailableReason`） | offer 携带的 Intent（`claim-work-item` / `answer-intervention` / `accept-deliverable`） |
| 提交需求 | — | `create-work-item`（注明部分失败显示已完成事实与恢复操作） |
| 卡片标题 | — | 导航到所属 Project 的 Work Item address |
| 交给 Agent 前复核 | fixture 静态（Profile、Model Route、所需权限、Binding 健康、继承变更、适用限制） | —（复核后提交 `claim-work-item`） |

## 「项目」· 看板

| Affordance | 读取 | Intent |
|---|---|---|
| 拖动卡片 / Alt+←→ / 「移动…」菜单 | `board:<project>`（列、卡片、`remoteFingerprint`、checkpoint、mapping health） | `move-work-item`（expected-fingerprint；乐观 overlay，冲突回滚） |
| 卡片「详情」 | — | 打开 drawer（address 增加 `workItemId`） |
| 修复映射 | `board:<project>` 的 `mappingRepairDetail` | `repair-mapping`（带归因） |
| 新建工作项 | — | `create-work-item` |

## 「项目」· Work Item drawer

| Affordance | 读取 | Intent |
|---|---|---|
| 提交 Intervention 回答 | `work-item:<id>`（interventions、offer） | `answer-intervention`（expected revision；第一个有效回答胜出） |
| 详情 offer（如验收） | `work-item:<id>` 的 `offer` | offer 携带的 Intent |
| 打开会话与运行 / 查看追溯 | — | 导航到对应 address |

## 「项目」· 变更

| Affordance | 读取 | Intent |
|---|---|---|
| 暂存 / 全部暂存 / 取消暂存（逐文件） | `changes:<project>`（staged / unstaged / untracked、eligibility） | `stage-files` / `unstage-files` |
| 提交 | `changes:<project>` | `commit`（expectedIndexTree） |
| 推送（高风险确认） | `changes:<project>` | `push`（expectedCommit + targetRef） |
| 创建 PR（标题预填可编辑） | `changes:<project>` | `create-pr` |

## 「项目」· 会话与运行

| Affordance | 读取 | Intent |
|---|---|---|
| 选择会话 | `sessions:<project>`（列表 + 选中详情、时间线、关联摘要） | 导航（address 增加 `workSessionId`） |
| 打开会话 | — | 记录 return address 后导航到继承的 Conversation |
| 复制运行链接 | — | —（本地操作，不产生 Intent） |

## 「项目」· 项目设置

| Affordance | 读取 | Intent |
|---|---|---|
| 修复 Binding（高风险确认） | `workspace:<project>`（binding health、blockedRecovery） | `repair-binding` |
| 恢复自动化 | `automation:<project>` | `resume-automation` |
| 授权一次性预算例外（高风险确认，标明 Project 与 24 小时过期） | `automation:<project>`（limits、pauseReason、unknownObservations） | `budget-exception` |

## Settings · Model Supply 分节

| Affordance | 读取 | Intent |
|---|---|---|
| 取消排队中的 Generation Job | `model-supply`（jobs、并发） | `cancel-generation-job` |
| 重试失败的 Generation Job | `model-supply` | `retry-generation-job` |
| 添加账号 / 重新授权（设备码） | `model-supply`（profiles） | —（fixture 注明：真实实现走 `beginAuthorization` / `continueAuthorization`，prototype 只演示交互形态） |

## 继承页面（DSH 拥有，prototype 占位）

| Affordance | 读取 | 效果 |
|---|---|---|
| Conversation 草稿 / view tab / details 开关 | 本地 UI state（非 Projection） | 离开并返回后恢复（证明 Project 切换不丢 draft） |
| New Session 开始 | — | 导航到 Conversation |
