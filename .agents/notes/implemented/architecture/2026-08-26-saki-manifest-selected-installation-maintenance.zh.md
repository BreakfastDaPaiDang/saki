# Agent Note: 由 manifest 选择的 Saki Installation 维护

Status: implemented

[English](2026-08-26-saki-manifest-selected-installation-maintenance.md) | 中文

## 问题

B03 Saki Host 把首批持久控制面关系保存在无 manifest 的 SQLite 数据库中，其 domain 版本与 generation 词汇不同于当前 schema。通过普通当前 domain open 为该数据库提供服务只会拒绝它，或者在完成产品级校验前冒险改变唯一已知良好源。Backup、升级、应用启动与崩溃恢复还需要同一个 writer 决定：candidate、backup、journal 或较新的文件名绝不能通过发现过程成为权威。

Build 来源无法回答格式兼容性。两个 build 可能读取同一个状态版本；一个 build 也可能创建另一个 build 无法提供服务的新版本。把 build-id 相等当成兼容性检查会拒绝可读 backup；如果元数据被错误复制，它还可能放行不可读格式。

## 决策

`@breakfastdapaidang/saki-installation-maintenance` 拥有 Saki 的 Installation lease、状态源选择、状态 generation manifest、Recovery Backup、operation 恢复、对外服务准备和离线升级。[通用关闭 domain 迁移决策](2026-08-25-callback-scoped-closed-domain-migration.zh.md)继续拥有后端无关源检查与仅创建式物化；Saki 拥有 Installation identity、产品 invariant、权威发布与清理。

### 状态兼容性

`SakiStateCapability` 是兼容性权威。当前 capability 可以读取产品状态版本 2 到 8，但只能写入版本 8。版本 2 是精确 B03 `saki_control_plane@2` 声明，不含 storage-generation seal。保留的版本 3 要求 `saki_control_plane@3` 与独立 `saki_storage_generation@1` seal；保留的版本 4 要求 `saki_control_plane@4` 与 `saki_storage_generation@2`；保留的版本 5 要求 `saki_control_plane@5`、`saki_host_execution@1` 与 `saki_storage_generation@3`；保留的版本 6 要求 `saki_control_plane@6`、`saki_host_execution@1` 与 `saki_storage_generation@4`；保留的版本 7 要求 `saki_control_plane@7`、`saki_host_execution@2` 与 `saki_storage_generation@5`；当前版本 8 要求 `saki_control_plane@8`、`saki_host_execution@3` 与 `saki_storage_generation@6`。`createdByBuildId` 与 Recovery Backup `sourceBuildId` 只记录来源。Manifest 与 backup reader 会先通过自己的 capability 解析 `stateVersion`，绝不要求 build-id 相等。

B03 源校验器保留历史模型，不会把每条 v3 关系全局施加到旧状态。它要求 control singleton 与其选中的 Installation Foundation 一致，并执行持久 Access aggregate 与 Project Registry/Intent 的跨记录 invariant。首次引导尚未完成时，缺少 bootstrap-completion summary 仍是有效状态。如果已消费 evidence 表明引导已经完成但 summary 缺失，则必须恰好有一对一致的初始 challenge 与 Browser Session 可供确定性重建。Registration Intent Actor 只能指向初始或当前历史 generation。Bootstrap Challenge 与 Browser Session generation id 属于归因；符合 schema 的终态 entry 可以指向其他历史 generation。无关历史 Foundation row 只需满足精确 B03 schema 与从选中 owner 可达的 reference。

确定性 v2→v3 步骤会替换历史 generation 字段词汇、保留稳定 Installation 与实体 identity、重新计算 registration payload digest，并且只根据相互匹配的已消费 initial-bootstrap challenge 与 Browser Session evidence 重建不可变 bootstrap-completion summary。相邻 v3→v4 步骤保留这些记录、增加空 GitHub 同步表，并推进该 generation 的 Host Operator Grant revision。相邻 v4→v5 步骤会安装结构化 Git action 集合、为每个 Resource Binding 初始化一条 available Binding Write Admission、增加空 Git-operation Intent 与 Host Operation table，并推进 storage-generation seal。相邻 v5→v6 步骤会安装 Work Item action 集合、初始化 Board `latestNonTerminalStatus`、增加空 Work Item Intent 与 recovery table，并依据[可恢复 GitHub Work Item 决策](2026-08-16-saki-recoverable-github-work-item-mutations.zh.md)推进 storage-generation seal。相邻 v6→v7 步骤会增加手动 Agent 记录、默认 Agent Profile reference 与 Give-to-Agent Grant action；Host v1→v2 会增加 `StartAgentRun`。相邻 v7→v8 步骤会增加持久 Intervention Request 及其回答 Dispatch 关系图；Host v2→v3 会增加带归因的 intervention-answer input source。一次升级会从任一保留 v2 到 v7 源走完完整相邻 chain；candidate 获得独立物理 storage-generation identity 与当前 seal。

