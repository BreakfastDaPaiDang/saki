# `@breakfastdapaidang/saki-execution-local`

[English](README.md) | 中文

Saki 私有 Local Host Service Provider 基于 `ctx.fs`、`ctx.subprocess`、`ctx.workspaceRegistry`、`ctx.storageDomain` 与同一 Host 的文件系统元数据实现 [`ctx.sakiHostExecution`](../execution/README.zh.md)。它检查不可信的本地目录选择与带 revision 的已绑定 Project 状态、读取有界 Diff，并执行结构化 Git 修改。它拥有 Service Provider 私有的持久 Host Operation 记录，但不拥有 Project 策略、Resource Binding、Workspace 创建流程或控制面 Intent。

## 检查行为

- **文件系统身份**：只使用文件系统的发现流程从所选目录向上查找普通 `.git` 目录或 gitfile，验证 linked worktree 的双向标记或本地 separate Git directory 布局，并通过 `realpath` 解析所选顶层目录、每 worktree Git directory 与 common Git directory。系统支持普通、linked、detached 与本地 separate Git directory worktree。只有所选规范目标包含在该顶层目录中时，才接受位于 Git 顶层目录之下的选择；返回的 worktree、Workspace 与展示证据都使用顶层目录。Service Provider 在两轮观察中为每个 Git 管理目录捕获不透明的同 Host 文件系统身份，在不把路径转换为小写的情况下比较路径，并拒绝缺失、非目录、bare、可清理、格式错误、逃逸或存在歧义的选择。直接 reparse locator、`.git` 标记、解析后的管理目录、对象目录或配置的 worktree 会被拒绝，而不会被规范化为别名。
- **私有 Git 控制数据**：每轮观察都会把已准入的 common config、启用的 `config.worktree`、HEAD、当前 loose 或 packed ref、index，以及 repository-local exclude 与 attribute 文件复制到私有控制目录。Repository-aware 命令运行前，系统通过显式的 `git config --file ... --no-includes` 查询审计复制的配置。这些命令只使用固定的只读 argv 集合读取私有 config、HEAD、ref 与 index，因此不会在该轮观察中重新打开它们的 source 副本。Sparse 配置从这些已准入的 config snapshot 推导，assume-unchanged 与 skip-worktree flag 则从私有 index 读取，并在两轮观察间比较；status 与 Diff 不会为了这些事实再从 worktree 发现一次仓库。Source object database 若已存在 object alternate 或 HTTP alternate，检查会被拒绝；私有控制目录改为生成一条仅指向已准入 live source object database 的 alternate。
- **有界 Git 执行**：Service Provider 要求 Git 2.45 或更高版本。一个原始字节 runner 使用结构化 argv、明确的工作目录、必填的取消信号、进程树收敛、受控 locale、非交互式凭据设置、`--no-lazy-fetch`、`--no-replace-objects`，以及固定的 pager、fsmonitor、hook、diff、attribute 与配置设置来调用 Git。在 inventory 命令可以查询 worktree 前，Service Provider 会拒绝 repository 或 worktree scope 中的每项 `include.path` 与 `includeIf.*.path` 指令且不跟随它，再从这些 scope 读取 `core.fsmonitor`。缺失或明确的 `false` fsmonitor 值可以接受，而程序、`true`、格式错误的值或不可读取的 scope 会在不启动所配置 monitor 的情况下拒绝检查。每条命令和整个观察轮次的 stdout、stderr 或时间达到限制时会拒绝整个操作，而不会暴露截断数据或子进程诊断。
- **精确观察**：闭合的 NUL 分帧 `ls-tree`、带 tag 的 staged `ls-files`、untracked `ls-files` 与 `check-attr --all` inventory 仅在内存中保留精确路径字节。Service Provider 比较常规文件、symlink 与 gitlink 的原始证据，并且不调用 check-in filter；它不声称这些结果等同于经过 filter 归一化的 porcelain status。已初始化 gitlink 只会通过限定作用域的嵌套仓库 reader 暴露其 HEAD，但不会暴露其中 staged、unstaged 或 untracked 成员，因此每个已准入的初始化 gitlink 都属于 conversion-ambiguous，并阻止自动修改。若嵌套仓库无法准入，只有在 gitlink 目录身份稳定后，inventory 才会保留带 gitlink mode 的 unavailable current evidence。父仓库 status 命令与非 gitlink Diff 命令会忽略所有 submodule；已接受的 gitlink status row 只来自限定作用域的原始 inventory，而 gitlink Diff 请求会在任何 Diff 命令运行前失败。未知但格式正确的 attribute 不进入持久证据，格式错误的记录会被拒绝。在 Windows 上，备用数据流 component 不是普通路径身份，不能生成具备自动变更资格的 baseline。
- **安全证据**：远程观察移除 userinfo、query 与 fragment 信息。指向公共 GitHub repository 的已净化 HTTPS 与 SSH remote 会生成小写、排序并去重的候选列表，但候选项不会因此成为 binding 或权限结果。指纹只保留允许列出的 Git 事实和带版本的摘要。查询可以报告已登记的 DSH Workspace id，但检查不会创建或变更该 Workspace。
- **继承变更 baseline**：发生变化的路径按顺序表示为精确 NUL 分帧路径摘要，以及允许列出的 index、冲突、submodule、symlink、缺失与有界原始内容证据。干净 worktree 返回完整的零条目 baseline。仓库 inventory 不完整时会拒绝整次检查；精确确定变更成员后，路径局部捕获或保留失败以及独立 baseline 限制会返回不可用 baseline 分支，其中没有部分条目或伪造的完整摘要。
- **已绑定 Project 状态**：`inspectProject` 只把保留的规范 worktree 路径当作 locator，重复执行稳定的两轮检查，并要求新的 Host、Workspace、worktree、Git directory 与文件系统身份匹配带 revision 的 Resource Binding。登记流程与状态投影共用同一套 inventory 比较语义；状态按有效 UTF-8 路径排序，区分 tracked、untracked、conflicted、staged、unstaged 与继承变更归因，并携带完整 index、worktree 与状态摘要。公共 gitlink row 只把父仓库已经证明的 commit 关系表达为 `changed`、`unchanged` 或 `unknown`，不会声称嵌套仓库的 tracked 或 untracked 脏状态。若已变更 gitlink 的嵌套 current state 无法准入，则只会在证明目录 mode 后携带 unavailable current evidence，并阻止结构化修改；已变更 gitlink 的 current mode 完全未知时会拒绝该状态。可见的 skip-worktree 变更会拒绝完整状态，而不会把已捕获的 current evidence 改称 unavailable；其他 index flag 会让状态保持可读，同时阻止修改。Conversion 歧义、无法解析的 status membership、路径文本无效或达到协议限制时会拒绝完整状态，而不会伪造布尔变更事实或返回部分列表。

