# Agent Note: 可恢复的结构化 Git 操作

Status: implemented

[English](2026-08-28-saki-recoverable-structured-git-operations.md) | 中文

## 问题

Changes 界面需要检查已绑定仓库、显示有界 Diff，并应用显式 stage、unstage 与 Commit 请求，同时不能让浏览器提供的路径成为权威。一个 status row 只在一次完整仓库 observation 中有意义，而且每项 mutation 都必须在 Resource Binding、HEAD、index、worktree 或继承变更 baseline 自该 observation 后发生变化时拒绝。

System Git 副作用不能在控制面 storage transaction 内运行。进程可能在 Git 已改变 index 或 ref、但 Saki 尚未记录成功时丢失，因此 acknowledgement 超时不能被视为副作用未发生的证据。控制面与 Local Host 需要彼此独立的持久 evidence、单一写入 owner，以及针对无法证明结果的副作用的 fail-closed 结果。

## 决策

### 展示安全的 observation 与 Diff

受保护的 `project-changes` 查询会在 Resource Binding 的所属 Host 上解析当前 active Binding，并发布一份完整且适合浏览器的 `ProjectGitStatusObservation`。该 observation 包含精确 Binding revision、HEAD、branch、upstream、index-tree evidence、worktree fingerprint、结构化 change row、仓库级 mutation eligibility 与 status fingerprint。每项 change 都携带有界的 repository-relative 展示路径，以及 observation-scoped opaque id 与 fingerprint。Mutation Intent 内的文件选择只携带 id 与 fingerprint；规范 Host 路径保持私有。

父仓库 status 命令与非 gitlink Diff 命令都会忽略所有 submodule。Host 只根据限定作用域的原始 inventory 重建已接受的 gitlink status row；其嵌套 reader 只在准入稳定的嵌套管理状态后暴露 HEAD，而 gitlink Diff 会在任何 Diff 命令执行前变为不可用。公共 row 只把父仓库已经证明的 gitlink commit 关系表达为 `changed`、`unchanged` 或 `unknown`，绝不声称未观察到的嵌套 tracked 或 untracked 脏状态。若嵌套准入失败，稳定的目录身份可以在 worktree evidence 保持 unavailable 时证明 status mode 为 `160000`；Service Provider 私有的身份 evidence 不会跨越 Host API，而已变更 gitlink 的 current mode 未经证明时会拒绝完整 status。Sparse 配置从已准入的 config snapshot 推导，assume-unchanged 与 skip-worktree flag 则从每轮的私有 index 读取并在两轮观察间比较；status 与 Diff 不会在稳定检查后为了这些事实重新发现 live repository。可见的 skip-worktree 变更也会拒绝完整状态，而不会把已捕获的 current evidence 改称 unavailable；其他 index flag 会继续作为显式 mutation blocker。因此 Git 的递归 submodule 机制无法为 status 或 Diff 打开嵌套或逃逸的控制数据。

`project-diff` 查询接受精确 status fingerprint、opaque change id、layer 与可选 cursor。Host 针对新的稳定仓库视图解析该 tuple，并返回一个有界页面，其中 patch fingerprint 与 cursor 会把每页绑定到一份完整 patch。陈旧 observation、缺失或含糊 row、不支持的 binary 或 untracked 内容、格式错误的输出，以及配置的 byte、line 或 time limit 都会返回封闭安全失败，而不是局部 authority。

### 直接 Control Intent Host Operation

`StageFiles`、`UnstageFiles` 与 `CreateCommit` 是持久 Control Intent。其不可变 payload 会固定已认证 Actor、Grant evidence、预期 Registry 与 Project revision、Resource Binding revision、status fingerprint、HEAD、精确 index tree、worktree fingerprint、完整 pre-effect baseline，以及带 fingerprint 的已选 change id 或 Commit message。Host 不接收调用者选择的路径。

