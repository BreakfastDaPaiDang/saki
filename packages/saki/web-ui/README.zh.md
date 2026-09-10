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
- [规划 Project](#plan-a-project)
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

<a id="plan-a-project"></a>
## 规划 Project

选择已登记 Project 打开看板。七种映射状态遵循服务端确认的 GitHub Project 顺序；Canceled 默认隐藏。尚未加入 Project 的开放仓库 Issue 带有明确 Inbox 标记。拖拽卡片或使用移动对话框会提交同一种携带预期指纹的操作，可选指定前驱卡片。待确认位置与已确认状态分开展示。冲突会恢复最新确认事实，并要求用户重新发起手势。

打开卡片可查看完整 Issue 正文与验收条件、关联 Session 与 Run、待答复 Intervention、Git/PR/CI 与验收证据、Milestone 和近期活动引用。打开 Session 使用继承的 Conversation；返回 Project 会恢复其地址。Milestone 视图区分 Saki 阶段与 Work Item 状态，并保留独立 Release 来源的确认事实及阻塞原因。

Status 映射无效时，看板写入不可用。授权用户可在状态映射中选择已有 GitHub 单选字段及七个互不重复的选项；只有完整扫描成功后才恢复写入。工作区和继承的 Session 目的地仍可进入。Project 规划不提供 Issue 创建表单；部分完成的创建事实链接回拥有提交和恢复职责的「工作」流程。

一个规划控制器拥有受保护查询缓存及可取消的失效轮询。通知触发完整读取，不会局部修改看板。Principal 变化会清除业务事实缓存。持久状态仅包含按 Principal 隔离的地址、草稿和未确认原始 Intent，不包含 request token 或 GitHub 凭据。传输失败后，用户刷新或连接重置通知会恢复轮询。

<a id="model-experience"></a>
## 模型体验

无——本插件不注册任何模型可见输入，也不发起提供方请求。

#### KV Cache 影响

无；本插件只读取类型化 Projection。

## 已知限制与延期工作
<a id="known-limitations-and-deferred-work"></a>

- **尚无 My Work Projection** ——「工作」页显示明确的不可用状态并指向「项目」；真正的页面随 K2 切片到来。
- **仅列出已配置 Milestone** —— Milestone 目的地列出现有 Saki delivery 记录；创建 Milestone 或 Release 元数据由其所属工作流负责。
- **目录选择是带校验的路径输入** —— 本切片不组合浏览对话框；后端在登记前重新检查任何提交的路径。
- **修复与 rebind 在此只读** —— binding 的 `missing` / `repair-required` 状态保持历史可读但不提供修复操作；它们属于 Resource Binding 切片（#26）。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

不发布 invariant companion：本插件只通过壳层可累加 slot 渲染 Saki Projection，并通过 `saki-host-api` 提交 Intent；不发出 cordis 事件，也不拥有跨插件可变状态，其 slot 注册通过 HMR 安全性 spec 证明可处置。

</details>