## 结构化 Git 操作

- **持久生命周期**：`prepareOperation` 使用 source Intent 身份持久记录一个尚未产生效果的请求；完全相同的重放返回同一 operation，来自该 source 的不同请求会被拒绝。`startOperation` 获取新的准入结果，并在规划效果前重新完成 binding、status、HEAD、index、worktree、baseline 与修改可用性检查。占用中的锁和暂时不可用的证据让 operation 保持可重试。`inspectOperation` 只能依据只读 Git 与文件系统证据推进 publishing 生命周期，且不会创建新的 Git 效果。
- **Stage 与 unstage**：所选 change id 与 fingerprint 只能在新的 inventory 中解析成精确路径字节。私有 object database 与 alternate index 使用固定的 `update-index --index-info` 记录应用修改并验证结果 tree；所需 blob 只在无效果 plan 持久化后才会在 source object database 中重建。完整 target index 会写入已绑定 index 同目录的随机 operation-owned pin。在任何真实 `index.lock` 出现前，持久 `not-started` plan 会记录该 pin 的精确路径、摘要、字节长度、device 与 inode 身份以及 mode。每次 attempt 都会从该 pin 创建一条不替换现有文件的 hard link 作为 `index.lock`，证明两个名称仍指向已记录的完整文件，再把 lock rename 到 index。Stage 在关闭 filter 的情况下对原始 worktree 字节进行哈希；unstage 恢复精确的 HEAD mode 与 object，或在 unborn 路径上移除 index entry。未选择路径参与的 directory/file 冲突、unmerged 路径、已初始化 gitlink、sparse 布局、assume-unchanged、skip-worktree 与不受支持的 index 形式都会在效果前失败。
- **Commit**：Commit 要求 attached 或 unborn HEAD、至少一项 staged ordinary change，以及 repository-local 或 worktree-local config 中有效的 `user.name` 与 `user.email`。系统冻结同一份 author/committer identity 与时间戳，在私有 object directory 中通过 `commit-tree` 构建精确 tree 和 commit，并创建同类的随机同目录 pin，其中包含该 operation 的精确 index-lock marker。持久 `not-started` plan 会先记录完整 pin evidence，再由 attempt 把 pin 以不替换现有文件的方式 hard-link 到 `index.lock`，随后在关闭 hook、filter、签名、editor、pager、prompt、replacement object 与 lazy fetch 的情况下向 source object database 重建相同 object，并对固定 branch ref 执行 compare-and-set。并发 checkout 无法把 publication 重定向到新 branch。Detached HEAD 仍支持 inspection、Diff、stage 与 unstage，但 Commit 会在 effect 前失败，因为 Git 2.45 无法在 compare-and-set object id 的同时原子证明 `HEAD` 始终是 direct ref。
- **恢复证据**：成功的 index 结果由精确的已发布 index 摘要支撑。成功的 Commit 结果由冻结的目标 ref 或 operation 专属 reflog transition 支撑，因此之后的外部 ref 推进不会抹去成功事实。持久 `not-started` plan 只有在其 pin 与任何 live operation-owned lock 都保留已记录的同一文件证据时才能取消或恢复。一旦某次尝试可能已经到达 Git，缺失或冲突的证据会进入 `reconciliation-required`，而不会重试不确定的效果。
- **产物所有权与清理**：每次读取 pin 都同时受其持久字节长度与 `operationMaxIndexBytes` 约束；只有同目录路径、精确长度、device 与 inode 身份、mode、摘要，以及稳定的打开文件与路径名身份都匹配记录时，系统才会使用或删除该文件。对于具有持久 pin plan 的 operation，Local Host 会在持久化 `succeeded`、`failed`、`canceled` 或 `reconciliation-required` 前，精确移除其 operation-owned blocking `index.lock` 或证明该 link 已不存在，同步 index 目录并再次检查。POSIX 目录同步错误会向上传播；Windows 不向该提供方提供受支持的目录 `fsync`，因此这项同步是明确的平台限制。Acknowledgement 丢失不会让外部看到一条仍保留自有 blocking lock 的终态记录。非阻塞 pin 与 scratch 目录只在终态持久化后按精确 owner 幂等清理，每次终态 replay 都会重试。若进程在 plan 持久化前崩溃，可能留下随机非阻塞 pin 或仅 owner 可访问的 scratch 目录；恢复绝不会扫描这类未记录 residue。

