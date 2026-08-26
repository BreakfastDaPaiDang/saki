---
status: accepted
---

# 采用仅向前迁移与 Installation State Generation 切换式维护

[English](0012-forward-migrations-and-installation-maintenance.md) | 中文

Saki 从 0.1.0 开始为持久化产品状态提供向前兼容承诺。它把控制面权威状态保存在通过 DSH `storageDomain` 路由的专用 SQLite 数据库中，只通过连续的向前步骤迁移，并在完整 Installation State Generation 之间切换升级。独立的 Installation 维护 plugin 拥有产品 backup、加密 export、restore 与 Host 替换行为。

## 决策原因

DSH 当前会拒绝版本与 `DomainSpec` 不同的 domain medium。该快速失败规则适合可替换的预发布 harness 数据，但 Saki 开始保存无法在每次 schema 变化后安全重建的 Project 关系、授权、自动化与恢复状态。否则，dogfood 只能在冻结数据模型和删除有用状态之间二选一。

存储层与产品维护层解决不同问题。`storageDomain` 已经拥有 domain schema、持久化校验和后端无关记录，因此应该拥有可选迁移机制。Saki 才理解哪些记录组成一个可迁移 Installation，以及恢复后的 Host 必须重新绑定什么，因此通用存储不得拥有 Saki export 内容、凭据 policy、自动化恢复或 Host 退役语义。

SQLite 适合作为 Saki 控制面的权威存储，因为其记录会频繁定点更新，并且必须在不重写整个文件的情况下增长。JSON 仍适用于测试和小型、便于人工阅读的 domain，但不是 Saki Installation 状态的生产权威来源。专用数据库还让 Saki 可以移动一份完整状态 generation，而不把它的生命周期与无关 DSH domain 耦合。

原地迁移会让迁移缺陷与回滚争用同一份唯一副本。并列 generation 会一直保留最后一份已知可读状态，直到 candidate 完成所有迁移与 invariant check。接受写入的 generation 由活动 manifest 决定，而不是由文件名或最新时间戳决定。

## 决策

每个 Saki 自有持久 schema 都从其第一个 0.1.0 schema 开始参与向前兼容序列。未登记迁移序列的 domain 继续遵守 DSH 当前的版本不匹配拒绝行为。可迁移 domain 为每个受支持的 `N -> N+1` 步骤登记源端与目标端校验 schema。调用方契约要求每个步骤都具有确定性且不产生外部 effect。Runner 只向同步 callback 提供 detached、深冻结 snapshot，并校验精确输入、相邻输出和已提交读回，但无法证明可重复性，也无法检测 ambient import；登记调用方拥有这些义务及其证据。磁盘数据版本高于当前 build，或者请求向下迁移时，系统快速失败。

Saki 通过 `storageDomain` 使用一个专用 SQLite 数据库保存权威控制面记录。升级首先停止新写入与自动化，排空自有写入，为活动 Installation State Generation 创建并验证 Recovery Backup，然后把独立 candidate 数据库依次迁移完每个连续步骤。Saki 使用目标 domain spec 打开并验证 candidate、检查产品 invariant，只在全部通过后原子修改 Installation manifest。切换前失败时，旧 generation 保持活动且不受修改。回滚使用 Recovery Backup 与声明的状态 capability 能读取其记录状态版本的 build；Saki 不实现反向迁移，而且回滚不会保留只被新 generation 接受的写入。

精确 B03 过渡由操作者手工保证冷维护：该 Host 早于 Installation lease，因此操作者必须先停止它并确认它保持离线，再调用 B18 维护可执行程序。从 B18 开始，每个 Host serving 生命周期与 cold-maintenance 命令都会为同一 Installation 根目录获取同一把不等待 Installation lease；正在持有 lease 的 Host 因而会排斥 backup、验证与升级。该 lease 无法追溯 fence B03 process，也无法协调被复制的 Installation 根目录。