控制面会为每个 Resource Binding 维护一条 Binding Write Admission 记录。它要么是 `available`，要么是处于 `reserved` 或 `accepted` phase 的 `manual-host-operation` reservation。该 reservation 标识直接 `{ kind: 'control-intent' }` source、action、Binding revision 与最终 Host preparation，因此只有一个结构化 writer 可以越过该 Binding 的写入 boundary。启动校验会把 Host request 的完整私有 Binding authority 与 Registry 派生 snapshot 比较，而不只比较 id 与 revision。未知 admission variant 会 fail closed。

Project 登记的 Registry compare-and-set 可能先于登记 Intent 推进或创建对应 Binding Write Admission 而提交。此时 Registry 已经暴露 Project，而登记仍可恢复，因此并发提交的 Git Intent 可能持久停在 `prepared`。纯启动校验只会针对这一精确 phase、且 Binding 已被登记恢复流程识别时暂时容许 admission 缺失；后续 Git phase 仍必须提供对应 admission evidence。Project 恢复会先创建 `available` row，再恢复 Git。若其新鲜 observation 推进了 Binding revision，保留的 Git Intent 会到达 Host 边界，但以 `source-canceled` 和已证明的 `effect: none` 收口、清除未被接受的 admission fencing 并释放该 row，而不会使用陈旧 authority 执行操作。

控制面持久化 Intent、预留 Binding Write Admission、调用 `prepareOperation`、通过 compare-and-set 接受该精确 preparation，并在 storage callback 外调用 `startOperation`。Host 公开 `prepareOperation`、`startOperation`、`inspectOperation`、`cancelOperation` 与 post-commit change notification。精确 request replay 会返回同一 Host Operation；相同 source 携带不同不可变 input 会 conflict。`busy` 与 `unavailable` start result 会让已接受 operation 保持可恢复，而 cancellation 与已证明无副作用的失败会保留显式 evidence。终态恢复只在 admission 仍指向精确 Intent source 与 payload 时释放它；后续合法 owner 的 reservation 保持权威。

这一已实现 source 是手动 Control Intent 路径。带 fencing 的 dispatch 设计仍是 proposed：后续 execution 增量会加入 `execution-dispatch` 与 `agent-run` operation source，并同时加入 Dispatch Claim、fencing-token acceptance、Execution Lease 与 Agent Run allocation。它会复用 `prepareOperation` 与 Host Operation 生命周期，而不是引入第二套 preparation API。

### Index 与 ref 发布

准入完成后、规划 effect 前，Host 会重新打开精确 active Binding，并验证每项固定 precondition。Stage 与 unstage 会在该 observation 内解析已选 id，并构造完整 target index。每项 mutation 都会在任何真实 `index.lock` 出现前，于已绑定 index 同目录创建一个完整、随机且由 operation 拥有的 pin：stage 或 unstage pin 包含 target index 字节，Commit pin 包含该 operation 的精确 lock marker。持久 `not-started` plan 会记录 pin 的路径、摘要、字节长度、device 与 inode 身份以及 mode。每次 attempt 都会验证这套完整证据、从 pin 创建一条不替换现有文件的 hard link 作为 `index.lock`，并证明两个名称仍指向已记录文件。Stage 与 unstage 随后把 lock rename 到 index。Publication 会经过 `not-started`、`attempting` 与 `applied-recorded`；inspection 会区分 target index、未变的 expected index 与相互矛盾的 evidence，而不会把半写 lock 当作 ownership。

Commit 使用精确已观察 index tree、从 Git configuration 固定的 author 与 committer identity，并在禁用 hook 与 signing 的情况下调用 `commit-tree`。当经过验证的 pin 持有 operation-owned `index.lock` 时，attached-HEAD attempt 会重新验证 HEAD 仍指向 plan 中固定的目标 branch，并且只通过 expected-old-object compare-and-set 发布该 ref。该次重新验证后的并发 checkout 无法把 publication 重定向到其他 branch。Unborn HEAD 遵循相同 symbolic target 规则，并使用全零 expected object id。Detached HEAD 仍可检查，并支持 Diff、stage 与 unstage；但 CreateCommit 会在 effect 前失败，因为 Git 2.45 无法在 compare-and-set object id 的同时原子证明 `HEAD` 始终是 direct ref。Host 会把 target、预期与新 object id、parent、signature 与 reflog marker 保留为 effect evidence。Git 2.45 仍是最低支持版本。

