# Agent Note: Saki 受保护模型账户

Status: implemented

[English](2026-09-20-saki-protected-model-accounts.md) | 中文

## 问题

订阅集成需要经受提供者库升级，同时不让 SDK 拥有产品选择、持久授权身份或凭据保护。账户切换不能混用凭据或复用其他账户的请求状态。

## 决策

[模型账户服务](../../../../packages/saki/model-account/README.zh.md) 定义完整的授权、检查和适配器能力。控制平面拥有档案和可重放意图；[Codex 提供者](../../../../packages/saki/model-account-codex/README.zh.md) 组合维护中的 pi-ai OAuth/SSE 与已发布订阅额度助手。每个账户路由修订记录精确实现身份；替换实现不能静默激活旧修订。

每个授权意图分配独立的受保护凭据键。完成流程检查该键、验证账户归属、提交档案，再确认意图。重启通过检查修复丢失的确认，不重放登录。浏览器取消与 Host 授权生命周期分离。取消若与已提交凭据并发，授权可收敛为已完成。

受保护记录读取与刷新事务扩展了 [DPAPI 决策](2026-08-18-saki-local-user-trust-dpapi-credentials.zh.md)。它们在暴露凭据材料前拒绝不支持的保护等级。产品记录和浏览器投影不保存令牌。额度失败保持未知，另行保留上次确认观测。模型目录是能力元数据，不是使用资格证据。

Codex SSE 请求在异步准备前捕获所选路由、Session id 和已记录轮次号。最终公开 fetch 钩子强制使用 Harness User-Agent、Saki originator 和 Session 请求标识。响应轮次状态仅属于该账户、会话和活动轮次，在轮次结束或释放时丢弃。此提供者专属映射扩展[应用归属决策](2026-06-21-mandatory-app-attribution-headers.zh.md)。

## 考虑过的替代方案

**加载整个社区订阅组合包。** 这会导入所需能力之外的账户 UI、路由、可选外部 Agent 集成和凭据存储假设。维护中的公开额度助手减少自有额度解析，同时不转移产品权威。

**自行实现 OAuth 和 Codex 传输。** 这会重复积极维护的协议代码。pi-ai 的公开凭据存储、fetch 和响应钩子无需传输分叉即可满足事务与请求归属要求。

**共享环境凭据或账户池。** 这些方式无法在刷新、并发请求和替换期间保留显式不可变账户选择。每条路由拥有一个受保护目标，绝不回退到其他账户。

## 结果

集成支持纯文本 SSE，产品组合要求 Windows 本地用户信任级存储。库升级需要重新验证授权与刷新、最终请求、轮次隔离和额度测试。无密钥测试使用受控外部响应执行真实维护库；真实端点使用资格仍需操作员授权验收。Agent Run 模型绑定和 API 密钥中转路由保持独立消费方。

状态 v11 通过相邻迁移添加账户表和 Host Operator 权限。历史 v10 domain 与 seal 保持独立可读，保留已有 Agent/Host 证据。更广泛的[能力提案](../../proposed/architecture/2026-08-18-saki-control-plane-capability-seams.zh.md) 仍对其他未实现能力有效。
