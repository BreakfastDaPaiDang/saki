# Agent Note: Saki 向前迁移与 Installation 维护

Status: proposed

[English](2026-08-18-saki-forward-migrations-and-installation-maintenance.md) | 中文

## 问题

Saki 0.1.0 开始持久化不可替代的控制面关系，而 DSH `storageDomain` 会拒绝磁盘版本与运行中 `DomainSpec` 不同的所有 domain。Saki 需要在 dogfood 中演进这些记录、从中断升级恢复、回滚有缺陷的 build，并在不把凭据、活动 process 残留或本地路径复制成可迁移权限的情况下替换 Windows Host。这些需求不得让 Saki 了解 SQLite 表，也不能让通用存储理解 Project、Session、凭据与 Host 语义。

## 提案

分两层实现 [ADR 0012](../../../../docs/adr/0012-forward-migrations-and-installation-maintenance.zh.md)。扩展 `packages/storage/storage-domain`，提供可选、后端无关的向前迁移机制。增加 `packages/saki/installation-maintenance` 作为 Saki 产品 Consumer，由它让控制面停稳、创建并校验 state generation、调用 domain migration、发布活动 generation、导出可迁移状态，并在替换 Host 上恢复 Installation。

通用层已经由[回调作用域的关闭领域迁移决策](../../implemented/architecture/2026-08-25-callback-scoped-closed-domain-migration.zh.md)实现。Saki 专属 lease、manifest 选择、Recovery Backup、v2→v3 升级与崩溃恢复由[manifest 选择式 Installation 维护决策](../../implemented/architecture/2026-08-26-saki-manifest-selected-installation-maintenance.zh.md)实现。本提案继续保持活跃，用于加密 export、显式 Recovery Backup restore、retention 与替换 Host restore。

把 Saki 权威控制面 domain 路由到专用 `storage-sqlite` backend 与数据库文件。其他 DSH domain 保留各自配置的路由和生命周期。JSON 仍用于 Saki 控制面 contract suite 和确实很小、便于人工阅读的 domain；生产 Saki 状态不会根据记录数量自动切换 backend。

### Domain migration 机制

可迁移 domain 声明当前版本、每个保留源版本的校验 schema，以及每个受支持相邻版本对之间的一项 migration。Registry 会拒绝重复步骤、从受支持源版本到当前版本之间的缺口、非整数版本，以及端点不是 `N -> N+1` 的步骤。没有该 registry 的 domain 保留当前 `version-mismatch` 行为。

Migration 与[声明式派生 medium reset proposal](2026-07-28-storage-root-and-derived-medium-recovery.zh.md)是互斥 policy。派生 domain 可以丢弃并重建损坏或版本不匹配 medium；承诺兼容的权威 domain 必须迁移或拒绝。任何 domain 都不得在 migration 失败后回退为 reset。

Domain 层通过通用存储 operation 预留并检查已关闭的磁盘 unit，使用匹配的历史 descriptor 读取并校验一份 detached snapshot，而且不打开或改变源端；随后应用一个 migration step，并在继续前用下一个版本完整校验输出。Step 接收 JSON 兼容记录并返回新的 JSON 兼容记录；其声明输入不包含 backend、Cordis context、credential resolver、clock、network client 或可变 domain handle。确定性与不产生外部 effect 是调用方义务，因为运行时无法检测 ambient import。Migration 不发送普通 `domain/changed` event，因为没有活动 domain 观察 candidate。

最终 snapshot 写入全新目标 unit，并在两项关闭 unit 预留仍然持有时通过当前 schema 读回。Saki 维护层随后会在发布前通过普通当前 `DomainSpec` 打开该候选并校验产品不变量。现有运行时写入排序、持久化后 event 与记录 operation 保持不变。磁盘版本高于运行版本、步骤缺失、源数据无效、输出无效、表未知或目标 invariant failure 都会中止，而且不会改变选中的 generation。Migration API 向维护代码公开结构化版本与校验证据，不公开 backend-specific row。

### Installation State Generation

一个小型 Installation manifest 记录 Installation id、活动 generation id、Saki state format 版本，以及对 generation 元数据的精确完整性 reference。Generation 元数据记录 creator-build 来源。每个 generation 都是一份完整的专用 Saki 数据库。只有 manifest 选中的一个 generation 处于活动且可写状态；candidate 以及所有保留或已备份 generation 都保持关闭且不可变。

0.1.0 升级顺序如下：