### 产物 ownership 与 reconciliation

每次读取 pin 都受其持久字节长度与 `operationMaxIndexBytes` 约束。只有精确的同目录路径、长度、device 与 inode 身份、mode、摘要，以及稳定的打开文件与路径名身份都匹配时，系统才会使用或删除 pin。每项 mutation 还会直接在操作系统临时目录下创建随机 `saki-host-operation-*` 目录、在受支持平台设置 owner-only permission，并写入从 Host Operation id 与不可变 request fingerprint 派生的独占 owner marker。Cleanup 只会递归删除具有匹配 marker 的精确已记录直接子项。恢复绝不会扫描任一类产物。这些检查会阻止不匹配的 ownership 授权使用或清理，但无法提供操作系统级隔离，以抵御能够在可写目录中替换路径名的恶意同用户进程。

Local Host 在 `saki_host_execution@1` 中存储不可变 request、生命周期 snapshot 与私有 effect plan。一旦 publication 可能已经开始，恢复就会把持久 plan evidence 与当前 index 或 ref 比较。已证明的 target 会成为 success。只有在 publication 不可能已经发生时，已证明无副作用才是 terminal。Attempted publication 后回到 expected value 属于 ABA-ambiguous outcome，而缺失或矛盾 witness 会以 `effect-unknown` 或 `evidence-conflict` 进入 `reconciliation-required`；Saki 不会自动重复该 mutation。

对于具有持久 pin plan 的 operation，Local Host 会在持久化 `succeeded`、`failed`、`canceled` 或 `reconciliation-required` 前，精确移除其 operation-owned blocking `index.lock` 或证明该 link 已不存在，同步 index 目录，并验证自有 lock 仍然不存在。POSIX 目录同步错误会向上传播；Windows 不向该提供方暴露受支持的目录 `fsync`，因此这项同步是明确的平台限制。只有在语义终态持久化后，精确 owner、幂等的清理才会移除非阻塞 pin 与 scratch 目录；每次终态 replay 都会重试该清理。因此 acknowledgement 丢失不会暴露一条仍保留 operation-owned blocking lock 的终态记录。

完整产品状态为 version 5：`saki_control_plane@5`、`saki_host_execution@1` 与 `saki_storage_generation@3`。相邻 v4-to-v5 migration 会保留历史 `saki_control_plane@4` 加 `saki_storage_generation@2` 状态、创建空 Host Operation domain、为每个 Resource Binding 初始化一条 `available` Binding Write Admission，并把新 generation seal 为 state v5。历史 schema 保持冻结。

## 验证

Execution 测试固定展示安全的 status identity、由 raw inventory 拥有的 gitlink row、稳定存在与 current 未知的区分、Git comparison mode 归一化、如实的 skip-worktree 拒绝、公共 schema 闭合、嵌套边界收敛、任何 Diff 命令前的 gitlink 拒绝、有界 Diff paging、不含路径的 mutation selection、精确 precondition rejection、已选 stage 与 unstage result、确定性的 attached 与 unborn Commit creation、detached Commit rejection、跨越并发 checkout 的固定 target ref compare-and-set publication、Git 2.45 admission、原子 pinned-index lock acquisition、lock 与 scratch ownership、replay、cancellation、transient start、crash recovery 与 unknown-effect reconciliation。控制面测试固定 authorization、action-specific operation availability、提交时 selected-row validation、精确持久 Binding authority、Binding Write Admission exclusivity、持久 Intent phase、精确 replay、owner-sensitive terminal cleanup、登记—admission acknowledgement 缺口、陈旧 Binding 的无副作用取消、recovery 与适合浏览器的 receipt。Installation-maintenance 测试固定 v4-to-v5 migration、全新 v5 provisioning、当前 domain validation、保留历史读取与 crash-safe candidate publication。

