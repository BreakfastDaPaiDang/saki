---
description: "在 Saki Web 客户端登记本地 Project，在已确认看板上规划 GitHub Work Item，并查看 Issue、执行、Milestone 与 Release 证据。"
kind: "package-reference"
---

# `@breakfastdapaidang/saki-web-ui`

[English](README.md) | 中文

## 概述

将已有目录登记为 Development Project，规划其 GitHub Work Item，并查看 Issue、执行与 Release 证据。「项目」页在重新加载后保留已选看板卡片、详情、Milestone 或工作区。读取失败时，确认值与来源健康状态保持可见；尚未收到确认的移动保留原始 Intent，供用户显式恢复。所有受保护读写均通过 `ctx.sakiHostClient`。

## 目录

- [使用本包](#use-this-package)
- [管理我的工作](#manage-my-work)
- [规划 Project](#plan-a-project)
- [检查本地变更](#review-local-changes)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

在同时携带壳层花名册与 `/saki` Host API 的组合中挂载本插件后，两个侧边栏入口即可打开 Saki 页面。

- `sidebar.primary.action`：`saki-work` 与 `saki-project` 两个条目渲染 New Session 下方的主要入口，并通过 owner 的 `wide` 标志适配收起形态。
- `main.surface`：一个 chain 条目根据壳层通用 surface token（`saki:work` / `saki:project`）选择接管；未选中时渲染 Conversation fallback，且接管期间 fallback 保持挂载，会话内未提交状态不丢失。
- 导航 store 通过 `ctx.layout.requestSurface` 发布 surface token。Saki 侧边栏入口选中各自 surface；只有在没有选中任何 Saki surface 时才渲染 Conversation fallback。
- Workspace 导航 face 报告的用户驱动会话导航（`uiWorkspace.onSessionNavigation`：侧边栏 Session 行、New Session 或 fork 打开）会清除 surface，把中央列交还 Conversation；没有手势支撑的选举——壳层启动时的 Workspace 自动连接与持久化选中恢复——不会挤下已选中的页面，因此恢复出的「项目」页在登记流程中也保持不动。

目录变更会使未完成的检查失效。登记 Intent 完成前路径不可编辑；发生冲突后，必须刷新登记表修订号与检查证据才能再次确认。

<a id="manage-my-work"></a>
## 管理我的工作

「工作」页展示后端给出的跨 Project 分组，每张卡片只显示一项建议操作。选择 Project，填写标题、预期结果与验收标准，即可创建 GitHub Issue 并加入 Inbox。在 Board 中规划 Inbox 工作项；Ready 建议会出现在 My Work。表单使用该 Project 的当前修订号及 Board 映射修订号；一个 Project 不可用不会隐藏其他 Project 及其可读工作。

Give to Agent 要求用户明确确认投影中的 Agent Profile、模型路由、binding 显示标签与继承变更数量。后台刷新期间，已显示的操作保持可用；提交时重新检查显示的 Project 修订号和 Issue 指纹。按显示的修订号回答待处理 Intervention，再打开 Work Item 查看执行与交付证据，或返回其继承 Session。这些手动操作不会自动领取 Ready 工作，也不会自动标记 Done。

需求草稿、回答文本与已提交的原始 Intent 按认证 Principal 持久保存。响应丢失后保留原始 payload；「查询或继续原请求」使用当前请求权限发送同一个 Intent。部分创建保留已知 Work Item 与后端给出的恢复操作。需要对账的结果仍可检查，不能关闭后转为重复创建。关闭成功创建的结果会清除对应已提交草稿。Principal 变化会取消旧读取，并隐藏其事实与输入。

<a id="plan-a-project"></a>
## 规划 Project

选择已登记 Project 打开看板。七种映射状态遵循服务端确认的 GitHub Project 顺序；Canceled 默认隐藏。尚未加入 Project 的开放仓库 Issue 带有明确 Inbox 标记。拖拽卡片或使用移动对话框会提交同一种携带预期指纹的操作，可选指定前驱卡片。待确认位置与已确认状态分开展示。冲突会恢复最新确认事实，并要求用户重新发起手势。

打开卡片可查看完整 Issue 正文与验收条件、关联 Session 与 Run、待答复 Intervention、Git/PR/CI 与验收证据、Milestone 和近期活动引用。打开 Session 使用继承的 Conversation；返回 Project 会恢复其地址。Milestone 视图区分 Saki 阶段与 Work Item 状态，并保留独立 Release 来源的确认事实及阻塞原因。

Status 映射无效时，看板写入不可用。授权用户可在状态映射中选择已有 GitHub 单选字段及七个互不重复的选项；只有完整扫描成功后才恢复写入。工作区和继承的 Session 目的地仍可进入。Project 规划不提供 Issue 创建表单；部分完成的创建事实链接回拥有提交和恢复职责的「工作」流程。

一个规划控制器拥有受保护查询缓存及可取消的失效轮询。通知触发完整读取，不会局部修改看板。Principal 变化会清除业务事实缓存。持久状态仅包含按 Principal 隔离的地址、草稿和未确认原始 Intent，不包含 request token 或 GitHub 凭据。传输失败后，用户刷新或连接重置通知会恢复轮询。

<a id="review-local-changes"></a>
## 检查本地变更

从 Project、Work Item 或 Run 打开「变更」。页面覆盖整个绑定工作区；Run 链接保留返回目的地，不会把每个文件归因于该 Run。每个文件标明其证据是否与登记时已有变更一致。选择暂存区或未暂存 Diff，每次检查一页有界内容，并逐文件暂存或取消暂存。不支持的内容与过期 observation 显示 Host 给出的原因；文件在其他地方变化后应刷新。

输入提交说明，检查完整的已暂存文件列表后，明确确认本地提交。确认会固定显示的索引与说明，包含继承的已暂存变更，并说明不会运行 Git hooks。Host 在写入前重新核对所有显示的修订围栏。成功 receipt 显示生成的 commit id；它不表示已 Push、创建 PR 或通过验收。

提交草稿与已提交的原始请求按 Principal 和 Project 持久保存。待处理、尚未确认及需要对账的请求会阻止替代操作。「核对 / 重试原操作」使用当前请求权限重放原始 id 与 payload，浏览器重新加载后也保持不变。只有持久终态 receipt 才能被确认并清除；不含 receipt 的拒绝或冲突回复无法证明先前尝试没有副作用。操作返回结果、用户显式刷新或连接重置后会重新读取。Git 检查不会因每次规划通知而轮询。

<a id="model-experience"></a>
## 模型体验

通过已确认的 Give-to-Agent 与 Intervention-answer Intent 间接影响模型；相应持久 Session 输入、模型路由与执行由 Agent runtime 拥有。

#### KV Cache 影响

Session 输入与 KV-cache 影响遵循所属 Agent runtime 的行为。读取和刷新「工作」或「项目」视图不会添加模型输入。

## 已知限制与延期工作
<a id="known-limitations-and-deferred-work"></a>

- **仅支持手动 Work** ——自动领取、预算暂停与自动完成仍属独立工作流。默认 bundle 不含生产模型适配器，Agent 执行需要已配置且可用的模型路由。
- **仅列出已配置 Milestone** —— Milestone 目的地列出现有 Saki delivery 记录；创建 Milestone 或 Release 元数据由其所属工作流负责。
- **目录选择是带校验的路径输入** —— 本切片不组合浏览对话框；后端在登记前重新检查任何提交的路径。
- **修复与 rebind 在此只读** —— binding 的 `missing` / `repair-required` 状态保持历史可读但不提供修复操作；它们属于 Resource Binding 切片（#26）。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

不发布 invariant companion：本插件只通过壳层可累加 slot 渲染 Saki Projection，并通过 `saki-host-api` 提交 Intent；不发出 cordis 事件，也不拥有跨插件可变状态，其 slot 注册通过 HMR 安全性 spec 证明可处置。

</details>