1. 进入维护模式，拒绝新的 mutation Intent，禁用自动化，排空 `storageDomain` 写入，并等待可以安全停稳的 Saki 自有 operation。无法停止的外部 operation 进入对账，而不能被报告为已完成。
2. 关闭活动 Saki domain 与数据库。创建仅所有者可读的 Recovery Backup，其中记录活动 generation id、精确 state format 版本、源 build 来源、长度和加密摘要，并在继续迁移前验证该 artifact。
3. 创建新的 candidate generation。调用通用 domain migration 依次通过每个连续版本，并使用当前 `DomainSpec` 打开结果数据库。
4. 校验 Installation identity、引用完整性、唯一 admission owner、生命周期枚举、已占用 Execution Lease、非终态 Intent 与 Dispatch 的可恢复性，以及不存在 secret value。写入并 fsync candidate manifest，然后原子替换活动 manifest。
5. 重新打开选中的 generation，执行普通启动恢复，并且只在恢复进入安全状态后接受新工作。保留的旧 generation 维持只读，直到 retention policy 允许删除。

启动时，manifest 是唯一 selector。Candidate 文件、backup 时间戳或数值最大的 generation 都不会隐式获胜。Manifest 替换前崩溃时选择旧 generation，替换后崩溃时选择新 generation。如果 manifest 或选中 generation 未通过完整性检查，启动会进入维护恢复，绝不猜测另一个写入者。回滚会显式安装声明状态 capability 能读取 backup 状态版本的 build，再恢复该 Recovery Backup；记录的源 build 只表示来源，可以帮助选择候选，但绝不是兼容性门禁。不支持反向迁移。

### Recovery Backup 与 Installation Export

Recovery Backup 用于本地回滚，并保存一份精确 Saki Installation State Generation。其记录的状态版本决定 reader 兼容性，源 build 则只标识来源；该 artifact 不能被当作可迁移 Host transfer 声明。它只包含专用 Saki 数据库和维护元数据；Host 凭据 store 位于 generation 之外。虽然 Saki 数据库只包含 reference 而非原始凭据，仍必须使用仅所有者文件系统保护与已验证 hash。

Installation Export 是包含认证加密 envelope、manifest 和内容 hash 的带版本可迁移 archive。实现会选择受维护 library，并记录格式、使用口令时的密钥派生参数、加密算法、archive 版本、源 build、源 state 版本、Installation id 与包含文件 inventory。Saki 不实现密码学原语。Export 首先产生一致的只读 generation snapshot，并为保留 Work Session 显式关联的每个 Session 使用现有 DSH Session export capability；它不直接复制活动 Session persistence medium。

可迁移 archive 包含 Saki 自有 domain 记录、安全的 Provider Account Profile 元数据与凭据 reference、Project 与 Work Item 关系、自动化 policy、对账状态、具有可迁移表示的生成 artifact reference，以及声明的 Session export。它排除明文凭据、DPAPI 密文、ambient environment value、可重建 cache 与 index、活动 process 与 terminal 状态、package cache、worktree byte，以及作为可复用 Resource Binding 权限的绝对路径。Manifest 列出每个排除类别并标识不完整可迁移依赖。当关联 worktree change 或必需 artifact 只存在于源 Host 时，export 不能被描述为已可替换；CLI 会报告这些条件，并要求先解决或显式生成不可迁移 diagnostic export。

### Restore 与 Host 替换

Restore 绝不覆盖活动 Installation。它会解密、验证 hash 与版本、校验每条包含记录，通过拥有 Session 的 capability 导入 Session archive，并构建新的 candidate generation。替换 restore 保留 Installation id，创建新的 Host id，把源 Host 记录为已退役或等待显式确认退役，然后通过和升级相同的 manifest switch 发布 candidate。

每个 Resource Binding 都进入 `needs-rebind`，其原 display path 只保留为提示。使用 Host 绑定凭据的 Provider Account Profile 变成不可用，并产生 Intervention Request，要求设备重新授权或通过仅 Host 可用流程导入私钥材料。非终态 Host Operation 与 Execution Dispatch 进入对账，因为替换 Host 无法推断旧 process 结果。占用中的 Execution Lease 在 operation evidence 与 binding ownership 完成对账前保持阻塞。自动化保持禁用，直到这些状态和必需 GitHub refresh 都完成。

维护命令会警告操作者在激活前让旧 Host 保持离线或完成退役。0.1.0 没有外部 coordinator，无法 fence 故意启动两个已恢复历史副本的操作者。未来远程控制面部署必须用经过认证的 lease 或 leader coordination 替代该运维规则。

### 命令与 package 所有权

