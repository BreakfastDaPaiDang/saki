# Agent Note: Saki local-user-trust DPAPI 凭据

Status: implemented

[English](2026-08-18-saki-local-user-trust-dpapi-credentials.md) | 中文

## Problem

Saki 的无人值守账号功能需要跨 Host 重启保留 refresh token 与 private key，又不能把它们复制到产品状态中。现有 `credentials-local` Provider 把受管理值保存在明文 YAML 中，在 Windows 上跳过 POSIX 仅所有者 mode 强制，而且与 Agent subprocess 共享 Host 用户可读取的文件系统。不透明 `CredentialRef` 可以防止意外传播，却不能描述有效来源的恢复信任模型，也不能让有特权的消费方在使用时拒绝较弱来源。

## Decision

[ADR 0011](../../../../docs/adr/0011-dpapi-local-user-trust-credentials.md) 已在通用 [`@deepseek-ai/dsh-credentials-windows-dpapi`](../../../../packages/credentials/credentials-windows-dpapi/README.md) Service Provider 和共享凭据 Service Definition 中实现。该包保持独立于 Provider Account Profile 与 Saki 包。Saki 单独拥有把特定 reference 分类为高价值并要求其保护等级的策略。

`ResolvedCredential` 与安全的 `CredentialInfo` 观测都携带由 Provider 定义的 `protectionLevel`。这些标识符描述恢复信任模型，不构成有序强度等级。`CredentialProvider.resolveRequired(ref, required)` 只解析一次，并比较该结果上的确切等级；值缺失、旧 Provider 结果没有有效元数据，或等级不同，都会在调用方获得值之前失败。明文 environment、Project `.env`、用户 `.env` 和 `.credentials.yaml` 来源明确报告 `plaintext`，不会继承安全默认值。

Windows Provider 报告 source `windows-dpapi-current-user` 和保护等级 `local-user-trust`。它的 version 1 文档只包含 `version` 与 `records`；每条记录只包含 kind `dpapi-current-user` 和 canonical-base64 密文。解析会拒绝未知字段、无效 reference、不支持的版本、空或非 canonical 密文，以及所有其他记录 kind。Provider 不提供 ambient、明文或机器范围回退。

原生适配器使用 `CRYPTPROTECT_UI_FORBIDDEN`、null description、null optional entropy、null reserved data 和 null prompt structure 调用 `CryptProtectData` 与 `CryptUnprotectData`。它绝不传递 `CRYPTPROTECT_LOCAL_MACHINE`，因此 Windows 的当前用户范围保持生效。DPAPI 拥有的输出在复制后通过 `LocalFree` 释放；临时 byte buffer 会被清零，同时包文档明确说明 JavaScript string 无法可靠清零。

每项操作都会重新读取并验证 Host-local 文档。写入在一个 Provider 实例内串行化，在跨进程 `dsh-atomic-write` 锁内重新读取，对记录排序，并通过原子操作提交。dispose 会等待活动写入，并拒绝尚未开始的排队写入或已捕获 service 的写入。对不存在 reference 执行 `unset` 不会发出更新事件。

`describe(ref)` 返回 reference、配置状态、source、保护等级、可写性、健康和观测时间，不返回明文或密文。复制、损坏或范围不同的记录仍是 configured，但报告 `unavailable`。Host API 通过显式允许列表映射这些字段；Provider 对象上的额外字段不会跨越 wire。原生层与 Provider 的失败会丢弃任意底层异常，因此 diagnostic 与 error cause 无法保留凭据输入。

只有有特权的 Host 消费方能获得 `ResolvedCredential.value`。该 Provider 不注册包含凭据材料的 Agent tool、Projection、Session event、export record 或模型上下文。其密文文档属于 Host-local data，按约定排除在可迁移 Installation Export 和 Host 替换 backup 之外。`local-user-trust` 这一名称刻意保留一项负面保证：任何有意以相同 Windows 用户身份运行的进程都可能对复制的 blob 调用 DPAPI。

## Deferred Saki composition

目前没有 Saki composition bundle、Provider Account Profile 实现、授权完成流程或 dispatch 准入消费方装配该 Provider。因此，这项通用能力并不声称 Codex、Kimi 或 Product GitHub App 凭据已经要求 `local-user-trust`，不声称 Host 替换已经创建 Intervention Request，也不声称产品 UI 已经公开凭据健康状态。Saki 0.1.0 规格继续保留这些产品义务。后续高价值消费方只有在自身 operation 边界调用 `resolveRequired`，并在凭据 Provider 之外只保存 reference 与安全观测时，才满足这项决策。

组织共享同样不属于本次实现。`local-user-trust` 不足以保护供其他组织成员使用的 Host 账号；该能力需要运行于独立 OS 安全身份下的 Credential Broker 或外部 secret manager、经过认证的 operation path，以及证明 Agent execution 无法恢复原始值的对抗性验证。

## Alternatives considered

**直接修改 `credentials-local`。** 该 package 的文档用途是可移植明文文件与 environment layering。把它替换为 Windows 专属加密存储会改变现有用户的配置语义，也会使通用 sibling capability 更难独立选择。

**增加 DPAPI 加密，同时保留静默明文回退。** 可用性提高的代价是保护声明取决于哪一层恰好胜出。Saki 需要为高价值 reference 提供可观测、快速失败的要求。

**只通过 `describe()` 暴露保护等级。** Admission 可能检查一个来源，而在并发更新后解析到另一个来源。把等级包含在解析结果中，可以让有特权 consumer 对即将使用的有效值强制要求；安全 description 仍用于 UI 与规划。

**把保护等级视为全序。** 不同存储机制的威胁模型不可简单比较。稳定描述标识符加显式 policy 可以避免声称每个未来 Provider 都普遍更强或更弱。

**让 DPAPI 密文可迁移。** 当前用户 DPAPI 通常把解密绑定到 Windows 用户和机器，而且本实现不提供受支持的可迁移恢复约定。复制通常不可用的密文会制造误导性 backup，增加事故处理复杂度，却不能实现恢复。

## Verification

共享凭据测试固定显式保护元数据和快速失败的确切等级解析，其中包括缺失值与旧版元数据。Windows integration 测试使用真实的当前用户 DPAPI API 验证静态密文和跨重启往返；确定性适配器测试覆盖原生失败、清理、无效 UTF-8、空明文和 diagnostic 脱敏。严格文档测试拒绝机器范围与格式错误记录。Host API 测试向 Provider 观测注入额外明文与密文字段，并证明两者都不会进入响应。受影响的凭据包在 Windows 上保持 statement、branch、function 与 line 全覆盖。

## Consequences

通用凭据 Service Definition 可以表达消费方接受的恢复模型，而不需要让 seam 构造错误的等级顺序。现有 Provider 与 test double 必须显式声明等级，需要保护的有特权调用方必须对自身消费的确切值使用 `resolveRequired`。

DPAPI 文档绑定当前 Windows 用户，通常也绑定机器，因此 Host 替换需要重新授权或重新导入，而不能恢复密文。这项实现降低明文静态存储与意外传播风险，但不能防御 Host 账号失陷、有特权 administrator、恶意已安装 Host 代码、定位并解密 blob 的同用户 Agent，或已经位于可信内存中的值。这些安全限制继续约束 Saki composition。
