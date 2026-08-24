# `@breakfastdapaidang/saki-execution-local`

[English](README.md) | 中文

Saki 私有 Local Host Service Provider 基于 `ctx.fs`、`ctx.subprocess`、`ctx.workspaceRegistry` 与同一 Host 的文件系统元数据实现 [`ctx.sakiHostExecution`](../execution/README.zh.md)。它检查不可信的本地目录选择并返回分离证据；它不拥有 Project 策略、Resource Binding、Workspace 创建流程或持久产品记录。

## 检查行为

- **文件系统身份**：只使用文件系统的发现流程从所选目录向上查找普通 `.git` 目录或 gitfile，验证 linked worktree 的双向标记或本地 separate Git directory 布局，并通过 `realpath` 解析所选顶层目录、每 worktree Git directory 与 common Git directory。系统支持普通、linked、detached 与本地 separate Git directory worktree。只有所选规范目标包含在该顶层目录中时，才接受位于 Git 顶层目录之下的选择；返回的 worktree、Workspace 与展示证据都使用顶层目录。Service Provider 在两轮观察中为每个 Git 管理目录捕获不透明的同 Host 文件系统身份，在不把路径转换为小写的情况下比较路径，并拒绝缺失、非目录、bare、可清理、格式错误、逃逸或存在歧义的选择。直接 reparse locator、`.git` 标记、解析后的管理目录、对象目录或配置的 worktree 会被拒绝，而不会被规范化为别名。
- **私有 Git 控制数据**：每轮观察都会把已准入的 common config、启用的 `config.worktree`、HEAD、当前 loose 或 packed ref、index，以及 repository-local exclude 与 attribute 文件复制到私有控制目录。Repository-aware 命令运行前，系统通过显式的 `git config --file ... --no-includes` 查询审计复制的配置。这些命令只使用固定的只读 argv 集合读取私有 config、HEAD、ref 与 index，因此不会在该轮观察中重新打开它们的 source 副本。Source object database 若已存在 object alternate 或 HTTP alternate，检查会被拒绝；私有控制目录改为生成一条仅指向已准入 live source object database 的 alternate。
- **有界 Git 执行**：Service Provider 要求 Git 2.45 或更高版本。一个原始字节 runner 使用结构化 argv、明确的工作目录、必填的取消信号、进程树收敛、受控 locale、非交互式凭据设置、`--no-lazy-fetch`、`--no-replace-objects`，以及固定的 pager、fsmonitor、hook、diff、attribute 与配置设置来调用 Git。在 inventory 命令可以查询 worktree 前，Service Provider 会拒绝 repository 或 worktree scope 中的每项 `include.path` 与 `includeIf.*.path` 指令且不跟随它，再从这些 scope 读取 `core.fsmonitor`。缺失或明确的 `false` fsmonitor 值可以接受，而程序、`true`、格式错误的值或不可读取的 scope 会在不启动所配置 monitor 的情况下拒绝检查。每条命令和整个观察轮次的 stdout、stderr 或时间达到限制时会拒绝整个操作，而不会暴露截断数据或子进程诊断。
- **精确观察**：闭合的 NUL 分帧 `ls-tree`、带 tag 的 staged `ls-files`、untracked `ls-files` 与 `check-attr --all` inventory 仅在内存中保留精确路径字节。Service Provider 比较常规文件、symlink 与 gitlink 的原始证据，并且不调用 check-in filter；它不声称这些结果等同于经过 filter 归一化的 porcelain status。已初始化 gitlink 会暴露嵌套仓库的 HEAD，但不会暴露其中 staged、unstaged 或 untracked 成员，因此每个已初始化 gitlink 都属于 conversion-ambiguous，并阻止自动修改。未知但格式正确的 attribute 不进入持久证据，格式错误的记录会被拒绝。在 Windows 上，备用数据流 component 不是普通路径身份，不能生成具备自动变更资格的 baseline。
- **安全证据**：远程观察移除 userinfo、query 与 fragment 信息。指向公共 GitHub repository 的已净化 HTTPS 与 SSH remote 会生成小写、排序并去重的候选列表，但候选项不会因此成为 binding 或权限结果。指纹只保留允许列出的 Git 事实和带版本的摘要。查询可以报告已登记的 DSH Workspace id，但检查不会创建或变更该 Workspace。
- **继承变更 baseline**：发生变化的路径按顺序表示为精确 NUL 分帧路径摘要，以及允许列出的 index、冲突、submodule、symlink、缺失与有界原始内容证据。干净 worktree 返回完整的零条目 baseline。仓库 inventory 不完整时会拒绝整次检查；精确确定变更成员后，路径局部捕获或保留失败以及独立 baseline 限制会返回不可用 baseline 分支，其中没有部分条目或伪造的完整摘要。

应用 bootstrap 环境是 Git 可执行文件与普通继承进程变量的权威来源。Service Provider 会移除仓库或浏览器可控制的 Git 执行变量，但不会把已受损的父进程环境当作需要隔离的子进程沙箱。文件系统元数据取消遵循 FileSystem provider 在探测前后协作检查的约定；常规文件内容流会由取消信号销毁，Service Provider dispose 会等待全部调用收敛。

## 配置

每个字段都会解析为正整数。这些限制只约束观察；产品策略仍归控制面所有。

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
- **没有变更回退**：不可用的继承变更 baseline 仍是有效的只读证据，但该 Service Provider 不会推断缺失条目或放宽限制以获得自动变更资格。
- **实时 data plane**：Git 读取期间，已准入 worktree 与 source object database 仍是实时数据。独立观察轮次与 source-control manifest 会拒绝它们观察到的变化，但不能阻止每个瞬时同用户竞态，也不会把 Service Provider 变成操作系统 sandbox。
- **Reparse 范围**：Service Provider 会拒绝直接 locator alias，以及最终 Git marker、管理目录、控制文件、对象目录与配置 worktree 上的 reparse entry。当前 FileSystem capability 无法证明每个祖先 component 都在不跟随 reparse point 的情况下打开。
- **不支持的控制布局**：reftable 等非 files ref storage，以及通过 `commondir` 重定向的普通 `.git` 目录，都会使检查变为不可用。如果 split index 所需的 `sharedindex.*` 文件不在私有控制目录中，该检查也会变为不可用。已经使用 object alternate 的 source repository 会被拒绝，而不会在快照中复现该布局。
