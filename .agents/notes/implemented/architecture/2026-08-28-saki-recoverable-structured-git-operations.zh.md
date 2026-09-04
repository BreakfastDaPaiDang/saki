# Agent Note: 可恢复的结构化 Git 操作

Status: implemented

[English](2026-08-28-saki-recoverable-structured-git-operations.md) | 中文

## 问题

Changes 界面需要检查已绑定仓库、显示有界 Diff，并应用显式 stage、unstage 与 Commit 请求，同时不能让浏览器提供的路径成为权威。一个 status row 只在一次完整仓库 observation 中有意义，而且每项 mutation 都必须在 Resource Binding、HEAD、index、worktree 或继承变更 baseline 自该 observation 后发生变化时拒绝。

System Git 副作用不能在控制面 storage transaction 内运行。进程可能在 Git 已改变 index 或 ref、但 Saki 尚未记录成功时丢失，因此 acknowledgement 超时不能被视为副作用未发生的证据。控制面与 Local Host 需要彼此独立的持久 evidence、单一写入 owner，以及针对无法证明结果的副作用的 fail-closed 结果。

## 决策

### 展示安全的 observation 与 Diff

受保护的 `project-changes` 查询会在 Resource Binding 的所属 Host 上解析当前 active Binding，并发布一份完整且适合浏览器的 `ProjectGitStatusObservation`。该 observation 包含精确 Binding revision、HEAD、branch、upstream、index-tree evidence、worktree fingerprint、结构化 change row、仓库级 mutation eligibility 与 status fingerprint。每项 change 都携带有界的 repository-relative 展示路径，以及 observation-scoped opaque id 与 fingerprint。Mutation Intent 内的文件选择只携带 id 与 fingerprint；规范 Host 路径保持私有。

父仓库 status 命令与非 gitlink Diff 命令都会忽略所有 submodule。Host 只根据限定作用域的原始 inventory 重建已接受的 gitlink status row；其嵌套 reader 只在准入稳定的嵌套管理状态后暴露 HEAD，而 gitlink Diff 会在任何 Diff 命令执行前变为不可用。公共 row 只把父仓库已经证明的 gitlink commit 关系表达为 `changed`、`unchanged` 或 `unknown`，绝不声称未观察到的嵌套 tracked 或 untracked 脏状态。若嵌套准入失败，稳定的目录身份可以在 worktree evidence 保持 unavailable 时证明 status mode 为 `160000`；Service Provider 私有的身份 evidence 不会跨越 Host API，而已变更 gitlink 的 current mode 未经证明时会拒绝完整 status。在 repository-aware Git 读取复制的 index 前，Host 会在两次 filesystem version 确认之间捕获 source index 的原生修改时间，把私有副本的访问与修改时间设为该时间前一秒向下取整到整秒并钳制在 Unix epoch 的结果，然后确认实际修改时间不晚于 source。这样可保留 Git 针对快速等长 worktree 重写的 racy-clean 内容检查；不稳定或无法确认的时间戳 evidence 会拒绝该 observation。Sparse 配置从已准入的 config snapshot 推导，assume-unchanged 与 skip-worktree flag 则从每轮的私有 index 读取并在两轮观察间比较；status 与 Diff 不会在稳定检查后为了这些事实重新发现 live repository。精确的 assume-unchanged 普通路径可以用同轮原始 inventory 重建被 Git 省略的 status row，但仍会作为显式 mutation blocker。可见的 skip-worktree 变更也会拒绝完整状态，而不会把已捕获的 current evidence 改称 unavailable；其他不受支持的 index flag 会继续作为显式 mutation blocker。因此 Git 的递归 submodule 机制无法为 status 或 Diff 打开嵌套或逃逸的控制数据。

`project-diff` 查询接受精确 status fingerprint、opaque change id、layer 与可选 cursor。Host 针对新的稳定仓库视图解析该 tuple，并返回一个有界页面，其中 patch fingerprint 与 cursor 会把每页绑定到一份完整 patch。陈旧 observation、缺失或含糊 row、不支持的 binary 或 untracked 内容、格式错误的输出，以及配置的 byte、line 或 time limit 都会返回封闭安全失败，而不是局部 authority。