### 权威与排他

发布后，规范且有界的 `installation.json` 是唯一 selector。它的精确 `generation.json` reference 与选中 generation 元数据必须在 Installation id、storage-generation id 和状态版本上保持一致。没有 manifest 时，状态源选择只识别准确配置的 B03 数据库；两者都不存在即为全新状态。它绝不扫描 generation 名称、journal、backup 时间戳或修改时间。无法解释的未选残留要求恢复。

B03 Host 早于 Installation lease，因此过渡时必须由操作者手工停止并保持离线。从 B18 开始，每个对外服务生命周期与维护命令都会在独立 `installation-lock.sqlite` 数据库上取得 `BEGIN EXCLUSIVE`，并在完整 callback 与拆除期间保持 transaction。SQLite 打开前，链接或非目录 Installation root 会闭合失败。POSIX 取得 lease 时先同步最近已有目录及其父目录作为重试检查点，再逐一创建缺失后代，并在继续前同步该后代及其父目录；namespace 持久性失败会阻止进入 lease。获取过程不等待。进程死亡后，SQLite 与操作系统会释放 lease；派生 lock 数据库不携带产品权威。系统不存在 PID ownership、陈旧文件删除或基于超时的接管。

### Backup、升级与恢复

Recovery Backup 是选中 SQLite 数据库及其现存恢复产物的一份仅 owner 可访问的精确副本。POSIX 要求目录为 `0700`，文件为 `0600`。Windows 要求受保护 DACL 只含当前 owner 与 LocalSystem 的精确 Full Control 项：目录项向后代继承，每个最终文件都有自己的受保护 DACL。验证会拒绝继承所得或未受保护的最终权限，以及任何额外 trustee 或访问规则。规范元数据固定 backup、Installation、storage generation、状态版本、源 build 来源，以及 artifact role、length 与 digest。发布使用 missing-target reservation 与精确读回。验证只接受调用方具名 backup 以及调用方 capability 支持的状态版本；Recovery Backup 不是 Installation Export 或 Host 转移声明。

每项改变状态的维护流程都会先持久发布固定 pending intent，再发布由 identity 选中的规范 operation journal，最后在产物副作用前发布固定 active selector。精确回读后，pending 记录会变成规范 cleared marker。在产物副作用前，升级 journal 会固定源状态版本、storage-generation identity 与 build 来源，并固定 backup 和 candidate identity 及安全清理目标；journal 绝不选择状态。升级会校验精确 v2 到 v7 源与 Recovery Backup、迁移到独立且仅创建的 v8 candidate、通过当前声明打开 candidate、校验每个当前 domain、storage-generation seal 与 Saki 产品关系、证明源 artifact set 未改变，再原子发布 `ready` Installation manifest。全新配置会在创建当前 domain 前发布 v8 `provisioning` manifest，而且只有校验完成后才把该精确 generation 提升为 `ready`。

恢复会在对外服务前和每条离线命令前，在 Installation lease 下运行。它先只删除由 target 推导的 durable-file 临时项，再调和固定 pending intent、active selector、Installation root 中的 settled selector 与固定 settled journal。清除 active operation 使用两次同目录 rename：selector 移到 root settled selector，dynamic journal 移到 `operations/` 中的固定 journal；Windows 使用 write-through replacement，POSIX 则在每次 rename 后同步所属 parent。提交前，恢复要求保留的 v2 到 v7 权威匹配 journal 源 identity，并在删除 journal 拥有的 backup 与 candidate 产物前要求已完成 backup 精确重复该 identity。无 manifest 的 v2 权威会从唯一受支持 B03 源 identity 得到 build 来源，而不是从正在校验的 journal 得到。提交后，恢复要求选中的 journal 目标状态版本 candidate 及其已验证 backup，再次将 backup 与 journal 源 identity 比对，最后才能清除 operation 元数据。当前 v8 build 只接受目标为当前 v8 或紧邻上一可写 v7 的 active journal；v7 目标必须匹配 generation metadata 与 storage seal，通过 frozen v7 domain 以及 Agent/Host 跨 domain 链接校验，upgrade 目标还必须严格新于 journal 源。已提交权威会完成收口；未提交 candidate 会按同一 backup 规则回滚。可读 v2 到 v6 状态仍只能作为 upgrade source，绝不能成为 active journal 目标。无效或含糊权威会进入 `recovery-required`；系统不会猜测 fallback generation。

