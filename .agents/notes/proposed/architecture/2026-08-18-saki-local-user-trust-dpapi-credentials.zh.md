# Agent Note: Saki local-user-trust DPAPI 凭据

Status: proposed

[English](2026-08-18-saki-local-user-trust-dpapi-credentials.md) | 中文

## Problem

Saki 0.1.0 需要在无人值守重启后继续保存 Codex 与 Kimi refresh token，以及 Saki Product GitHub App private key。现有 `credentials-local` Provider 把值保存在明文 YAML 中，在 Windows 上跳过 POSIX 仅所有者 mode 强制，而且与 Agent subprocess 共享 Host 用户可读取的文件系统。不透明 `CredentialRef` 可以阻止产品记录意外传播值，却没有定义存储值受到何种保护，也无法让 Saki 拒绝较弱的有效来源。

## Proposal

把 [ADR 0011](../../../../docs/adr/0011-dpapi-local-user-trust-credentials.md) 实现为通用 DSH `credentials-windows-dpapi` Service Provider，并由 Saki bundle 装配。该 package 独立于 Provider Account Profile，并保持为上游候选；Saki 只拥有把特定 reference 分类为高价值并要求其保护等级的 policy。

为安全的 `CredentialInfo` 元数据和 `ResolvedCredential` 增加由 Provider 定义的 `protectionLevel`。标识符用于描述，不隐含全序关系。Windows Provider 为当前用户 DPAPI layer 报告 `local-user-trust` 和独立 source id。现有 ambient 与明文 layer 各自报告明确等级，不能被视为强度未知。

对于受管理高价值 reference，只有有效解析结果报告 `local-user-trust` 时，Saki 才接受授权完成、Profile 激活和外部副作用准入。Environment、Project `.env`、用户 `.env`、`.credentials.yaml`、缺失元数据和机器范围 DPAPI 都会被拒绝。其他通用 DSH consumer 可以在自身 policy 允许时继续使用其他来源。

Provider 在 Harness home 下拥有一个可版本化不透明文档，把 `CredentialRef` 映射到 DPAPI 当前用户密文和安全元数据。它绝不写入受管理明文，也不提供可选明文回退。写入继续满足凭据 seam 的原子更新、逐 operation 解析、受控 notification 和 diagnostic 不含 secret 的要求。确切文件 schema 与 migration 行为由数据演进决定拥有，不由 Saki 账号记录拥有。

只有有特权的 Host Provider consumer 可以获得 `ResolvedCredential.value`。Saki 控制面和 Host transport 使用安全凭据目录，只公开 reference、source、保护等级、配置状态、可写性、健康和最后观测，不包装或返回 `resolve`。Agent tool 与动态 execution context 不获得原始 resolver。这项代码级限制减少意外访问；声明的 `local-user-trust` 等级仍假定任何有意以 Host Windows 用户身份运行的进程都可能恢复复制的 DPAPI blob。

面向 Host 替换的 export 与 backup、Projection、event、log、diagnostic、crash artifact 和 Agent 上下文排除明文与密文。在另一台 Host 恢复产品状态后，相关 Profile 保持不可用，并创建 Intervention Request，要求设备重新授权或重新导入私钥材料。原 Host 的存储仍是 Host-local data，不成为可迁移 Installation state。

未来组织共享功能不得在 `local-user-trust` 下暴露 Host 供应的模型账号。它首先需要运行于独立 OS 安全身份下的 Credential Broker 或外部 secret manager、到可信 Provider 代码的认证操作路径，并验证 Agent execution 无法读取或解密原始值。本 proposal 保留这项要求，但不设计 broker protocol。

## Alternatives considered

**直接修改 `credentials-local`。** 该 package 的文档用途是可移植明文文件与 environment layering。把它替换为 Windows 专属加密存储会改变现有用户的配置语义，也会使通用 sibling capability 更难独立选择。

**增加 DPAPI 加密，同时保留静默明文回退。** 可用性提高的代价是保护声明取决于哪一层恰好胜出。Saki 需要为高价值 reference 提供可观测、快速失败的要求。

**只通过 `describe()` 暴露保护等级。** Admission 可能检查一个来源，而在并发更新后解析到另一个来源。把等级包含在解析结果中，可以让有特权 consumer 对即将使用的有效值强制要求；安全 description 仍用于 UI 与规划。

**把保护等级视为全序。** 不同存储机制的威胁模型不可简单比较。稳定描述标识符加显式 policy 可以避免声称每个未来 Provider 都普遍更强或更弱。

**让 DPAPI 密文可迁移。** 当前用户 DPAPI 有意把解密绑定到 Windows 用户和机器。复制不可用密文会制造误导性 backup，增加事故处理复杂度，却不能实现恢复。

## Acceptance criteria

- 通用 Windows 凭据 Provider 通过共享凭据 contract suite 与 Windows integration coverage，且不依赖 Saki package。
- 受管理值在磁盘上不含明文，使用 DPAPI 当前用户范围，并且无法通过配置选择机器范围。
- `CredentialInfo` 与 `ResolvedCredential` 暴露安全、由 Provider 定义的保护元数据；`describe()` 不会获得任何 secret value。
- 当受管理 Codex refresh token、Kimi refresh token 或 Product GitHub App private key 的有效来源或保护等级不满足 `local-user-trust` 时，Saki 拒绝使用它。
- 控制面记录、wire payload、Projection、Session event、Agent tool、log、diagnostic、crash output 与可移植 export 只包含 reference 和安全观测。
- Host 替换会恢复产品关系，但受保护 Profile 在设备重新授权或仅 Host 可用的私钥导入完成前保持不可用。
- 产品 UI 显示 `local-user-trust` 的限制；如果没有单独接受的 Credential Broker 设计与对抗性隔离测试，第三阶段共享账号工作不得宣称完成。

## Risks

DPAPI 无法防御 Host Windows 账号失陷、有特权 administrator、恶意已安装 Host 代码、定位并解密 blob 的同用户 Agent，或已经位于可信 Provider 内存中的值。JavaScript string 也无法可靠清零。Provider 降低明文静态存储和意外传播风险，但不能被用作进程隔离证据。

为通用 seam 增加保护元数据会影响每个凭据 Provider 和 test fake；不谨慎的默认值可能把 legacy source 静默标记为安全。该变化必须要求 Provider 显式声明。绑定 Host 的存储也会使灾难恢复依赖重新授权；UI 与 backup flow 必须在故障前显示这个后果。
