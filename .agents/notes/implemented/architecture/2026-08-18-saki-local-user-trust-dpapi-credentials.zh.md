# Agent Note: Saki local-user-trust DPAPI 凭据

Status: implemented

[English](2026-08-18-saki-local-user-trust-dpapi-credentials.md) | 中文

## 问题

Saki 的无人值守账号功能需要跨 Host 重启保留刷新令牌与私钥，又不能把它们复制到产品状态中。现有 `credentials-local` 提供方把受管理值保存在明文 YAML 中，在 Windows 上跳过 POSIX 仅所有者权限模式强制，而且与 Agent 子进程共享 Host 用户可读取的文件系统。不透明 `CredentialRef` 可以防止意外传播，却不能描述有效来源的恢复信任模型，也不能让有特权的消费方在使用时拒绝较弱来源。

## 决策

[ADR 0011](../../../../docs/adr/0011-dpapi-local-user-trust-credentials.md) 已在通用 [`@deepseek-ai/dsh-credentials-windows-dpapi`](../../../../packages/credentials/credentials-windows-dpapi/README.md) Service Provider 和共享凭据 Service Definition 中实现。该包保持独立于 Provider Account Profile 与 Saki 包。Saki 单独拥有把特定引用分类为高价值并要求其保护等级的策略。

`ResolvedCredential` 与安全的 `CredentialInfo` 观测都携带由提供方定义的 `protectionLevel`。这些标识符描述恢复信任模型，不构成有序强度等级。同一进程内的类型化接口要求每个提供方构造该字段；解析器和其他无类型输入则在构造提供方结果前完成校验。`CredentialProvider.resolveRequired(ref, required)` 只解析一次，并比较该结果上的确切等级；值缺失或等级不同时，都会在调用方获得值之前失败。明文环境、项目 `.env`、用户 `.env` 和 `.credentials.yaml` 来源明确报告 `plaintext`，不会继承安全默认值。

Windows 提供方报告来源 `windows-dpapi-current-user` 和保护等级 `local-user-trust`。它的版本 1 文档只包含 `version` 与 `records`；每条记录只包含类型 `dpapi-ng-local-user` 和采用规范 base64 的密文。解析会拒绝未知字段、无效引用、不支持的版本、空或非规范密文，以及所有其他记录类型。该提供方不提供环境、明文、经典 DPAPI 或机器作用域回退。

经典 `CryptUnprotectData` 不返回保护数据块时所用的作用域，因此可写的记录类型无法证明当前用户保护。原生适配器改用 CNG DPAPI。保护操作创建 `LOCAL=user` 描述符并调用 `NCryptProtectSecret`；解密操作通过 `NCryptUnprotectSecret` 取得受保护数据块携带的描述符，再通过 `NCryptGetProtectionDescriptorInfo` 读取完整规则，并在把明文复制到 JavaScript 前要求该字符串严格等于 `LOCAL=user`。经典 DPAPI 数据块、`LOCAL=machine`、缺失描述符和未知规则都会失败关闭。

每个描述符句柄都通过 `NCryptCloseProtectionDescriptor` 关闭。Windows 拥有的描述符字符串与数据分配通过 `LocalFree` 释放；无论原生调用成功或失败，每个返回的数据分配都会在释放前被覆写，包括地址非空但长度为零的结果。临时 JavaScript 字节缓冲区会被清零，同时包文档明确说明 JavaScript 字符串无法可靠清零。

每项操作都会重新读取并验证 Host 本地文档。写入在一个提供方实例内串行化，在跨进程 `dsh-atomic-write` 锁内重新读取，对记录排序，并通过原子操作提交。资源释放会等待活动写入完成，并拒绝尚未开始的排队写入，以及通过已捕获服务发起的新写入。对不存在的引用执行 `unset` 不会发出更新事件。

`describe(ref)` 返回引用、配置状态、来源、保护等级、可写性、健康状态和观测时间，不返回明文或密文。复制、损坏、采用经典 DPAPI 或作用域不同的记录仍为已配置，但报告 `unavailable`。Host API 通过显式允许列表映射这些字段；提供方对象上的额外字段不会进入读取响应。具名的只写 `credentials.set` 请求会把明文传给提供方，但绝不会回显。原生层与提供方会在失败时丢弃任意底层异常，因此诊断与错误原因无法保留凭据输入。