### 直接 Control Intent Host Operation

`StageFiles`、`UnstageFiles` 与 `CreateCommit` 是持久 Control Intent。其不可变 payload 会固定已认证 Actor、Grant evidence、预期 Registry 与 Project revision、Resource Binding revision、status fingerprint、HEAD、精确 index tree、worktree fingerprint、完整 pre-effect baseline，以及带 fingerprint 的已选 change id 或 Commit message。Host 不接收调用者选择的路径。

控制面会为每个 Resource Binding 维护一条 Binding Write Admission 记录。它要么是 `available`，要么是处于 `reserved` 或 `accepted` phase 的 `manual-host-operation` reservation。该 reservation 标识直接 `{ kind: 'control-intent' }` source、action、Binding revision 与最终 Host preparation，因此只有一个结构化 writer 可以越过该 Binding 的写入 boundary。启动校验会把 Host request 的完整私有 Binding authority 与 Registry 派生 snapshot 比较，而不只比较 id 与 revision。未知 admission variant 会 fail closed。

Project 登记的 Registry compare-and-set 可能先于登记 Intent 推进或创建对应 Binding Write Admission 而提交。此时 Registry 已经暴露 Project，而登记仍可恢复，因此并发提交的 Git Intent 可能持久停在 `prepared`。纯启动校验只会针对这一精确 phase、且 Binding 已被登记恢复流程识别时暂时容许 admission 缺失；后续 Git phase 仍必须提供对应 admission evidence。Project 恢复会先创建 `available` row，再恢复 Git。若其新鲜 observation 推进了 Binding revision，保留的 Git Intent 会到达 Host 边界，但以 `source-canceled` 和已证明的 `effect: none` 收口、清除未被接受的 admission fencing 并释放该 row，而不会使用陈旧 authority 执行操作。

控制面持久化 Intent、预留 Binding Write Admission、调用 `prepareOperation`、通过 compare-and-set 接受该精确 preparation，并在 storage callback 外调用 `startOperation`。Host 公开 `prepareOperation`、`startOperation`、`inspectOperation`、`cancelOperation` 与 post-commit change notification。精确 request replay 会返回同一 Host Operation；相同 source 携带不同不可变 input 会 conflict。`busy` 与 `unavailable` start result 会让已接受 operation 保持可恢复，而 cancellation 与已证明无副作用的失败会保留显式 evidence。完整持久关系图通过校验后，启动恢复会先处理当前 manual owner，再按 `createdAt` 与 id 处理其余 Intent，并且只执行一遍有界扫描。每个带 preparation 的终态 Intent 都会重新检查对应的精确 Host Operation，以重试清理，并要求返回的 snapshot 与持久 snapshot 完全相同。终态恢复只在 admission 仍指向精确 Intent source 与 payload 时释放它；`reconciliation-required` 会保留 admission，后续合法 owner 的 reservation 也保持权威。类型化浏览器 receipt 只携带符合当前 phase 的持久 Intent、Host Operation 与终态 result evidence，绝不包含 `postObservation`。`onChanged` 只负责使 Changes 失效；其 Consumer 必须在终态完成或 replay 后重新执行受保护 query，取得新的权威 status。

Host Operation 当前只接受直接 `control-intent` source。[带 fencing 的 dispatch 提案](../../proposed/architecture/2026-08-18-saki-fenced-idempotent-dispatch-admission.zh.md)定义 `execution-dispatch` 与 `agent-run` source，以及 Dispatch Claim、fencing-token acceptance、Execution Lease 与 Agent Run allocation。这些 source 会复用 `prepareOperation` 与 Host Operation 生命周期，而不是引入第二套 preparation API。

### Index 与 ref 发布