`packages/saki/installation-maintenance` 拥有 `upgrade`、`backup`、`export`、`restore`、`verify` 与 retention 编排，并公开适合未来 UI 的类型化进度。0.1.0 只把这些 operation 接到 Saki CLI 与 PowerShell 7 管理脚本。`packages/saki/control-plane` 提供停稳、invariant 校验、恢复状态与可迁移记录选择；它不读取 archive 文件或数据库 row。只有 `storage-domain` 无法通过当前 facet 实现时，storage backend 才提供通用 closed-medium inspection 与 materialization 原语。

## 考虑过的方案

**让 Saki 继续遵守仓库的无迁移预发布规则。** 该规则可以避免 DSH 过早承担兼容包袱，但 Saki 的第一个 dogfood schema 已经保存用户拥有的关系。重置该状态属于产品数据丢失 policy，不只是开发便利性问题。

**在 raw SQLite 之上增加 Saki migration abstraction。** 初期看起来更小，但每个 migration 都会依赖 backend layout，并绕过用来证明每个步骤的历史 zod schema。扩展现有 domain owner 可以让其他持久 consumer 使用迁移，又不会强制它们启用。

**执行原地 transaction，只在失败时复制文件。** Transaction 不能防御 reopen 后才发现的应用 invariant，也无法处理产生新写入后再回滚旧 build。不可变 candidate 与显式发布点让两种故障决策保持简单。

**把 Session 放进 Saki 数据库。** DSH Session log 有独立的 append、lineage、attachment、compression 与 export 语义。Saki 需要稳定 reference 和声明式 export，不需要第二个 Session 权威来源。

**导出 Harness home。** 这会意外包含凭据、无关 profile、cache 状态和位置专属介质，同时无法说明替换 Host 如何获得权限。带 manifest 的 allowlist archive 更易审阅与测试。

**要求 0.1.0 提供完整维护 Web UI。** 第一版 dogfood 的单一 Host Operator 可以使用 PowerShell 7 与 CLI。类型化进度与 error result 可以保留未来 UI，而不延误状态安全机制。

## 验收条件

- 没有 migration registry 的 domain 仍拒绝所有版本不匹配；已登记连续 chain 会在 backend 支持 closed-unit materialization 时，通过 JSON 与 SQLite contract test 把每个保留源版本迁移到当前 schema；migration 与派生 medium reset 不能同时启用。
- Migration test 会拒绝步骤缺口、向下迁移请求、较新磁盘数据、输入突变、无效源记录与目标记录、外部服务访问、未知表，以及最终校验前发布。
- 在每个升级阶段进行 crash injection，证明恰好一个 manifest 所选 generation 可以 reopen，而且尚未发布时旧活动数据库保持逐 byte 相同。
- Recovery Backup 验证会发现截断、digest 不匹配、不受支持的状态版本、元数据缺失，以及把 artifact 用作可迁移 restore 的尝试。
- Installation Export 通过认证加密 round-trip Saki 记录与关联 Session export；扫描证明其中不存在明文凭据、DPAPI 密文、ambient value、可复用绝对路径权限、cache、worktree 内容与活动 process 状态。
- 替换 restore 保留 Installation id、分配新 Host id、把 Resource Binding 标记为 `needs-rebind`、禁用 Host 绑定 Profile、对账未解决 Dispatch 与 Operation 状态，并在恢复完成前保持自动化禁用。
- PowerShell 7 与 CLI flow 可以完成 backup、verify、upgrade、export、restore 到空目标，并在没有 Web UI 时生成机器可读失败证据。

## 风险

历史 schema 会增加维护成本，也可能被误解为必须无限保留旧产品模型。兼容承诺适用于持久数据，不适用于每个旧 API 或 plugin 配置；retention policy 可以定义受支持的直接升级下限，但仍需从该下限保留完整 chain。

并列 generation 需要额外磁盘空间，也要求 Windows 上具备可靠原子发布。杀毒软件、突然断电或手工编辑文件可能中断文件系统 operation，因此每个阶段都需要 fsync 等价发布、完整性验证，并基于 manifest 而不是目录发现提供确定性重启行为。

加密 archive 仍然敏感：弱口令、泄漏的命令行参数、复制的解密临时文件或过度详细的 diagnostic 都可能破坏 envelope。实现必须避免在 argument 与 log 中出现 secret，限制临时文件，并使用经审阅 library。Installation 可迁移性也不会让 worktree 可迁移；如果操作者忽略源 Host 和未提交变化警告，就可能恢复出底层资源不可用的关系。