### 操作者接口

离线可执行程序暴露 `backup`、`verify <backup-id>` 与 `upgrade`；PowerShell 7 包装脚本透传参数与退出状态。所有命令都取得与 Host 相同的不等待 lease、先恢复中断 operation、观察取消，并输出一项不含路径的 JSON value，同时区分成功、operation failure 与用法错误退出码。当前 Host 绝不为有效 v2 到 v7 源提供服务：启动会报告 `upgrade-required`，操作者停止 Host 后运行离线升级。

## 验证

控制面测试固定精确 B03 schema 准入、较窄的历史关系规则、到 v8 为止的每个相邻迁移、bootstrap-completion 重建、历史及当前 seal 校验，以及与 build 无关的状态 capability。真实 v2 到 v7 SQLite generation 固定每种完整升级入口，并证明选中的源数据库与 sidecar 保持不变；v7 fixture 包含非空 Agent Run 与 Host-operation 关系图。

维护测试覆盖只按 manifest 选择、全新配置、lease 排他、精确 Recovery Backup 创建与验证、candidate 校验、operation 重试、每个 pending/active/settled 发布边界，以及在 journal、backup、partial 目录创建、candidate 物化、generation 元数据发布、最终 candidate 发布、校验和 Installation manifest milestone 后注入中断。发布前恢复只接受 journal 绑定的保留 v2 到 v7 权威；发布后恢复只接受选中的 journal 目标版本 candidate 及精确重复 journal 绑定源 identity 的 backup。跨 build 测试会恢复由紧邻的上一可写版本创建的 fresh 与 upgrade operation。CLI 与构建入口测试固定严格参数、不含路径的输出、退出码、creator 来源、重复启动，以及 signal 驱动关闭后的 lease 释放。该包没有增加模型可见输入或输出，因此不改变 snapshot。

## 考虑过的方案

**用 build id 作为兼容性门禁。** Build id 标识 producer，并帮助选择回滚软件，但不定义可读状态集合。版本 capability 明确、可测试，而且允许一个 build 读取比自身写入更多的版本。

**选择最新且看似合理的 generation 或 journal。** 目录发现会把清理残留与 wall-clock 顺序变成权威。单一精确 manifest 让每个进程得到相同答案；journal 只保留为有界恢复 evidence。

**原地迁移 B03 数据库。** 原地 transaction 无法在写入当前 schema 后保留精确且旧 build 可读的源，也无法防御只在当前 reopen 后才发现的产品 invariant。独立 candidate 让发布保持为一次显式 commit。

**使用带陈旧 owner 接管的 PID 或 lock 文件。** Liveness 检查与超时无法证明另一个 writer 已经停止；删除看似陈旧的文件可能产生分裂 ownership。SQLite transaction 随进程生命周期释放，不允许手工接管 heuristic。

**在普通 Host 启动期间迁移。** 在线迁移会混合 serving handle、产品写入与权威发布。启动可以配置全新 v8 或为选中 v8 提供服务，但保留的 v2 到 v7 状态要求明确离线命令和已验证回滚产物。

**把可移植 export 与替换 restore 纳入同一维护功能面。** 这些 operation 会引入加密 archive 格式、credential 与 Session 纳入 policy、新 Host 权威、rebind，以及未解决 operation 对账。它们继续留在[有效 portability 提案](../../proposed/architecture/2026-08-18-saki-forward-migrations-and-installation-maintenance.zh.md)中，而不扩大首个状态安全增量。

## 后果

Host 启动与操作者命令对 Saki writer 与恢复都有唯一确定答案。升级会为源、Recovery Backup 与 candidate 消耗额外磁盘，并要求短暂离线。畸形 selector、选中 generation、backup、源或 operation 记录会闭合失败，而且可能要求操作者恢复，系统不会自动发现替代项。

只有精确保留 v2 到 v7 可以前进到当前 v8。该包不提供反向迁移、降级、任意历史介质修复、backup restore 命令、加密 Installation Export、替换 Host restore、retention 编排或维护 Web UI。Recovery Backup 保留精确回滚 evidence，但必须由另一项 operation 明确安装它和具备适当状态 capability 的 build，它才能成为权威。

Installation lease 只协调使用同一 Installation 根目录的进程。复制根目录或在另一台 Host 上启动历史副本不在其排他保证内，仍需运维单 writer 规则或未来分布式协调。
