# `@breakfastdapaidang/saki-web-ui`

[English](README.md) | 中文

Saki 的 Web 客户端插件。它把「工作」「项目」两个顶层入口注册进 DSH 壳层可累加的 `sidebar.primary.action` list slot，并向 `main.surface` chain slot 注册一个接管条目——其 fallback 仍是现有的 Conversation。插件拥有一个跨 reload 持久化的小型导航 store（活动 surface、已选与最近 Project），并通过 `ctx.sakiHostClient` 完成访问、Project 索引、目录检查、登记与 Development Workspace 读取。它不直接调用 GitHub、Git、文件系统或凭据，也不根据原始状态推导按钮。

## 组合方式

- `sidebar.primary.action`：`saki-work` 与 `saki-project` 两个条目渲染 New Session 下方的主要入口，并通过 owner 的 `wide` 标志适配收起形态。
- `main.surface`：一个 chain 条目根据壳层通用 surface token（`saki:work` / `saki:project`）选择接管；未选中时渲染 Conversation fallback，且接管期间 fallback 保持挂载，会话内未提交状态不丢失。
- 导航 store 通过 `ctx.layout.requestSurface` 发布 surface token；当一个 Session 被选中时清除 Saki surface，主栏交还给 Conversation。

## Model Experience

无——本插件不注册任何模型可见输入，也不发起提供方请求。

#### KV Cache 影响

无；本插件只读取类型化 Projection。

## Known Limitations and Deferred Work

- **尚无 My Work Projection** ——「工作」页显示明确的不可用状态并指向「项目」；真正的页面随 K2 切片到来。
- **客户端没有推送通道** —— 本切片在导航、刷新与 Intent 后重新查询；`onChanged` 仅在 Host 侧。
- **目录选择是带校验的路径输入** —— 本切片不组合浏览对话框；后端在登记前重新检查任何提交的路径。
- **修复与 rebind 在此只读** —— binding 的 `missing` / `repair-required` 状态保持历史可读但不提供修复操作；它们属于 Resource Binding 切片（#26）。