只有有特权的 Host 消费方能获得 `ResolvedCredential.value`。该提供方不注册包含凭据材料的 Agent 工具、Projection、会话事件、导出记录或模型上下文。其密文文档属于 Host 本地数据。通用包不实现进程崩溃收集、可携带的 Installation Export 或 Host 更换备份；Saki 组合层拥有这些场景的排除规则。`local-user-trust` 这一名称刻意表明其安全限制：任何有意以相同 Windows 用户身份运行的进程都可能对复制的密文调用 DPAPI。

## 暂缓的 Saki 组合

目前没有 Saki 组合包、Provider Account Profile 实现、授权完成流程或派发准入消费方装配该提供方。因此，这项通用能力并不声称 Codex、Kimi 或 Product GitHub App 凭据已经要求 `local-user-trust`，不声称 Host 替换已经创建 Intervention Request，也不声称产品界面已经公开凭据健康状态。Saki 0.1.0 规格继续保留这些产品义务。后续高价值消费方只有在自身操作边界调用 `resolveRequired`，并在凭据提供方之外只保存引用与安全观测时，才满足这项决策。

组织共享同样不属于本次实现。`local-user-trust` 不足以保护供其他组织成员使用的 Host 账号；该能力需要运行于独立 OS 安全身份下的 Credential Broker 或外部机密管理器、经过认证的操作路径，以及证明 Agent 执行无法恢复原始值的对抗性验证。

## 考虑过的方案

**直接修改 `credentials-local`。** 该包的文档用途是可移植明文文件与环境分层。把它替换为 Windows 专属加密存储会改变现有用户的配置语义，也会使通用平级能力更难独立选择。

**增加 DPAPI 加密，同时保留静默明文回退。** 可用性提高的代价是保护声明取决于哪一层恰好胜出。Saki 需要为高价值引用提供可观测、失败关闭的要求。

**只通过 `describe()` 暴露保护等级。** 准入逻辑可能检查一个来源，而在并发更新后解析到另一个来源。把等级包含在解析结果中，可以让有特权的消费方对即将使用的有效值强制实施保护要求；安全描述仍用于界面与规划。

**把保护等级视为全序。** 不同存储机制的威胁模型不可简单比较。稳定描述标识符加显式策略，可以避免声称每个未来提供方都普遍更强或更弱。

**让 DPAPI 密文可迁移。** 当前用户 DPAPI 通常把解密绑定到 Windows 用户和机器，而且本实现不提供受支持的可迁移恢复约定。复制通常不可用的密文会制造误导性备份，增加事故处理复杂度，却不能实现恢复。

## 验证

共享凭据测试固定显式保护元数据，以及缺失值和等级不同时失败关闭的精确解析。确定性原生适配器测试固定描述符校验、句柄与分配清理、释放前覆写顺序、零长度输出、原生失败、无效 UTF-8、空明文和诊断脱敏。真实 Windows 测试固定 CNG DPAPI `LOCAL=user` 静态密文和跨重启往返，再给真正的 CNG `LOCAL=machine` 与经典 LocalMachine 数据块换上受支持的记录类型，并证明两者仍保持不可用且无法解析。真实 Loader 组合从源码与构建后的包运行；无密钥可运行快照固定 Host 安全视图的响应字段。严格文档测试拒绝格式错误的记录和不支持的类型。Host API 测试向提供方观测注入额外明文与密文字段，并证明两者都不会进入读取响应。受影响的凭据包在 Windows 上保持完整的语句、分支、函数与行覆盖率。

## 后果

通用凭据 Service Definition 可以表达消费方接受的恢复模型，而不需要让 seam 构造错误的等级顺序。现有提供方与测试替身必须显式声明等级，需要保护的有特权调用方必须对自身消费的确切值使用 `resolveRequired`。

DPAPI 文档绑定当前 Windows 用户，通常也绑定机器，因此 Host 替换需要重新授权或重新导入，而不能恢复密文。这项实现降低静态明文存储与意外传播带来的风险，但不能防御 Host 账号失陷、有特权管理员、恶意已安装 Host 代码、定位并解密密文的同用户 Agent，或已经位于可信内存中的值。这些安全限制继续约束 Saki 组合层。