准入完成后、规划 effect 前，Host 会重新打开精确 active Binding，并验证每项固定 precondition。Stage 与 unstage 会在该 observation 内解析已选 id，并构造完整 target index。每项 mutation 都会在任何真实 `index.lock` 出现前，于已绑定 index 同目录创建一个完整、随机且由 operation 拥有的 pin：stage 或 unstage pin 包含 target index 字节，Commit pin 包含该 operation 的精确 lock marker。持久 `not-started` plan 会记录 pin 的路径、摘要、字节长度、device 与 inode 身份以及 mode。在 POSIX 上，现有 index 的 pin 会保留并验证该 index 的权限位；对于现有 Windows index，Host 会在写入字节前把 index DACL 安装到仍为空的 pin。缺失 index 的 pin 会保留实际由 Git 风格 umask 派生的 mode。

该 plan 持久化前，Host 会同步每个私有文件与 pin，在 POSIX 上依次从下向上同步 `objects/info`、当前存在的每个 loose-object fanout、`objects`、payload、scratch 外壳与操作系统临时父目录，然后重新验证 scratch 身份。私有 object manifest 的命名受严格验证，其数量上界由稳定 inventory 的路径总字节加上 operation 可能新增的 blob、root tree 与 Commit object 推导；它会记录本次新生成的私有 loose object，而 Commit plan 会另行保留其精确 candidate commit 与 root tree。每次 attempt 都会验证完整 pin evidence、从 pin 创建一条不替换现有文件的 hard link 作为 `index.lock`、证明两个名称仍指向已记录文件，并在取得 lock 后重新读取完整 expected index evidence。Stage 只同步所选 worktree hash 返回的精确 source object id；Commit 会同步其精确 candidate、root，以及私有 manifest 中当前在 source 内为 loose 的每个 object。Source 中已存在的 nested subtree 继续属于此前的 repository authority。已有 packed object 不需要 loose-directory barrier，而 barrier 期间消失的 loose object 或 fanout 会让 attempt 保持可重试。Stage 与 unstage 在 POSIX 上通过同目录 rename 发布现有 index，在 Windows 上通过 `ReplaceFileW` 发布现有 index，而缺失 index 则通过从自有 lock 创建一条 create-only hard link 来发布；每条路径都在记录成功前同步 index 目录。Publication 会经过 `not-started`、`attempting` 与 `applied-recorded`；inspection 会区分 target index、未变的 expected index 与相互矛盾的 evidence，而不会把半写 lock 当作 ownership。

Service Provider 会把恢复出的 index effect plan 当作不可信持久输入。它只接受非空、有界的 change 列表，其中展示路径必须是有界的 repository-relative Git path，并分别限制 UTF-8 展示路径总字节和以规范 Base64 携带的精确路径解码后总字节。原始 count 与字节预检会先于结构化解析元素或分配 Base64 解码结果而停止，因此超限 row 无法迫使系统遍历或解码后续 evidence。`update-index --index-info` 的 stdin 限额等于 inventory 路径总字节限额加上每项已选变更的一份 object-format-specific 固定记录限额，并在 Node Buffer 上限处饱和。Stage 读取符号链接时不跟随它，并对精确 target 字节进行哈希；Node 文件系统 failure 保持可重试，系统还会在 `readlink` 后、`hash-object` 前再次检查取消。

Commit 只从 worktree-local 或 repository-local configuration 读取 `user.name` 与 `user.email`，并禁用 include；它把固定的 timestamp 与 timezone 传给 `git var GIT_AUTHOR_IDENT`，再保留 Git 实际写入的 Git-canonical name 与 email，作为相同的 author 和 committer。缺失或无效的 canonical identity 会在 plan 持久化前失败。每次结构化 mutation 的 Git plumbing 调用除禁用 hook 与 signing 外，还固定 `core.fsyncMethod=fsync` 与 `core.fsync=loose-object,index,reference`。Commit 使用精确已观察 index tree，并通过 `commit-tree` 创建无签名 object。

