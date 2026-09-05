# Agent Note: Saki 上游运行时集成

Status: implemented

[English](2026-09-06-saki-upstream-runtime-integration.md) | 中文

## Problem

Saki 拥有持久控制状态、认证 loopback RPC、Windows 凭据保护和 AgentRun 恢复。上游 Session 持久化、Remote API、存储布局和终端协议处理独立演进。并行保留旧 API 会让这些消费方脱离当前运行时生命周期和快照语料。

## Decision

Saki 直接使用 Session 读取句柄和 `snapshotEvents()`，关闭每个取得的句柄，并在 bundle 与 AgentRun 夹具中挂载 `session-projection`。其 preset 目录排除 shipped 与 user root，因为 Saki 提供可运行的 preset 组合。凭据引用通过类型化 Credentials Remote 保留保护与可用性元数据。Saki 的 loopback 请求策略绑定到其注册路由，包括派发前失败；普通浏览器路由使用浏览器认证策略。

存储在上游逐记录布局之外保留可选 closed-unit lease 和显式仅创建迁移操作。普通 SQLite 服务要求物理 v2；closed 迁移可读取物理 v1 而不修改源。JSON 单 unit 写入保留严格无损 JSON 与根目录身份检查。这些机制独立于已发布 Session 代际，后者遵循 [Session 迁移决策](2026-08-31-released-session-format-migrations.zh.md)。

POSIX Session 写锁只在其执行路径加载 `fs-ext`。该依赖在安装时可选，使 Windows 能使用内核信号量而无需构建 POSIX addon；缺少 addon 的 POSIX 部署会在取得锁时失败。不存在无锁回退。

持久 PowerShell 使用上游无界面终端模拟器处理协议回复，协议与调用方输入经过相同的串行终端写入。非交互宿主与前台子进程输入各有语义：宿主提示会拒绝，子 REPL 仍可从 PTY 读取。[持久 PTY 决策](2026-08-11-pwsh-persistent-pty.zh.md) 拥有就绪与输入顺序规则。

Saki 技能场景位于共享 SDK 会话语料中，使用显式可移植 shell 组合及最终工作区预期。断言保留路由后的 `ask-matt`、`handoff` 调用，以及 `to-tickets` 缺少 shell 时的拒绝。不以录制会话为输入的 Host 和凭据预期输出保留在所属方的 expected-output 层。真实 Git 夹具采用能容纳多次仓库观察的请求预算；文件系统、操作回执与重启断言仍决定是否成功。

Saki 包与 DPAPI 提供方依据 [invariant 发布规则](../simplification/2026-08-28-omit-unneeded-invariant-companions.zh.md) 省略空 invariant companion。README 中的原因明确权威解析器或状态拥有方；移除空注册不会移除持久状态校验。

[Saki Actions 成本策略](../process/2026-08-18-saki-actions-cost-policy.zh.md) 拥有触发频率和 runner 分配。上游备用 runner note 保留适用的实现结论，但不会恢复 master-push 工作流。归档 note 保持不可变。

## Alternatives considered

**保留旧 Session 与 RPC API 适配器。** 否决，因为 Saki 对这些内部 API 没有独立兼容承诺；直接迁移能保持资源所有权与 wire 类型显式。

**选择上游文件时丢弃 Saki 修改。** 否决，因为冷迁移、凭据保护和派发前拒绝行为都是有独立测试的产品要求。

**要求 Windows 安装 POSIX 原生 addon。** 否决，因为 Windows 锁实现不使用它；安装编译器会增加部署前提，却不服务于 Windows 实现。

## Consequences

上游升级必须验证源码启动和构建后的 Saki 组合、Session 恢复、存储迁移、凭据投影和终端输入所有权。共享 SDK 回放检查技能路由和最终工作区状态。原生 Windows 锁与 PowerShell 需要平台专属证据；必需 CI 矩阵拥有跨平台覆盖。