应用 bootstrap 环境是 Git 可执行文件与普通继承进程变量的权威来源。Service Provider 会移除仓库或浏览器可控制的 Git 执行变量，但不会把已受损的父进程环境当作需要隔离的子进程沙箱。文件系统元数据取消遵循 FileSystem provider 在探测前后协作检查的约定；常规文件内容流会由取消信号销毁，Service Provider dispose 会等待全部调用收敛。

## 配置

每个字段都会解析为正整数。这些限制约束观察与 Service Provider 私有修改证据；产品策略仍归控制面所有。

| 字段 | 默认值 | 用途 |
| --- | --- | --- |
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
| `operationMaxIndexBytes` | `67108864` | 一项 Host Operation 保留的 source 或 target index 字节限制 |
| `operationMaxReflogBytes` | `4194304` | 恢复一项 Commit 发布时检查的 reflog 字节限制 |

## 模型体验

### Local Host 检查

#### 模型看到什么

什么也看不到。`ctx.sakiHostExecution` 提供 Host 侧 Saki Projection 与可信观察，但不注册模型可见输入。

#### Token 影响

每次请求直接增加零个 token。

#### KV Cache 影响

与模型请求相互独立：检查既不组装也不更改请求前缀。

## 已知限制与暂缓事项

- **只支持本地执行环境**：该 Service Provider 要求所选目录、文件系统元数据、系统 Git 可执行文件、Workspace registry 和 subprocess runtime 描述同一个 Host。远程 Host 需要另一种 Service Provider。
- **封闭的结构化修改范围**：不可用的继承变更 baseline 仍是有效的选择证据，但当前比较存在歧义或不完整时，完整的已绑定状态与每项修改都会快速失败。Diff 按路径限定且有界。Stage、unstage 与 Commit 会拒绝那些无法由公共 operation 证据精确表达的仓库状态，而不会回退到 porcelain 行为。
- **实时 data plane**：Git 读取期间，已准入 worktree 与 source object database 仍是实时数据。独立观察轮次与 source-control manifest 会拒绝它们观察到的变化，但不能阻止每个瞬时同用户竞态，也不会把 Service Provider 变成操作系统 sandbox。精确 owner 产物检查同样无法隔离恶意同用户进程在可写目录中于检查之间替换路径名。
- **Reparse 范围**：Service Provider 会拒绝直接 locator alias，以及最终 Git marker、管理目录、控制文件、对象目录与配置 worktree 上的 reparse entry。当前 FileSystem capability 无法证明每个祖先 component 都在不跟随 reparse point 的情况下打开。
- **不支持的控制布局**：reftable 等非 files ref storage，以及通过 `commondir` 重定向的普通 `.git` 目录，都会使检查变为不可用。如果 split index 所需的 `sharedindex.*` 文件不在私有控制目录中，该检查也会变为不可用。已经使用 object alternate 的 source repository 会被拒绝，而不会在快照中复现该布局。