当经过验证的 pin 持有 operation-owned `index.lock` 时，attached-HEAD attempt 会重新验证 HEAD 仍指向 plan 中固定的目标 branch，并且只通过 expected-old-object compare-and-set 发布该 ref。该次重新验证后的并发 checkout 无法把 publication 重定向到其他 branch。`update-ref` 之后，Host 会同步稳定的 target reflog 文件以及 target ref 与 reflog 的父目录链；recovery 会在记录 success 前重复该 barrier。对于 attached plan，精确的当前 target 可以在不解析超限 reflog 的情况下证明 publication。发生后续外部 ref 推进时，operation-specific transition 只有从同一份稳定 reflog 中读取且不超过固定 `reflogReadLimit` 才能证明 publication；超限或变化中的 attempted history 会以 `effect-unknown` 进入 reconciliation。Unborn HEAD 遵循相同 symbolic target 规则，并使用全零 expected object id。Detached HEAD 仍可检查，并支持 Diff、stage 与 unstage；但 CreateCommit 会在 effect 前失败，因为 Git 2.45 无法在 compare-and-set object id 的同时原子证明 `HEAD` 始终是 direct ref。历史 detached plan 只用于 recovery：`not-started` record 会以 `unsupported-state` 和已证明的 `effect: none` 终止；`attempting` 或 `applied-recorded` record 绝不重新执行 Git，并且只有在稳定的 per-worktree `logs/HEAD` 中读到精确 old-to-new operation marker、同步该文件、再同步 per-worktree `HEAD` 及其 reflog 的父目录链后，才会成功。Host 会把 target、预期与新 object id、parent、Git-canonical signature 与 reflog marker 保留为 effect evidence。Git 2.45 仍是最低支持版本。

### 产物 ownership 与 reconciliation

规划入口会把 `operationMaxIndexBytes` 快照为每份 effect plan 必需的 `indexReadLimit`，并把 `operationMaxReflogBytes` 快照为 Commit plan 的 `reflogReadLimit`。持久校验要求配置边界可安全分配 Buffer，并拒绝无法保留 plan 中 expected index、target index 或 pin 的 index limit。Plan 持久化后，resume、inspection、cancellation、blocking-lock removal 与 terminal cleanup 都使用这些固定限制，而不读取 live configuration。因此，降低 live configuration 不会使精确持久产物无法清理，提高 live configuration 也不会扩大旧 operation 的 reflog 读取预算。

每次读取 pin 都受其持久字节长度与 plan 的 `indexReadLimit` 约束。只有精确的同目录路径、长度、device 与 inode 身份、mode、摘要，以及稳定的打开文件与路径名身份都匹配时，系统才会使用或删除 pin。每项 mutation 还会直接在操作系统临时目录下创建随机 `saki-host-operation-*` 外层目录、在受支持平台设置 owner-only permission，并写入从 Host Operation id 与不可变 request fingerprint 派生的独占 owner marker。持久 plan 会记录外层目录、payload 目录与 owner 文件的创建身份，以及 marker 摘要。这些身份既授权运行时路径使用，也授权清理。每次把 scratch 派生的 hooks directory、object directory 或私有 index 交给 Node 或 Git 前，Host 都会重新验证外层目录、owner marker 与 payload，再从已验证 payload 派生子路径。Commit 会在 `attempting` 持久化后、紧邻 `update-ref` 之前重复该检查；失配会继续作为 attempted publication 进入 reconciliation，而不会退回可重试的无副作用证据。

Cleanup 会验证外壳与 marker，把外壳 rename 到由持久证据确定性派生的同父隔离路径，再把 owner marker 提升为外置 witness。只有不跟随链接的 metadata read 把 payload 识别为已记录真实目录时，系统才会进入其中。不跟随链接的 walker 会捕获每个真实子目录的身份，并在枚举后、每个子项前与删除前复验；文件、符号链接和 Windows junction 会接受第二次类型与身份检查，再只 unlink 本身而不跟随其 target。只有后续不跟随链接的 lookup 证明路径已不存在时，失败的 unlink 或目录删除才算 acknowledgement 丢失。Payload 缺失时可以继续清理外壳；若 payload 被外来对象替换或无法读取，或者出现其他未让路径消失的删除失败，系统会中止清理、best-effort 把 marker 与外壳还原到已记录路径，否则保留隔离目录与 witness，供终态 replay 使用。恢复绝不会扫描任一类产物。随机 owner-only 外壳、反复身份检查和避免调用 recursive-remove API 会缩小路径名替换竞态，但可移植 Node API 不提供跨 Windows 与 POSIX 的 handle-relative 或 `openat` 路径使用与删除。因此，能够修改该私有目录的恶意同用户进程仍可能在复验与下一次文件系统调用之间替换路径名。

