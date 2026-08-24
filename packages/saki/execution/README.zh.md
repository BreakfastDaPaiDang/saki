# `@breakfastdapaidang/saki-execution`

[English](README.md) | 中文

Saki 私有 Host Execution Service Definition 注册 `ctx.sakiHostExecution`。它定义与 Host 实现无关的检查值，以及唯一的只读操作 `inspectProjectSelection(request, signal)`；[Saki 控制面](../control-plane/README.zh.md)拥有授权、Project 策略和持久产品记录。[Saki 后端架构](../../../docs/saki/architecture/0.1.0-backend.zh.md)定义更完整的控制面与执行面划分。

## 项目选择检查

请求包含所选 Saki Host id 与调用方提供的目录定位值。该定位值是不可信输入：Service Provider 每次调用都会独立解析并检查它，该拼写或先前的 Projection 都不能授权后续操作。必填的 `AbortSignal` 把检查工作绑定到调用方生命周期。

成功结果把可供浏览器使用的 `ProjectSelectionProjection` 与 `TrustedProjectSelectionObservation` 分开。安全 Projection 包含经过清理且不呈现为路径的展示标签、有界 Git 事实、可选的现有 DSH Workspace id、带版本的指纹和完整或不可用的 `InheritedChangeBaseline`；它不包含规范 Host 路径、Git 管理路径、发生变化的明文文件名、文件内容或带凭据的远程 URL。当经过清理的 HTTPS 或 SSH remote 指向公共 `github.com/owner/repository` 坐标时，Projection 还会携带小写、排序、去重后的候选列表。候选项用于支持用户确认，不是 Resource Binding 或授权结果。可信观察保留同一次检查的规范路径身份、每 worktree 与 common Git 管理目录的不透明同 Host 身份，以及闭合 Git 比较设置；其 schema 仅接受可移植的 POSIX、Windows 驱动器或 Windows UNC 绝对路径结构。只有同一 Host 上的新鲜 Service Provider 检查拥有规范 `realpath` 与管理目录身份，持久保留的路径本身绝不授权 effect。严格 schema 会根据保留证据重算 baseline 条目、baseline 聚合与完整检查摘要，其中 Workspace 观察以明确的存在或缺失分支表示。检查不会创建 Workspace 或 Resource Binding。

baseline schema 区分完整捕获与不可用捕获；前者包括干净的零条目结果，后者只携带有界原因与已观察限制。Consumer 不得把不可用证据当作部分完整 baseline。可合并扩展的 `SakiHostExecutionOperationMap` 不声明变更占位操作。

Service Definition 没有配置。每个 Service Provider 拥有其执行环境机制与必需的资源限制。

## 模型体验

### Host 检查值

#### 模型看到什么

什么也看不到。`ctx.sakiHostExecution` 向 Host 侧 Saki Consumer 提供分离值，不注册工具、prompt section 或 session event。

#### Token 影响

每次请求直接增加零个 token。

#### KV Cache 影响

与模型请求相互独立：该服务不组装或更改请求前缀。

## 已知限制与暂缓事项

- **只读操作集合**：该服务仅定义项目选择检查。基于 Binding 的变更、worktree 管理、修复和退役不属于该操作集合，需要各自的 Consumer 操作，而不能借用本请求传递权限。
