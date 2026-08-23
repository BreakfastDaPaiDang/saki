---
status: accepted
---

# 使用 DPAPI，并明确 local-user-trust 凭据边界

[English](0011-dpapi-local-user-trust-credentials.md) | 中文

Saki 0.1.0 使用通用 Windows DPAPI 凭据 Provider 保存受管理的 OAuth refresh token 与私钥，并把 Credential Protection Level 明确声明为 `local-user-trust`。它保护持久化值，但不声称以 Host Windows 用户身份运行的恶意进程无法恢复这些值。

## 决策原因

现有 `credentials-local` Provider 在 `.credentials.yaml` 中持久化明文值。它的仅所有者 mode 检查不会在 Windows 上运行，而 DSH 的 Windows 沙箱限制写入而不限制读取。产品记录只保留 `CredentialRef` 可以防止值被意外复制到 Projection、event、log 和 Agent 上下文，却不能防止同用户 Agent 进程读取底层文件。

使用当前用户范围的 Windows DPAPI 可以如实改善 0.1.0 的边界：其他普通 OS 用户无法通过同一 API 解密复制的 blob，Saki 同时可以在不要求额外口令的情况下完成设备授权和无人值守重启。DPAPI 不会在同一个 Windows 登录身份内部创建进程边界。机器范围更弱，因为机器上的任何用户都可以解密机器范围数据，所以 Saki 禁止使用它。

## 决策

一个通用 `credentials-windows-dpapi` Service Provider 实现 `ctx.credentials`，并保持为可贡献给上游 DSH 的候选能力。Saki bundle 负责装配它；Saki 不创建产品专属账号保险库。Provider 只把受管理值保存为 DPAPI 当前用户密文；对于 Saki 分类为受管理高价值凭据的 reference，它绝不回退到明文 YAML、`.env` 或机器范围 DPAPI。

凭据 seam 在安全描述元数据和每次解析结果中报告由 Provider 定义的 Credential Protection Level。Saki 要求 Codex 与 Kimi refresh token 和 Saki Product GitHub App private key 达到 `local-user-trust`。值缺失或来自 ambient、明文来源时，授权或 dispatch 会失败，而不是静默降低要求。

只有有特权的 Host Provider 解析原始值。控制面、Web API、Projection、Agent tool、Session event、log 和 diagnostic 只接收 `CredentialRef`、保护等级与健康观测和提供方身份。这是可信 plugin composition 内的架构限制，不声称 OS 能阻止每个以相同用户身份安装的 plugin 调用凭据服务。

Installation export 和 Host 迁移排除明文值与 DPAPI 密文。替换 Host 后，设备码账号需要重新授权，非 OAuth 私钥材料需要通过仅 Host 可用的流程重新导入。在 Saki 允许组织成员消费 Host 供应的账号之前，它必须采用运行于独立 OS 安全身份下的 Credential Broker 或外部 secret manager，并验证 Agent execution 无法恢复原始值。

## 考虑过的方案

**保留 `credentials-local`。** Reference 仍能限制意外传播，但高价值值会继续以明文静态保存，并可被同用户 Agent 有意读取。该边界不足以承载无人值守订阅凭据与 GitHub App 凭据。

**把 DPAPI 或 Windows Credential Manager 描述为 Agent 隔离。** 两者都在当前用户的安全上下文中运行。它们可以改善存储处理，却不能把同用户 Agent 进程与 Host 凭据权限分开，因此这种描述会夸大保护能力。

**使用机器范围 DPAPI。** 它便于在同一台计算机内迁移服务，但会允许该计算机上的其他用户解密，从而削弱已接受的边界。

**每次重启后要求输入口令。** 这可以增加一个单独持有的 secret，却会阻塞无人值守恢复与自动化，而且口令仍需要安全的运行时路径。0.1.0 改为明确接受本地用户限制。

**在 0.1.0 构建 Credential Broker。** 独立身份是组织共享的正确前置条件，但它会在单操作者产品尚不需要时加入进程隔离、IPC 认证、部署、恢复和提供方操作设计。组织共享门槛保留了这项要求，同时不假装它已经实现。

## 后果

凭据数据绑定用户与机器，不具备可迁移性。Backup 与 export 只保留 reference 和安全元数据，因此替换 Host 需要显式重新授权或重新导入。UI 与 diagnostic 必须显示 `local-user-trust` 及其限制，不能只展示笼统的安全标记。

DSH 凭据 seam 增加安全的保护元数据，而 Windows Provider 继续独立于 Saki 账号路由。测试必须证明静态数据为密文、采用当前用户范围、受保护 reference 不会回退到明文或机器范围、产品界面与 export 不含值，并且缺失或过弱保护元数据会快速失败。