Local Host 在 `saki_host_execution@1` 中存储不可变 request、生命周期 snapshot 与私有 effect plan。一旦 publication 可能已经开始，恢复就会把持久 plan evidence 与当前 index 或 ref 比较。已证明的 target 会成为 success。只有在 publication 不可能已经发生时，已证明无副作用才是 terminal。Attempted publication 后回到 expected value 属于 ABA-ambiguous outcome，而缺失或矛盾 witness 会以 `effect-unknown` 或 `evidence-conflict` 进入 `reconciliation-required`；Saki 不会自动重复该 mutation。

对于具有持久 pin plan 的 operation，Local Host 会在持久化 `succeeded`、`failed`、`canceled` 或 `reconciliation-required` 前，精确移除其 operation-owned blocking `index.lock` 或证明该 link 已不存在，同步 index 目录，并验证自有 lock 仍然不存在。已经应用的 index 同样不会在其目录 entry 同步完成前记录为 success。POSIX 目录同步错误会向上传播；Windows 不向该提供方暴露受支持的目录 `fsync`，因此 scratch、source-object、index、ref 与 reflog 目录 barrier 在该平台上是明确限制。Reflog 文件数据在所有平台上仍通过可写文件句柄同步。只有在语义终态持久化后，精确 owner、幂等的清理才会移除非阻塞 pin 与 scratch 目录；每次终态 replay 都会重试该清理。因此 acknowledgement 丢失不会暴露一条仍保留 operation-owned blocking lock 的终态记录。

本决策最初的完整产品状态为 version 6：`saki_control_plane@6`、`saki_host_execution@1` 与 `saki_storage_generation@4`。当前产品状态 version 9 通过 `saki_control_plane@9`、`saki_host_execution@4` 与 `saki_storage_generation@7` 保留其直接 Stage、Unstage 与 Commit 记录；v8-to-v9 步骤会增加独立的 Branch Delivery Push Host operation format，但不改变原始直接 operation request 或 evidence。相邻 v4-to-v5 migration 会保留历史 `saki_control_plane@4` 加 `saki_storage_generation@2` 状态、创建空 Host Operation domain、为每个 Resource Binding 初始化一条 `available` Binding Write Admission，并把新 generation seal 为 state v5。其 source reader 只消费一份封闭且冻结的精确 v4 id、limit、grammar、schema、fingerprint 与 helper 集合；冻结的 v5 declaration 只校验该迁移 output。相邻 v5-to-v6 migration 会保留结构化 Git 状态，并加入由 [GitHub Work Item 决策](2026-08-16-saki-recoverable-github-work-item-mutations.zh.md)拥有的可恢复 Work Item mutation 状态。

## 验证

Execution 测试固定展示安全的 status identity、由 raw inventory 拥有的 gitlink row、稳定存在与 current 未知的区分、私有 index 时间戳回拨与时间捕获竞态拒绝、精确的 assume-unchanged 普通 row 重建、Git comparison mode 归一化、如实的 skip-worktree 拒绝、公共 schema 闭合、嵌套边界收敛、任何 Diff 命令前的 gitlink 拒绝、有界 Diff paging、不含路径的 mutation selection 与精确 precondition rejection。持久 plan 测试证明原始 count 与总字节预检、必需且可安全分配 Buffer 的 `indexReadLimit` 与 `reflogReadLimit` 字段、retained-evidence bound，以及 live limit 降低或提高后的稳定恢复行为。真实仓库测试覆盖精确 symbolic-link staging、已选 stage 与 unstage result、确定性的 attached 与 unborn Commit creation、Git-canonical identity、detached Commit rejection，以及固定 mutation `core.fsyncMethod` 与 `core.fsync` 参数。

