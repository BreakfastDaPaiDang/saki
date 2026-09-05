---
description: "准备一个可提供服务的 Saki Installation，检查其保留状态，并通过精确 Recovery Backup 执行可恢复的离线升级。"
kind: "package-reference"
---

# `@breakfastdapaidang/saki-installation-maintenance`

[English](README.md) | 中文

## 概述

准备一个可提供服务的 Saki Installation，检查其保留状态，并通过精确 Recovery Backup 执行可恢复的离线升级。

## 目录

- [使用本包](#use-this-package)
- [状态格式与权威](#state-formats-and-authority)
- [Lease、对外服务与发布](#lease-serving-and-publication)
- [Recovery Backup](#recovery-backups)
- [离线命令](#offline-commands)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

Saki 私有 Installation 维护与对外服务准备包。该包拥有 Installation 全局 writer lease、确定性状态源选择、manifest 选中的 Installation State Generation、精确 Recovery Backup、崩溃恢复，以及离线保留状态升级。通用关闭 domain 迁移仍由 [`@deepseek-ai/dsh-storage-domain`](../../storage/storage-domain/README.zh.md)拥有；Saki 控制面 schema 与产品 invariant 仍由 [`@breakfastdapaidang/saki-control-plane`](../control-plane/README.zh.md)拥有。

<a id="state-formats-and-authority"></a>
## 状态格式与权威

格式兼容性由状态 capability 决定，而不是 build id。本 build 可以读取状态版本 2 至 9，但只能创建版本 9。Generation 与 backup 元数据中的 build id 只记录来源；系统绝不根据它是否等于运行中 build 来判断可读性或可迁移性。

| 状态版本 | 必需 domain | 用途 |
| --- | --- | --- |
| 2 | 精确 B03 `saki_control_plane@2`，不含 storage-generation seal | 只读校验、Recovery Backup 与离线迁移 |
| 3 | 精确 post-B18 `saki_control_plane@3` 加 `saki_storage_generation@1` | 只读校验、Recovery Backup 与离线迁移 |
| 4 | 精确 `saki_control_plane@4` 加 `saki_storage_generation@2` | 只读校验、Recovery Backup 与离线迁移 |
| 5 | 精确 `saki_control_plane@5` 加 `saki_host_execution@1` 与 `saki_storage_generation@3` | 只读校验、Recovery Backup 与离线迁移 |
| 6 | 精确 `saki_control_plane@6` 加 `saki_host_execution@1` 与 `saki_storage_generation@4` | 只读校验、Recovery Backup 与离线迁移 |
| 7 | 精确 `saki_control_plane@7` 加 `saki_host_execution@2` 与 `saki_storage_generation@5` | 只读校验、Recovery Backup 与离线迁移 |
| 8 | 精确 `saki_control_plane@8` 加 `saki_host_execution@3` 与 `saki_storage_generation@6` | 只读校验、Recovery Backup 与离线迁移 |
| 9 | `saki_control_plane@9` 加 `saki_host_execution@4` 与必需的 `saki_storage_generation@7` seal | 全新配置、对外服务、backup 与验证 |

v2 reader 只接受精确 B03 schema 与 SQLite 物理 v1 子集。它校验选中的 Installation owner 与 Foundation reference，并执行 Access aggregate 与 Project Registry/Intent 的跨记录 invariant。首次引导尚未完成时，缺少 bootstrap-completion summary 仍是有效状态。如果已消费 evidence 表明引导已经完成但 summary 缺失，则必须恰好有一对一致的初始 challenge 与 Browser Session 可供确定性重建。登记 Actor 的 generation 归因必须指向初始或当前历史 generation，而终态 Access challenge 或 Browser Session 的归因可以指向其他符合 schema 的历史 generation。Reader 不会把 v3 的全局约束施加到无关历史 Foundation 记录上。

`installation.json` 一旦存在，就是唯一权威。它通过有界 leaf、byte length 与 SHA-256 选中一份准确 `generation.json`；选中的 generation 元数据必须重复 Installation id、storage-generation id 与状态版本。没有 Installation manifest 时，只能选择准确配置的 B03 数据库。两者都不存在时，对外服务流程会配置全新 v9 状态。三个当前产品 domain 共用该 manifest 选中的同一物理 SQLite generation。Generation 名称、backup 时间戳、operation journal 与目录新旧绝不选择状态；无法解释的残留要求进入维护恢复。

<a id="lease-serving-and-publication"></a>
## Lease、对外服务与发布

B03 Host 早于该 lease，因此在 B18 过渡前必须由操作者手工停止并保持离线。从 B18 开始，每个 Host 生命周期和离线命令都持有同一把 Installation lease。打开 lock 数据库前，该包会拒绝链接或非目录 Installation root，并持久创建每一级缺失目录。在 POSIX 上，每次取得 lease 都先把最近已有目录及其父目录同步为重试检查点，再依次同步每个新建子目录及其父目录，然后才继续。独立的 `installation-lock.sqlite` connection 以不等待方式拥有 `BEGIN EXCLUSIVE`；进程死亡后，操作系统会释放所有权。Lock 数据库绝不选择产品状态；该包不用 PID 文件、陈旧 owner 删除或超时作为所有权证据。

`withPreparedSakiServingState()` 会在恢复、状态预检、应用启动、完整 serving callback 与拆除期间一直持有 lease。全新状态会先发布 provisioning manifest，再配置并校验三个当前产品 domain，最后把同一份准确 manifest 提升为 `ready`。有效 v2 至 v8 源会返回 `upgrade-required`；对外服务流程绝不在线迁移它。

升级会先持久发布固定 pending intent、由 identity 选中的不可变 operation journal，再发布固定 active selector；journal 会在产物副作用前固定源状态版本、storage-generation identity 与 build 来源，以及 backup 和 candidate identity。无 manifest 的 v2 恢复会从固定 B03 identity 得到源 build 来源，而不会接受 journal 的自我声明。随后升级创建并验证精确 Recovery Backup、物化独立 v9 candidate、校验其当前 schema 与 Saki 产品关系、证明源 SQLite 产物未改变，最后原子发布 `ready` Installation manifest。无论 operation 是否已经提交，恢复都会先把 backup 与 journal 中的源 identity 精确比对，再清除 operation。Manifest 发布前崩溃时，选中的 v2 至 v8 保持权威；发布后崩溃时，v9 保持权威。v9 build 也会通过 frozen v8 domain、seal 与 Agent/Host 链接校验，恢复以紧邻上一可写 v8 为目标的 active journal；v2 到 v7 仍是 upgrade source，不是 active journal 目标。启动与每条维护命令都会在 lease 下调和确定性文件临时项以及 pending、active、settled operation 元数据；这些元数据只用于校验和清理具名产物，绝不用于选择权威。

<a id="recovery-backups"></a>
## Recovery Backup

Recovery Backup 是一份只允许 owner 访问、不可变的本地副本，对应一组精确 SQLite 产物。POSIX 对目录使用 `0700` mode，对每个文件使用 `0600`。Windows 会用受保护 DACL 替换继承权限，其中只包含路径当前 owner 与 LocalSystem 的精确 Full Control 项；目录项向后代继承，而每个最终文件会单独受到保护。验证会拒绝未受保护或仍为继承所得的最终 DACL、任何额外 trustee 或访问规则，以及任何权限、inventory 或字节不一致。规范 `backup.json` 记录 Installation id、storage-generation id、状态版本、源 build 来源，以及每份复制数据库、WAL、SHM 或 rollback-journal 产物的 role、suffix、length 与 SHA-256。状态版本可读性通过调用方提供的 capability 检查。

Recovery Backup 是回滚证据，不是可移植 Installation Export。该包不会根据时间新旧推断 backup，只验证调用方选定的 `backup-<uuid>` 身份。

<a id="offline-commands"></a>
## 离线命令

运行维护命令前先停止 Saki Host；活动 Host 会持有同一把不等待 lease。在仓库根目录中，PowerShell 7 包装脚本会原样传递参数和可执行程序退出码：

```powershell
./scripts/saki-maintenance.ps1 backup
./scripts/saki-maintenance.ps1 verify <backup-id>
./scripts/saki-maintenance.ps1 upgrade
```

`backup` 支持有效的已选 v2 至 v9 generation。`verify` 检查一项明确 backup id。`upgrade` 接受精确 v2 至 v8 状态，创建 backup 后发布 v9；状态已经是当前版本时会拒绝。

默认 Installation 根目录为 `$DSH_HOME/saki`。旧路径依次默认为 `SAKI_DATABASE_PATH` 与 `<installation-root>/control.sqlite`。`--installation-root` 和 `--legacy-database` 只接受绝对路径。每条命令只写一个不含路径的 JSON value：成功写入 stdout，退出码为 `0`；operation 失败写入 stderr，退出码为 `1`；用法错误写入 stderr，退出码为 `2`。已构建 checkout 可以从 package bin 调用 `saki-maintenance`，无需使用源码包装脚本。

<a id="model-experience"></a>
## 模型体验

### 离线 Installation 维护

#### 模型会看到什么

什么也看不到；`saki-maintenance` 是由操作者运行的离线可执行程序，不贡献 prompt、tool schema、Session event 或模型请求。

#### Token 影响

直接 token 为零，因为该包绝不组装或调用模型请求。

#### KV Cache 影响

相互独立；不存在模型请求或可复用请求前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

- **保留七个升级源**——迁移路径接受精确 B03 v2、post-B18 v3 或保留 v4 至 v8 并产生 v9；它不提供降级、反向迁移或通用旧介质修复。
- **只提供本地 Recovery Backup**——该包创建并验证回滚产物，但不暴露 restore 命令。加密 Installation Export、替换 Host restore 与 retention 编排不在本次维护增量内。
- **没有分布式 fencing**——SQLite lease 会排斥使用同一 Installation 根目录的进程，但不会协调被故意复制的根目录或 Host。
- **没有维护 Web UI**——backup、验证与升级通过 CLI 和 PowerShell 7 操作。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

不发布 runtime invariant companion，因为离线入口持有 Installation lease 时校验持久状态。

</details>
