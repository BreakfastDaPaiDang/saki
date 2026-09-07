# Agent Note: Saki 上游运行时集成

Status: implemented

[English](2026-09-06-saki-upstream-runtime-integration.md) | 中文

## Problem

Saki 拥有持久控制状态、认证 loopback RPC、Windows 凭据保护和 AgentRun 恢复。上游 Session 持久化、Remote API、存储布局和终端协议处理独立演进。并行保留旧 API 会让这些消费方脱离当前运行时生命周期和快照语料。

## Decision

Saki 从每个 `SessionHandleReadResult` 读取 `events` 切片而不修改事件值，对 live Session 使用 `snapshotEvents()`，关闭每个取得的句柄，并在 bundle 与 AgentRun 夹具中挂载 `session-projection`。其 preset 目录排除 shipped 与 user root，因为 Saki 提供可运行的 preset 组合。凭据引用通过类型化 Credentials Remote 保留保护与可用性元数据。Saki 的 loopback 请求策略绑定到其注册路由，包括派发前失败；普通浏览器路由使用浏览器认证策略。

存储在上游逐记录布局之外保留可选 closed-unit lease 和显式仅创建迁移操作。普通 SQLite 服务要求物理 v2；closed 迁移可读取物理 v1 而不修改源。JSON 单 unit 写入保留严格无损 JSON 与根目录身份检查。这些机制独立于已发布 Session 代际，后者遵循 [Session 迁移决策](2026-08-31-released-session-format-migrations.zh.md)。

POSIX Session 写锁只在其执行路径加载 `fs-ext`。该依赖在安装时可选，使 Windows 能使用内核信号量而无需构建 POSIX addon；缺少 addon 的 POSIX 部署会在取得锁时失败。不存在无锁回退。

持久 PowerShell 使用上游无界面终端模拟器处理协议回复，协议与调用方输入经过相同的串行终端写入。非交互宿主与前台子进程输入各有语义：宿主提示会拒绝，子 REPL 仍可从 PTY 读取。[持久 PTY 决策](../../archived/architecture/2026-08-11-pwsh-persistent-pty.md) 拥有就绪与输入顺序规则。

Saki 技能场景位于共享 SDK 会话语料中，使用显式可移植 shell 组合及最终工作区预期。断言保留路由后的 `ask-matt`、`handoff` 调用，以及 `to-tickets` 缺少 shell 时的拒绝。不以录制会话为输入的 Host 和凭据预期输出保留在所属方的 expected-output 层。Saki 进程预期通过共享启动器遵循 `DSH_EXAMPLE_MODE`；CI 通过构建后的包导出验证完整 Git 与恢复输出，源码启动用例则检查模块解析与身份认证。

在 Linux 上，真实 Git 行为单元夹具选择进程组实现，因为每条 Git 命令都会重复启动原生源码引导进程。GitRunner 测试与完整 Saki 场景保留平台选择的原生隔离。两层中的仓库状态、操作回执、取消与重启断言都保持精确。

完整 Delivery 转录显式请求证据刷新，并将 `targetedPendingPollIntervalMs` 设为用例期限。后台刷新会推进 Delivery 版本，因此在 Push 回执与下一次变更之间自动刷新，会使转录的预期版本失效。单元测试独立验证这种过期变更的拒绝行为。

原生子进程和 shell 夹具先观察目标输出，再测试取消或释放。假终端生命周期与启动失败释放顺序用例选择进程组实现；专门的 Linux scope 用例验证原生启动与结果处理。超时输出用例为原生引导进程在受测期限内启动目标留出时间。前台输出观察器会恢复实例上的 spawn spy，夹具清理先等待所属进程退出，再移除目录。PowerShell 生命周期用例在释放前观察目标 PID，随后验证其退出，并在 `finally` 中释放上下文；用例期限覆盖原生启动和托管范围退出两个阶段。

bundle 的 `./launcher` 入口拥有启动环境依赖。就绪插件在干净检出中仍可独立从 TypeScript 加载，完整进程夹具则通过构建入口解析启动器辅助函数。

bundle 显式设置 `personaPrefix` 与 `personaSuffix`；development preset 通过 Persona 插件的 `prefix` 字段提供稳定提示。Connection 在 WebServer 可用时安装 HTTP 路由，并将已验证的恢复配置发布到浏览器 bootstrap。Saki 路由身份认证也适用于派发前失败。

即使挂载的 Host API 身份认证由 Saki 负责，Connection 仍需要凭据存储来保存浏览器会话签名记录。POSIX 组合选择现有的本地提供方，其保护等级为 `plaintext`；Product GitHub App 保持禁用。Windows 使用 DPAPI 保存 Connection 记录和 Product App 引用。

PowerShell 快照保留发行版 headless profile 的工具、权限事件和运行时上下文消息。持久 PowerShell 组合在所有平台禁用普通 `pwsh` 工具，确保只有一个注册。

标准 Web 快照页面显式选择 `Asia/Shanghai`，与保留的 `clientTimeZone` 事件载荷一致。语言环境与时区是浏览器夹具的输入；重放保留日志中的时区，不将其归一化去除。

预览 Worker 在加载 VFS 模块图前安装 Proxy 身份跟踪。它的 `node:util/types` shim 无需反射即可识别已构造和已撤销的代理，保留凭据归一化在检查属性前拒绝代理的行为。该判断覆盖 Worker 内构造的代理；结构化克隆传输会拒绝外部代理。

Loader 配置扫描返回以正斜杠规范化的仓库路径，再按所属 manifest 分类插件引用。CLI 凭据夹具将设置、提问与 DPAPI 插件声明为开发依赖，使全新检出在 Windows 与 POSIX 上校验同一解析关系图。

Git 测试夹具先解除 junction，再等待递归删除，使暂存的 Windows 进程句柄能在有限重试期间释放。夹具迁移只重试 Windows 的访问与共享错误，其他失败仍向上传播。每个 teardown 调用方都等待删除完成。

Saki 包与 DPAPI 提供方依据 [invariant 发布规则](../simplification/2026-08-28-omit-unneeded-invariant-companions.zh.md) 省略空 invariant companion。README 中的原因明确权威解析器或状态拥有方；移除空注册不会移除持久状态校验。

[Saki Actions 成本策略](../process/2026-08-18-saki-actions-cost-policy.zh.md) 拥有触发频率和 runner 分配。上游备用 runner note 保留适用的实现结论，但不会恢复 master-push 工作流。归档 note 保持不可变。

## Alternatives considered

**保留旧 Session 与 RPC API 适配器。** 否决，因为 Saki 对这些内部 API 没有独立兼容承诺；直接迁移能保持资源所有权与 wire 类型显式。

**选择上游文件时丢弃 Saki 修改。** 否决，因为冷迁移、凭据保护和派发前拒绝行为都是有独立测试的产品要求。

**要求 Windows 安装 POSIX 原生 addon。** 否决，因为 Windows 锁实现不使用它；安装编译器会增加部署前提，却不服务于 Windows 实现。

## Consequences

上游升级必须验证源码启动和构建后的 Saki 组合、Session 恢复、存储迁移、凭据投影和终端输入所有权。共享 SDK 回放检查技能路由和最终工作区状态。原生 Windows 锁与 PowerShell 需要平台专属证据；必需 CI 矩阵拥有跨平台覆盖。