Migration drift 测试通过字面量 SHA-256 vector 固定 v4 canonical JSON 与 exact-byte framing，把可变的当前 digest、id、schema 与 singleton export 替换为 failure，并通过专用 frozen relationship validator 校验包含非空 seal、Foundation、Access、Project/Binding/registration Intent 与 GitHub mapping 的完整 v4 状态。既有 migration expectation 保持历史 fixture value 与迁移后 v5 output 不变。

Publication 测试覆盖初始执行与持久 resume 时的 post-lock expected-index comparison、只有 mode 发生 drift 的情况、现有 POSIX 权限位保留、缺失 index 的 Git 风格 mode、POSIX rename、写入字节前安装 Windows DACL 并调用 `ReplaceFileW`，以及发生 collision 与 acknowledgement loss 时的 create-only 缺失 index publication。Failure injection 证明 scratch plan 不会在每个 loose fanout 与自底向上的父目录 barrier 前持久化、Stage 与 Commit 会在初始执行和持久 resume 时同步各自的精确 source object、已经应用的 index 不会在其目录 barrier 前记录，且 Commit success 会等待由 recovery 重试的 reflog-file 与 ref/reflog directory barrier；并发 reflog 变化会要求在 success 前重跑 barrier。Packed-object coverage 证明 loose namespace 中缺失的精确 object 不会触发逐 object Git probe。Scratch 身份复验会保护每次私有 index、object、hook 与 post-`attempting` `update-ref` handoff。生命周期 coverage 还固定逐步复验身份且不跟随链接的 quarantine cleanup、link 与 junction containment、replay、cancellation、transient start、crash recovery、跨越并发 checkout 的固定 target ref compare-and-set、后续外部 ref 推进、有界超限 reflog 决策、Git 2.45 admission、lock ownership 与 unknown-effect reconciliation。

控制面测试固定 authorization、action-specific operation availability、提交时 selected-row validation、精确持久 Binding authority、Binding Write Admission exclusivity、持久 Intent phase、精确 replay、精确终态 reinspection、owner-sensitive cleanup、owner-first bounded recovery、登记—admission acknowledgement 缺口、陈旧 Binding 的无副作用取消，以及适合浏览器的 receipt。Installation-maintenance 测试固定 v4-to-v5 与 v5-to-v6 migration、包括 version 6 在内的保留历史 reader、当前 v9 provisioning 与 domain validation、v8-to-v9 对 Branch Delivery Push format 的独立处理、current-leaf drift 隔离，以及 crash-safe candidate publication。

这项决策部分实现更广泛的 [recoverable Control Intent](../../proposed/architecture/2026-08-18-saki-recoverable-control-intents.zh.md)、[stable Resource Binding](../../proposed/architecture/2026-08-18-saki-stable-resource-bindings.zh.md) 与 [fenced dispatch admission](../../proposed/architecture/2026-08-18-saki-fenced-idempotent-dispatch-admission.zh.md) 提案。这些 Note 保持 active，因为 rebind 与 retirement、automated dispatch、Agent Run allocation、fencing claim 与 Execution Lease 不属于直接 Git operation set。

## 考虑过的方案

**从浏览器发送路径或 Git argv。** 路径或 command line 会把 presentation data 变成 Host authority，并让 replay 依赖不可信 parsing。Opaque change id 让 Host 解析一个精确已观察 row，并把路径 policy 保留在 capability provider 内。

**在控制面 storage callback 内运行 Git。** Git 无法加入 SQLite transaction，而且让 callback 跨越 subprocess 并不会使 filesystem effect 原子化。分开的 Intent、Binding Write Admission、Host preparation 与 inspection evidence 会让不可避免的分离过程可恢复。