`installation-maintenance` plugin 拥有 Saki 专属维护流程。Recovery Backup 是一份 Installation State Generation 的精确本地回滚 artifact；其元数据记录决定 reader 兼容性的状态版本，而源 build 只表示来源。Installation Export 是另一种加密、带版本的可移植 archive，包含 Saki 自有记录、带完整性 hash 的 inventory 和显式引用的 DSH Session export。它排除原始凭据、DPAPI 密文、cache、活动 process、worktree 内容，以及作为可复用资源权限的绝对路径。Export 格式标明源 schema 与 build，并使用受维护的认证加密实现，不自研密码学。

Restore 会先解密并校验到新的 candidate generation，不覆盖运行中的 Installation。显式替换 restore 保留 Saki Installation id，同时创建新的 Saki Host id。Resource Binding 进入 `needs-rebind`；Provider Account Profile 需要重新授权或通过仅 Host 可用的流程导入私钥材料；未解决 Host Operation 与 Execution Dispatch 需要对账；自动执行在恢复检查完成前保持禁用。替换 Host 激活前，旧 Host 必须退役或保持离线。0.1.0 不声称能够在操作者没有外部协调却故意启动两个历史副本时进行 fencing。

0.1.0 通过 PowerShell 7 与 Saki CLI 提供这些维护操作。完整 backup 管理 UI 不属于发布条件。

## 考虑过的方案

**继续拒绝所有旧 Saki schema。** 这会保留 DSH 预发布规则，但也会让 Saki 第一份持久 Project 状态成为一次性数据，无法在记录变化后可靠 dogfood。

**原地迁移 SQLite。** SQLite transaction 可以保护许多 DDL 变化，但应用迁移缺陷、invariant failure 和 build rollback 仍会作用于同一个唯一数据库。Candidate generation 以额外磁盘空间与维护时间为代价，换取更简单的恢复点。

**由 Saki 直接读取 SQLite 表实现迁移。** 这会重复后端知识，绕过负责校验的 domain schema，并把 Saki 耦合到单一存储实现。通用可选迁移属于 `storageDomain`；Saki 只选择路由后端并编排产品维护。

**把控制面完全改为 event sourcing。** 追加式产品 journal 可以重建旧 Projection，但也会为每条 Saki 记录引入 event schema 演进、replay、compaction 和时间语义。现有生命周期记录加外部 evidence 已满足 0.1.0 的审计与恢复要求。

**用 JSON 作为 Saki 权威数据库。** 人工可读很有价值，但整 unit 发布会使高频控制记录越来越昂贵，并形成比 SQLite document-per-row 存储更大的故障与争用单元。

**提供反向迁移。** 反向步骤通常无法恢复新 schema 丢弃或重新解释的信息。把精确 Recovery Backup 与声明支持其记录状态版本的 reader 配对，才是实际的回滚保证。

**在 Host 替换时复制整个 Harness home。** 这会把可迁移 Installation 状态与凭据、cache、活动 process 残留、本地路径和无关 DSH 数据混在一起，还会鼓励两个可写副本。明确声明的 Installation Export 可以显式列出包含和排除的权限。

## 后果

Saki 升级需要短暂维护窗口，也需要足够空间同时保存活动 generation、candidate 与 Recovery Backup。Manifest 和保留 backup 会成为关键恢复元数据；清理逻辑不得删除声明的回滚状态版本所需的唯一 generation。

DSH storage 获得可选迁移路径，同时不会削弱未承诺兼容 domain 的快速失败行为。Saki 获得产品专属维护 module，而无需让通用存储理解 Project、Session、凭据或 Host。Backup 与 export 测试必须覆盖损坏、manifest 切换前后中断、迁移步骤缺失、磁盘版本过新、解密材料错误、secret 与路径排除、restore 到非空目标，以及 restore 后的恢复状态。

Installation Export 保留身份与关系，不保留机器权限。因此，Host 替换包含可见的重新绑定、重新授权、对账和旧 Host 退役工作。单写入者保证仍是运维约束，而不是分布式保证；未来的无人值守 failover 或共享存储部署需要外部协调和新的决定。