这项决策部分实现更广泛的 [recoverable Control Intent](../../proposed/architecture/2026-08-18-saki-recoverable-control-intents.zh.md)、[stable Resource Binding](../../proposed/architecture/2026-08-18-saki-stable-resource-bindings.zh.md) 与 [fenced dispatch admission](../../proposed/architecture/2026-08-18-saki-fenced-idempotent-dispatch-admission.zh.md) 提案。这些 Note 保持 active，因为 rebind 与 retirement、automated dispatch、Agent Run allocation、fencing claim 与 Execution Lease 没有由这一增量实现。

## 考虑过的方案

**从浏览器发送路径或 Git argv。** 路径或 command line 会把 presentation data 变成 Host authority，并让 replay 依赖不可信 parsing。Opaque change id 让 Host 解析一个精确已观察 row，并把路径 policy 保留在 capability provider 内。

**在控制面 storage callback 内运行 Git。** Git 无法加入 SQLite transaction，而且让 callback 跨越 subprocess 并不会使 filesystem effect 原子化。分开的 Intent、Binding Write Admission、Host preparation 与 inspection evidence 会让不可避免的分离过程可恢复。

**在 planning 时直接修改 live index 或创建 `index.lock`。** 任一做法都可能在持久 publication evidence 存在前留下无 owner 的局部副作用或 blocking path。私有 alternate index 会生成并验证 target，而随机 pin 会让 plan 持久化前的 residue 保持非阻塞，直到持久 plan 能够授权精确 lock acquisition。

**在一个 ref transaction 中验证 symbolic HEAD 并更新其 referent。** Git 会把 symbolic ref 与 referent 判定为重复 update 并拒绝该 transaction。固定精确 target、在副作用前立即重新验证 HEAD，并只对该 target 执行 compare-and-set，可以在不提高最低 Git 版本的情况下保持 destination 确定。

**通过 no-dereference compare-and-set `HEAD` 发布 detached Commit。** 预期 object id 无法证明 `HEAD` 仍为 direct：并发 checkout 可以让它变为指向同一 object 的 symbolic ref，之后 update 会覆盖该 symbolic 状态。Git 2.45 不提供原子的 direct-ref-plus-object precondition，因此本版本保留 detached read 与 index mutation，但让 CreateCommit 不可用。

**把 lock、timeout 或崩溃后的 expected value 当作无副作用证据。** 另一个 writer 可能拥有 lock，而且一次 attempted effect 可能成功后又回到旧值。这些情况会在 publication 前保持 retryable，或在含糊 attempt 后要求 reconciliation。

**等待 automated dispatch 后再加入 Host Operation。** 手动 Git mutation 已经跨越同一个持久 Host boundary。source-general Host Operation 生命周期会先提供已实现直接路径，并为 dispatch 留下稳定 extension point，而不声称其 fencing protocol 已完整。

## 后果

浏览器会获得完整有界 Git facts 与持久 operation receipt，但不获得 filesystem authority。手动结构化 Git 写入具有单一 Resource Binding owner、精确 replay identity，以及跨越每个持久 boundary 的确定性 recovery。已知无副作用 failure 会保持 retryable 或成为 terminal，而 unknown effect 会有意停止 automation，等待操作者 reconciliation。

该设计增加持久 control-plane 与 Host table、同文件系统 pin、scratch artifact、额外 Git observation 和更多 publication state。它要求 Git 2.45 或更高版本。若进程在 scratch identity 持久化前崩溃，可能留下仅 owner 可读且不产生仓库语义效果的目录，其中会保留 repository index、blob 或 Commit bytes，直至人工清理。若 pin 已同步、但其 plan 尚未持久化时崩溃，也可能在已绑定 index 旁留下一个不阻塞 Git、带 operation 名称的 pin；stage 或 unstage pin 包含 index bytes，而 Commit pin 只包含精确 lock marker。恢复不会扫描未记录的 pin 或 scratch 目录。Final attached-HEAD revalidation 之后发生竞态的 checkout 不会重定向 Commit，但它可能让用户新 checkout 的 branch 保持不变、同时推进先前固定 branch；receipt 会标识实际 target。Stage、unstage 与 attached 或 unborn Commit 已实现；detached Commit、push、rebind、retirement、Execution Dispatch、Agent Run creation、Dispatch Claim、fencing token 与 Execution Lease 仍是独立工作。