**在 planning 时直接修改 live index 或创建 `index.lock`。** 任一做法都可能在持久 publication evidence 存在前留下无 owner 的局部副作用或 blocking path。私有 alternate index 会生成并验证 target，而随机 pin 会让 plan 持久化前的 residue 保持非阻塞，直到持久 plan 能够授权精确 lock acquisition。

**在一个 ref transaction 中验证 symbolic HEAD 并更新其 referent。** Git 会把 symbolic ref 与 referent 判定为重复 update 并拒绝该 transaction。固定精确 target、在副作用前立即重新验证 HEAD，并只对该 target 执行 compare-and-set，可以在不提高最低 Git 版本的情况下保持 destination 确定。

**通过 no-dereference compare-and-set `HEAD` 发布 detached Commit。** 预期 object id 无法证明 `HEAD` 仍为 direct：并发 checkout 可以让它变为指向同一 object 的 symbolic ref，之后 update 会覆盖该 symbolic 状态。Git 2.45 不提供原子的 direct-ref-plus-object precondition，因此本版本保留 detached read 与 index mutation，但让 CreateCommit 不可用。

**把 lock、timeout 或崩溃后的 expected value 当作无副作用证据。** 另一个 writer 可能拥有 lock，而且一次 attempted effect 可能成功后又回到旧值。这些情况会在 publication 前保持 retryable，或在含糊 attempt 后要求 reconciliation。

**恢复现有 plan 时重新应用 live read limit。** 较低限制可能让精确保留 evidence 无法检查或清理，较高限制则会扩大旧 operation 的资源预算。把经过校验的限制随 plan 一起持久化，可以使 restart 与 configuration change 后的 recovery 保持确定。

**等待 automated dispatch 后再加入 Host Operation。** 手动 Git mutation 会跨越同一个持久 Host boundary。source-general Host Operation 生命周期提供直接路径，并为 dispatch 留下稳定 extension point，而不声称其 fencing protocol 已完整。

## 后果

浏览器会获得完整有界 Git facts 与持久 operation receipt，但不获得 filesystem authority。手动结构化 Git 写入具有单一 Resource Binding owner、精确 replay identity，以及跨越每个持久 boundary 的确定性 recovery。已知无副作用 failure 会保持 retryable 或成为 terminal，而 unknown effect 会有意停止 automation，等待操作者 reconciliation。

持久 plan 会变大，而且 configuration change 只影响之后创建的 plan。POSIX Host 需要额外执行文件与目录同步；Windows publication 依赖 DACL 支持和 `ReplaceFileW`，且无法声称具备目录 `fsync` 持久性。固定 Git 逐文件 fsync 与平台特定 publication 会增加写入成本，换来稳定的恢复预算、保留的 index 权限，以及显式 publication barrier。

该设计增加持久 control-plane 与 Host table、同文件系统 pin、scratch artifact、额外 Git observation 和更多 publication state。它要求 Git 2.45 或更高版本。若进程在 scratch identity 持久化前崩溃，或早期文件系统 failure 发生且后续精确清理也失败，可能留下仅 owner 可读且不产生仓库语义效果的外壳，其中会保留 repository index、blob 或 Commit bytes，直至人工清理。若 pin 已同步、但其 plan 尚未持久化时崩溃，也可能在已绑定 index 旁留下一个不阻塞 Git、带 operation 名称的 pin；stage 或 unstage pin 包含 index bytes，而 Commit pin 只包含精确 lock marker。恢复不会扫描未记录的 pin 或 scratch 目录。Final attached-HEAD revalidation 之后发生竞态的 checkout 不会重定向 Commit，但它可能让用户新 checkout 的 branch 保持不变、同时推进先前固定 branch；receipt 会标识实际 target。这项直接 Stage、Unstage 与 Commit 决策不拥有 Push；Push 归 [Branch Delivery](../feature/2026-08-18-saki-branch-delivery-and-milestone-release-evidence.zh.md)所有。Detached Commit、rebind、retirement、Execution Dispatch、Agent Run creation、Dispatch Claim、fencing token 与 Execution Lease 仍是独立工作。
