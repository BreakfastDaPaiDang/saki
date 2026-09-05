---
description: "检查本地仓库、执行结构化 Git 操作，并在同一 Host 上创建或恢复精确 Agent Run。"
kind: "package-reference"
---

# `@breakfastdapaidang/saki-execution-local`

[English](README.md) | 中文

## 概述

检查本地仓库、执行结构化 Git 操作，并在同一 Host 上创建或恢复精确 Agent Run。

## 目录

- [使用本包](#use-this-package)
- [检查行为](#inspection-behavior)
- [结构化 Git 操作](#structured-git-operations)
- [Agent Run operation](#agent-run-operations)
- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

Saki 私有 Local Host Service Provider 基于 `ctx.fs`、`ctx.subprocess`、`ctx.workspaceRegistry`、`ctx.storageDomain`、DSH Agent 与 Session 服务，以及同一 Host 的文件系统元数据实现 [`ctx.sakiHostExecution`](../execution/README.zh.md)。它检查不可信的本地目录选择与带 revision 的已绑定 Project 状态、读取有界 Diff、执行结构化 Git 修改与 exact-lease GitHub Push operation，并创建或恢复精确 Agent Run。它拥有 Service Provider 私有的持久 Host Operation 记录，但不拥有 Project 策略、Resource Binding、Workspace 创建流程或控制面 Intent。

<a id="inspection-behavior"></a>
## 检查行为

- **文件系统身份**：只使用文件系统的发现流程从所选目录向上查找普通 `.git` 目录或 gitfile，验证 linked worktree 的双向标记或本地 separate Git directory 布局，并通过 `realpath` 解析所选顶层目录、每 worktree Git directory 与 common Git directory。系统支持普通、linked、detached 与本地 separate Git directory worktree。只有所选规范目标包含在该顶层目录中时，才接受位于 Git 顶层目录之下的选择；返回的 worktree、Workspace 与展示证据都使用顶层目录。Service Provider 在两轮观察中为每个 Git 管理目录捕获不透明的同 Host 文件系统身份，在不把路径转换为小写的情况下比较路径，并拒绝缺失、非目录、bare、可清理、格式错误、逃逸或存在歧义的选择。直接 reparse locator、`.git` 标记、解析后的管理目录、对象目录或配置的 worktree 会被拒绝，而不会被规范化为别名。
- **私有 Git 控制数据**：每轮观察都会把已准入的 common config、启用的 `config.worktree`、HEAD、当前 loose 或 packed ref、index，以及 repository-local exclude 与 attribute 文件复制到私有控制目录。Repository-aware 命令运行前，系统通过显式的 `git config --file ... --no-includes` 查询审计复制的配置。这些命令只使用固定的只读 argv 集合读取私有 config、HEAD、ref 与 index，因此不会在该轮观察中重新打开它们的 source 副本。在 repository-aware Git 读取私有 index 前，Service Provider 会在两次 filesystem version 确认之间捕获 source index 的原生修改时间，把私有 index 的访问与修改时间设为该时间前一秒向下取整到整秒并钳制在 Unix epoch 的结果，然后确认实际修改时间不晚于 source。这样可保留 Git 针对快速等长 worktree 重写的 racy-clean 内容检查；任何不稳定或无法确认的时间戳都会使 observation 变为 unavailable。Sparse 配置从这些已准入的 config snapshot 推导，assume-unchanged 与 skip-worktree flag 则从私有 index 读取，并在两轮观察间比较；status 与 Diff 不会为了这些事实再从 worktree 发现一次仓库。Source object database 若已存在 object alternate 或 HTTP alternate，检查会被拒绝；私有控制目录改为生成一条仅指向已准入 live source object database 的 alternate。
- **私有 Git 目录 ownership**：隔离的 repository view 或远程恢复目录构建完成后，Service Provider 会按文件系统身份和文件字节封存其构造的精确 config、根目录、必须缺失的 `config.worktree`、`commondir` 与 `info/grafts`、对象目录祖先，以及预期精确存在或缺失的 object alternate。之后每个只读或携带凭据的 Git 进程都只会在紧邻复验通过后接收该路径；失配会在启动进程前失败。清理会复核真实目录的身份，并只 unlink symlink 或 junction 而不跟随其 target。
- **有界 Git 执行**：Service Provider 要求 Git 2.45 或更高版本。一个原始字节 runner 使用结构化 argv、明确的工作目录、必填的取消信号、进程树收敛、受控 locale、非交互式凭据设置、`--no-lazy-fetch`、`--no-replace-objects`、禁用的 commit-graph 读取、默认固定到平台空设备且仅由 operation-owned mutation hooks directory 覆盖的 hook 路径，以及固定的 pager、fsmonitor、diff、attribute 与配置设置来调用 Git。每条 mutation 命令都会固定设置 `core.fsyncMethod=fsync` 与 `core.fsync=loose-object,index,reference`，因此 Git 会对已写入的 loose object、alternate index 与 ref lockfile 执行逐文件同步；Service Provider 负责下文所述的独立 object、ref 与 reflog namespace barrier。在 inventory 命令可以查询 worktree 前，Service Provider 会拒绝 repository 或 worktree scope 中的每项 `include.path` 与 `includeIf.*.path` 指令且不跟随它，再从这些 scope 读取 `core.fsmonitor`。缺失或明确的 `false` fsmonitor 值可以接受，而程序、`true`、格式错误的值或不可读取的 scope 会在不启动所配置 monitor 的情况下拒绝检查。每条命令和整个观察轮次的 stdout、stderr 或时间达到限制时会拒绝整个操作，而不会暴露截断数据或子进程诊断。
- **精确观察**：闭合的 NUL 分帧 `ls-tree`、带 tag 的 staged `ls-files`、untracked `ls-files` 与 `check-attr --all` inventory 仅在内存中保留精确路径字节。Service Provider 比较常规文件、symlink 与 gitlink 的原始证据，并且不调用 check-in filter；它不声称这些结果等同于经过 filter 归一化的 porcelain status。已初始化 gitlink 只会通过限定作用域的嵌套仓库 reader 暴露其 HEAD，但不会暴露其中 staged、unstaged 或 untracked 成员，因此每个已准入的初始化 gitlink 都属于 conversion-ambiguous，并阻止自动修改。若嵌套仓库无法准入，只有在 gitlink 目录身份稳定后，inventory 才会保留带 gitlink mode 的 unavailable current evidence。父仓库 status 命令与非 gitlink Diff 命令会忽略所有 submodule；已接受的 gitlink status row 只来自限定作用域的原始 inventory，而 gitlink Diff 请求会在任何 Diff 命令运行前失败。未知但格式正确的 attribute 不进入持久证据，格式错误的记录会被拒绝。在 Windows 上，备用数据流 component 不是普通路径身份，不能生成具备自动变更资格的 baseline。
- **安全证据**：远程观察移除 userinfo、query 与 fragment 信息。指向公共 GitHub repository 的已净化 HTTPS 与 SSH remote 会生成小写、排序并去重的候选列表，但候选项不会因此成为 binding 或权限结果。指纹只保留允许列出的 Git 事实和带版本的摘要。查询可以报告已登记的 DSH Workspace id，但检查不会创建或变更该 Workspace。
- **继承变更 baseline**：发生变化的路径按顺序表示为精确 NUL 分帧路径摘要，以及允许列出的 index、冲突、submodule、symlink、缺失与有界原始内容证据。干净 worktree 返回完整的零条目 baseline。仓库 inventory 不完整时会拒绝整次检查；精确确定变更成员后，路径局部捕获或保留失败以及独立 baseline 限制会返回不可用 baseline 分支，其中没有部分条目或伪造的完整摘要。
- **已绑定 Project 状态**：`inspectProject` 只把保留的规范 worktree 路径当作 locator，重复执行稳定的两轮检查，并要求新的 Host、Workspace、worktree、Git directory 与文件系统身份匹配带 revision 的 Resource Binding。登记流程与状态投影共用同一套 inventory 比较语义；状态按有效 UTF-8 路径排序，区分 tracked、untracked、conflicted、staged、unstaged 与继承变更归因，并携带完整 index、worktree 与状态摘要。公共 gitlink row 只把父仓库已经证明的 commit 关系表达为 `changed`、`unchanged` 或 `unknown`，不会声称嵌套仓库的 tracked 或 untracked 脏状态。若已变更 gitlink 的嵌套 current state 无法准入，则只会在证明目录 mode 后携带 unavailable current evidence，并阻止结构化修改；已变更 gitlink 的 current mode 完全未知时会拒绝该状态。精确的 assume-unchanged 普通路径可以用同轮原始 inventory 重建被 Git 省略的 status row，但该 flag 仍会阻止修改。可见的 skip-worktree 变更会拒绝完整状态，而不会把已捕获的 current evidence 改称 unavailable；其他不受支持的 index flag 会让状态保持可读，同时阻止修改。Conversion 歧义、无法解析的 status membership、路径文本无效或达到协议限制时会拒绝完整状态，而不会伪造布尔变更事实或返回部分列表。
- **精确 Commit 检查**：`inspectProjectCommit` 会重新验证 active Resource Binding，并只接受一个精确 object id，不接受 ref 或 revision expression。它通过私有 repository view 确认该 object 是 Commit 并返回同一个 id；身份陈旧、object 缺失和 Host evidence 不可用仍是不同的封闭结果。

<a id="structured-git-operations"></a>
## 结构化 Git 操作

- **持久生命周期**：`prepareOperation` 使用 source Intent 身份持久记录一个尚未产生效果的请求；完全相同的重放返回同一 operation，来自该 source 的不同请求会被拒绝。`startOperation` 获取新的准入结果，并在规划效果前重新完成 binding、status、HEAD、index、worktree、baseline 与修改可用性检查。每份 effect plan 都会把已解析的 `operationMaxIndexBytes` 固定为 `indexReadLimit`，Commit plan 还会把 `operationMaxReflogBytes` 固定为 `reflogReadLimit`；即使之后的 Service Provider 配置发生变化，恢复执行、恢复判断与清理仍会使用适用的持久值。持久 index plan 只接受非空、有界的 repository-relative 路径列表。原始校验会在结构化解析元素或分配 Base64 解码结果前拒绝超出 row 数量、UTF-8 路径总字节或规范 Base64 解码后总字节的输入；规范 Base64 与 repository-relative 路径校验先于每次解码和 Git 使用。占用中的锁和暂时不可用的证据让 operation 保持可重试。`inspectOperation` 只能依据只读 Git 与文件系统证据推进 publishing 生命周期，且不会创建新的 Git 效果。
- **Stage 与 unstage**：所选 change id 与 fingerprint 只能在新的 inventory 中解析成精确路径字节。私有 object database 与 alternate index 使用固定的 `update-index --index-info` 记录应用修改并验证结果 tree；该命令的 stdin 限额等于 inventory 路径总字节限额加上每项已选变更的一份 object-format-specific 固定记录限额，并在 Node Buffer 上限处饱和。所需 blob 只在无效果 plan 持久化后才会在 source object database 中重建。每次 Stage attempt 只保留所选 worktree hash 返回的精确 object id，先同步这些 id 当前存在的 loose fanout 目录，再同步 source object root；若某一精确 id 不在 loose namespace 中，则把它视为已经 packed。Stage 通过不跟随链接的 `readlink` 读取符号链接，对其精确 target 字节进行哈希，把 Node 文件系统 failure 映射为可重试的 unavailable，并在读取后、Git 哈希这些字节前再次检查调用方取消。完整 target index 会写入已绑定 index 同目录的随机 operation-owned pin。在任何真实 `index.lock` 出现前，持久 `not-started` plan 会记录该 pin 的精确路径、摘要、字节长度、device 与 inode 身份、mode 以及固定的 `indexReadLimit`。每次 attempt 都会从该 pin 创建一条不替换现有文件的 hard link 作为 `index.lock`，证明两个名称仍指向已记录的完整文件，并在取得锁后重新读取已绑定 index；存在性、内容或已记录 mode 的任何变化都会在 publication 前失败。对于现有 index，POSIX 会把 pin 设为已观察 mode，再把 lock rename 到 index；Windows 则会在写入前把原 index 的 DACL 复制到空 pin，并通过 `ReplaceFileW` 发布。对于预期缺失的 index，所有平台都会把 `index.lock` 以不替换的 hard link 发布到仍然缺失的路径，因此会保留并发创建者。Stage 在关闭 filter 的情况下对常规 worktree 字节进行哈希；unstage 恢复精确的 HEAD mode 与 object，或在 unborn 路径上移除 index entry。未选择路径参与的 directory/file 冲突、unmerged 路径、已初始化 gitlink、sparse 布局、assume-unchanged、skip-worktree 与不受支持的 index 形式都会在效果前失败。
- **Commit**：Commit 要求 attached 或 unborn HEAD、至少一项 staged ordinary change，以及 repository-local 或 worktree-local config 中有效的 `user.name` 与 `user.email`。Git 会在同一份固定 timestamp 与 timezone 下，通过 `git var GIT_AUTHOR_IDENT` 规范化这些值；plan、result 与 `commit-tree` 环境对 author 和 committer 使用同一份精确 identity。Commit 会在私有 object directory 中构建精确 tree 与 object，并创建同类的随机同目录 pin，其中包含该 operation 的精确 index-lock marker。一份根据稳定 inventory 路径字节推导上界的严格 manifest 会记录每个本次新生成的私有 loose object，而 plan 会另行保留精确 candidate commit 与 root tree；source 中已存在的 nested subtree 继续属于此前的 repository authority。每次 attempt 都会在 source object database 中重建同一 candidate，再于 publication 前同步 candidate commit、root tree 与 manifest 内当前为 loose 的每个 object；loose namespace 中缺失的精确 id 会被视为已经 packed。持久 `not-started` plan 会先记录完整 pin evidence，再由 attempt 把 pin 以不替换现有文件的方式 hard-link 到 `index.lock`，随后在关闭 hook、filter、签名、editor、pager、prompt、replacement object 与 lazy fetch 的情况下重建这些 object，并对固定 branch ref 执行 compare-and-set。`update-ref` 之后，Service Provider 会同步稳定的 target reflog 文件以及 target ref 与 reflog 的父目录链；recovery 会在记录 success 前重复该 barrier。当前 target 可以在不读取超限 reflog 的情况下证明 publication；发生后续外部 ref 推进时，精确 transition 只有在同一份稳定 reflog 不超过固定 `reflogReadLimit` 时才能证明 publication，否则 attempted publication 会以 `effect-unknown` 进入 reconciliation。`attempting` 持久化后、紧邻 `update-ref` 之前，Service Provider 会重新验证 scratch authority；失配会继续作为 attempted publication 进入 reconciliation，而不会退回可重试的无副作用证据。并发 checkout 无法把 publication 重定向到新 branch。Detached HEAD 仍支持 inspection、Diff、stage 与 unstage，但 Commit 会在 effect 前失败，因为 Git 2.45 无法在 compare-and-set object id 的同时原子证明 `HEAD` 始终是 direct ref。
- **Push**：只有配置选择了某一封闭 Git Credential Manager 适配器时，Push 才可用。Service Provider 从 `nameWithOwner` 派生精确 HTTPS GitHub URL，禁用 redirect 和除 HTTPS 外的所有 protocol，使用非交互 credential 设置，并且绝不接受 caller helper command 或 credential。Planning 会证明精确 local Commit，观察精确 target branch，并只接受 absent branch 或已证明为 ancestor 的 remote Commit；ancestry 的两个端点都使用精确 `<object-id>^{commit}` expression，使同名历史 ref 无法重定向证明。Publication 紧前会重读该 state，持久化 `attempting`，再调用一次以 `<commit-id>^{commit}` 为 source 的精确 `--force-with-lease=<ref>:<expected>` Push，避免发布时发生同类 ref shadowing。`attempting` 之前，持久 `not-started` marker 能证明 transport 尚未运行，因此取消既不需要 local 或 remote evidence，也不需要仍有 helper 配置。Binding 永久陈旧或精确 Commit 缺失时，start 或 inspection 会把 operation 终结为无副作用 failure；临时 inspection failure 则保持可重试。若已记录 helper 被取消配置或改为另一适配器，终态 replay 仍可读取；未终态 Push 保持 inert，而取消仍可在不调用旧 helper 的前提下关闭 `not-started`。`attempting` 后的 recovery 只检查 remote：目标 Commit 表示成功，未变的 premise 以 `effect-unknown` 要求 reconciliation，其他 Commit 则以 `evidence-conflict` 要求 reconciliation。
- **恢复证据**：成功的 index 结果由精确的已发布 index 摘要支撑。成功的 Commit 结果由冻结的目标 ref，或通过 publication barrier 的同一份稳定且有界的 reflog 内 operation 专属 transition 支撑。持久 `not-started` index 或 Commit plan 只有在其 pin 与任何 live operation-owned lock 都保留已记录的同一文件证据时才能取消或恢复。一旦某次尝试可能已经到达 Git，缺失、超限或冲突的证据会进入 `reconciliation-required`，而不会重试不确定的效果。
- **产物 ownership**：每次读取 pin 都同时受其持久字节长度与 plan 中固定的 `indexReadLimit` 约束；只有同目录路径、精确长度、device 与 inode 身份、mode、摘要，以及稳定的打开文件与路径名身份都匹配记录时，系统才会使用或删除该文件。Scratch plan 会记录随机外层目录、内层 payload 目录和独占 owner marker 的创建身份，以及 marker 摘要。这些身份既授权运行时使用，也授权清理：每次把 scratch 派生的 hooks directory、object directory 或私有 index 交给 Node 或 Git 前，Service Provider 都会重新验证外层目录、owner marker 与 payload，再从已验证 payload 派生子路径。Service Provider 创建的 scratch 文件会在写入时执行 fsync；`not-started` 持久化前，POSIX 会按 `objects/info`、当前存在的每个 loose-object fanout、object directory、payload、外层目录和操作系统临时目录的顺序自底向上同步目录，随后所有平台都会重新验证 scratch ownership。失配或必需的同步失败会让 operation 保持可重试，而且不会把任何 scratch 派生路径交给该边界。
- **清理与终态持久化**：终态清理会在已记录临时路径验证 scratch 证据，把外层目录 rename 到由持久证据确定性派生的同父隔离路径，将 owner marker 移出 payload，并重新验证外层与 payload 身份。系统不会请求递归删除：进入真实目录和对其执行 `rmdir` 前会复核身份；文件、symlink 与 junction 则经 `lstat` 复核并仅 unlink link 本身，不会跟随 link target。随后系统会非递归删除空外壳与外置 marker；部分删除或 acknowledgement 丢失仍会留下足够的确定性所有权证据供终态 replay 使用，而外来 replacement 会被保留，恢复到已记录路径仅作 best-effort 尝试。对于具有持久 pin plan 的 operation，Local Host 会在持久化 `succeeded`、`failed`、`canceled` 或 `reconciliation-required` 前，精确移除其 operation-owned blocking `index.lock` 或证明该 link 已不存在，同步 index 目录并再次检查。POSIX 会传播 scratch、source-object、index、ref 与 reflog barrier 的目录同步错误。Windows 不向该 Service Provider 暴露受支持的目录 `fsync`，因此其持久性保证覆盖已刷写文件、Git 配置的文件同步和平台原子发布，但不覆盖崩溃时的目录项。Acknowledgement 丢失不会让外部看到一条仍保留自有 blocking lock 的终态记录。非阻塞 pin 与 scratch 目录只在终态持久化后按精确 owner 幂等清理，每次终态 replay 都会重试。若进程在 plan 持久化前崩溃或遇到文件系统 failure，且精确清理无法完成，可能留下随机非阻塞 pin 或仅 owner 可访问的 scratch 外壳；恢复绝不会扫描这类未记录 residue。

应用 bootstrap 环境是 Git 可执行文件与普通继承进程变量的权威来源。Service Provider 会移除仓库或浏览器可控制的 Git 执行变量，但不会把已受损的父进程环境当作需要隔离的子进程沙箱。文件系统元数据取消遵循 FileSystem provider 在探测前后协作检查的约定；常规文件内容流会由取消信号销毁，Service Provider dispose 会等待全部调用收敛。

<a id="agent-run-operations"></a>
## Agent Run operation

`start-agent-run` Host Operation 会在接触 DSH 前保存一份 schema version 4 record，其中包含 `agent-run` effect plan。它的精确 replay 会挂载已固定 Agent Preset、应用已固定 Model Route，并在 Binding 的规范 worktree cwd 创建或恢复预分配 Session。Version 3 保留为精确 cold-migration schema，version 2 则只接受原始 `saki-agent-run` source。物理 Session header 必须证明该 cwd 与 preset，live Agent option 也必须匹配 route。任何不匹配、同一 Session id 下的其他 live Agent，或冲突的 message-source evidence 都会成为 conflict，而不会产生另一个 Run。

Provider 会通过完整 snapshot 与 event-history 读取，分离读取精确输入 MessageId 的物理 Session persistence。只有完全不存在时才允许插入一次 `next-turn`。初始输入与带归因的 Intervention answer 共用这条路径；answer 使用新的 Dispatch 与 Host Operation，同时保留 Run、Work Session、Session 及其稳定 MessageId。获取 live Agent 后，Provider 会在插入输入前，以及后续唤醒 pending 输入前立即重新验证可写 Git world。插入后会 flush 并重新检查；只有该输入仍为 pending 时才使用确定性 `next-step` wake，Agent-scoped pre-step listener 会在模型组装前移除这些 wake message。已 recorded 的输入证明 Host 成功。Canceled、removed、replaced、claimed-without-record、attempt 后缺失及 conflicting evidence 会被取消或进入对账，而且不会重发输入。

Inspection 绝不创建、恢复或唤醒 Agent。`inspectInterventionOpening` 会读取分离的物理 Session history；只有一条精确 `request_intervention` call 的非 error 模型可见 result 后跟随匹配的最终 step end 与 completed turn end 时，它才返回确认，并且只返回闭合 evidence，不暴露 Session。启动 resume 是一项独立 operation，它要求精确的 succeeded Host result、匹配的物理 Session header 与输入，以及匹配且可用的 live Agent；Host 会在对外服务前恢复该 Agent，并使其保持 model-idle。因此，持久 `not-started` plan 可以在不归因无关 Session 的情况下证明取消；publishing 或终态 replay 会重新检查精确持久输入与 id。取消会在终态持久化前停止并排空所拥有的 live Agent。disposal 失败时，Host 会继续跟踪 handle，并让 operation 保持可重试。Host 成功只报告 Run 与输入已经持久存在，并不表示模型执行完成。

<a id="configuration"></a>
## 配置

数值字段都会解析为正整数。可选 credential 适配器会启用 Push，而不会把 credential authority 转入 request；其余限制约束观察与 Service Provider 私有修改证据。产品策略仍归控制面所有。

| 字段 | 默认值 | 用途 |
| --- | --- | --- |
| `pushCredentialHelper` | 未设置 | 封闭的非交互适配器：`git-credential-manager` 或 `git-credential-manager-core`；未设置时 Push 不可用 |
| `gitCommandTimeoutMs` | `10000` | 每个 Git 进程的墙钟时间限制 |
| `gitTerminationGraceMs` | `250` | 终止进程树与强制结束之间的宽限期 |
| `maxGitStdoutBytes` | `4194304` | 每个 Git 进程完整 stdout 的字节限制 |
| `maxGitStderrBytes` | `65536` | 每个 Git 进程完整 stderr 的字节限制 |
| `inventoryMaxEntries` | `100000` | 一轮完整仓库观察的路径成员数量限制 |
| `inventoryMaxPathBytes` | `16777216` | 一轮完整仓库观察的精确路径字节限制 |
| `inventoryMaxGitOutputBytes` | `16777216` | 一轮观察中共享的原始 stdout 与 stderr 字节限制 |
| `inventoryMaxFileBytes` | `67108864` | 单个 inventory 路径保留的原始证据限制 |
| `inventoryMaxTotalFileBytes` | `536870912` | 一份 inventory 的内容读取与稳定性复读总量限制 |
| `inventoryMaxCaptureMs` | `30000` | 一轮 Git、文件系统与 Workspace 观察的墙钟时间限制 |
| `baselineMaxEntries` | `10000` | 完整 baseline 的继承变更条目数量限制 |
| `baselineMaxPathBytes` | `4194304` | 完整 baseline 中精确 Git 路径字节的总量限制 |
| `baselineMaxGitOutputBytes` | `16777216` | 完整 baseline 允许保留的 Git 证据限制 |
| `baselineMaxFileBytes` | `16777216` | 单个变更路径保留的原始证据限制 |
| `baselineMaxTotalFileBytes` | `67108864` | 完整 baseline 保留的原始证据总量限制 |
| `baselineMaxCaptureMs` | `30000` | 覆盖 inventory 捕获和 baseline 构建的墙钟时间限制 |
| `operationMaxIndexBytes` | `67108864` | 固定到每项新规划 Host Operation 的 index 与 pin 读取限制 |
| `operationMaxReflogBytes` | `4194304` | 固定到每项新规划 Commit 的 reflog 读取限制 |

<a id="model-experience"></a>
## 模型体验

### Local Host 检查与 Agent 启动

#### 模型看到什么

Inspection 与结构化 Git operation 不会增加模型可见内容。`start-agent-run` 会在精确固定的纯文本初始输入或 Intervention answer 持久化后交付它；恢复 wake message 会在模型看到前被过滤。

#### Token 影响

Inspection 与结构化 Git operation 直接增加零个 token。Agent start 可能调用已固定 Model Route，因此 token 取决于原始输入与组装后的 preset context；replay 不会加入重复的原始 message，启动 resume 也不会增加 wake 或模型请求。

#### KV Cache 影响

Inspection 与模型请求相互独立。每条 Agent 输入都会在可复用 prefix 外加入一个 user turn；恢复 wake 在组装前被移除，因此没有 KV Cache 影响。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- **只支持本地执行环境**：该 Service Provider 要求所选目录、文件系统元数据、系统 Git 可执行文件、Workspace registry 和 subprocess runtime 描述同一个 Host。远程 Host 需要另一种 Service Provider。
- **封闭的结构化修改范围**：不可用的继承变更 baseline 仍是有效的选择证据，但当前比较存在歧义或不完整时，完整的已绑定状态与每项修改都会快速失败。Diff 按路径限定且有界。Stage、unstage 与 Commit 会拒绝那些无法由公共 operation 证据精确表达的仓库状态，而不会回退到 porcelain 行为。
- **实时 data plane**：Git 读取期间，已准入 worktree 与 source object database 仍是实时数据。独立观察轮次与 source-control manifest 会拒绝它们观察到的变化，但不能阻止每个瞬时同用户竞态，也不会把 Service Provider 变成操作系统 sandbox。精确 owner 产物检查同样无法隔离恶意同用户进程在可写目录中于检查之间替换路径名：可移植 Node API 不提供跨 Windows 与 POSIX 的 handle-relative 或 `openat` 路径使用与删除。
- **Reparse 范围**：Service Provider 会拒绝直接 locator alias，以及最终 Git marker、管理目录、控制文件、对象目录与配置 worktree 上的 reparse entry。当前 FileSystem capability 无法证明每个祖先 component 都在不跟随 reparse point 的情况下打开。
- **不支持的控制布局**：reftable 等非 files ref storage，以及通过 `commondir` 重定向的普通 `.git` 目录，都会使检查变为不可用。如果 split index 所需的 `sharedindex.*` 文件不在私有控制目录中，该检查也会变为不可用。已经使用 object alternate 的 source repository 会被拒绝，而不会在快照中复现该布局。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

不发布 runtime invariant companion，因为领域解析器在打开及写入前校验 Host Operation 记录；实时接纳回调不属于持久状态。

</details>
