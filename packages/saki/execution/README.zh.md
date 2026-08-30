# `@breakfastdapaidang/saki-execution`

[English](README.md) | 中文

Saki 私有 Host Execution Service Definition 注册 `ctx.sakiHostExecution`。它定义提供方无关的 Project 检查与 Diff 值，以及结构化 StageFiles、UnstageFiles 和 Commit 副作用所使用的持久 Host Operation 生命周期。[Saki 控制面](../control-plane/README.zh.md)拥有授权、Project 策略、写入准入和持久 Control Intent。[Saki 后端架构](../../../docs/saki/architecture/0.1.0-backend.zh.md)定义更完整的控制面与执行面划分。

## 项目选择检查

请求包含所选 Saki Host id 与调用方提供的目录定位值。该定位值是不可信输入：Service Provider 每次调用都会独立解析并检查它，该拼写或先前的 Projection 都不能授权后续操作。必填的 `AbortSignal` 把检查工作绑定到调用方生命周期。

成功结果把可供浏览器使用的 `ProjectSelectionProjection` 与 `TrustedProjectSelectionObservation` 分开。安全 Projection 包含经过清理且不呈现为路径的展示标签、有界 Git 事实、可选的现有 DSH Workspace id、带版本的指纹和完整或不可用的 `InheritedChangeBaseline`；它不包含规范 Host 路径、Git 管理路径、发生变化的明文文件名、文件内容或带凭据的远程 URL。当经过清理的 HTTPS 或 SSH remote 指向公共 `github.com/owner/repository` 坐标时，Projection 还会携带小写、排序、去重后的候选列表。候选项用于支持用户确认，不是 Resource Binding 或授权结果。可信观察保留同一次检查的规范路径身份、每 worktree 与 common Git 管理目录的不透明同 Host 身份，以及闭合 Git 比较设置；其 schema 仅接受可移植的 POSIX、Windows 驱动器或 Windows UNC 绝对路径结构。只有同一 Host 上的新鲜 Service Provider 检查拥有规范 `realpath` 与管理目录身份，持久保留的路径本身绝不授权 effect。严格 schema 会根据保留证据重算 baseline 条目、baseline 聚合与完整检查摘要，其中 Workspace 观察以明确的存在或缺失分支表示。检查不会创建 Workspace 或 Resource Binding。

baseline schema 区分完整捕获与不可用捕获；前者包括干净的零条目结果，后者只携带有界原因与已观察限制。Consumer 不得把不可用证据当作部分完整 baseline。

## 已绑定 Project 状态

`inspectProject` 接受 `ActiveHostProjectBinding`，其中包含稳定 id 与 revision、字面量 active health、Host 与 Workspace 身份、已接受的登记检查和登记时继承变更 baseline。严格 schema 要求 Host 和 baseline 身份与该登记证据一致。登记检查可能早于 Workspace 创建，因此 Service Provider 会重新验证当前 repository 与 Workspace 关系后再返回状态；保留的路径和指纹绝不授权读取。

成功的 `ProjectGitStatusObservation` 包含 branch、HEAD、upstream、规范 index 与 worktree 摘要，以及按 UTF-8 字节排序的完整 repository 相对变更路径列表。每项变更都有一个不透明且仅属于本次观察的 `ProjectGitChangeId`，并区分 tracked、untracked 或 conflicted 状态、staged 与 unstaged 事实，以及 inherited、subsequent、mixed 或 unknown 的登记来源关系。在完整解析 row 或校验 fingerprint 前，严格 status schema 会拒绝超过协议 row 上限的原始 changes array，并且最多扫描已准入的 row 数，提前拒绝聚合 UTF-8 path 字节预算超限。随后，严格 schema 会重建不含 id 的完整状态 seed、每个 change id 和最终带版本指纹；它还会拒绝路径穿越、NUL、无效 Unicode、重复或非规范路径顺序、不可能的 untracked 标记、不一致的 Git object 宽度和不匹配的指纹。失败是以下闭合且不含路径的原因之一：`binding-stale`、`missing`、`malformed`、`limit`、`invalid-path`、`ambiguous` 或 `unavailable`；调用方取消会通过必需的 `AbortSignal` 拒绝，而不会返回部分状态。

## 已绑定 Project Diff

`readDiff` 接受 active Binding、精确 status fingerprint、不透明 change id、staged、unstaged 或 conflict layer，以及可选 continuation cursor。Service Provider 会在内部解析文件并返回一个有界 `ProjectGitDiffPage`；patch fingerprint 把每页绑定到同一份完整 patch，而 line 与 byte range 会明确表达截断。请求不包含调用方选择的路径或 Git command。陈旧 observation 或 cursor、缺失或含糊 row、不支持的 untracked、conflict 或 binary 内容、无效 UTF-8 及资源限制都会返回闭合且不含路径的原因，而不是局部输出。

## 持久结构化 mutation

`prepareOperation` 会在任何副作用前把一个不可变 Host request 持久绑定到其 Control Intent source，并返回无法跨越 JSON 的 provider-owned acceptance。`startOperation` 会在 planning 或 publication 前检查该 acceptance 与当前同进程 Binding Write Admission。`inspectOperation` 根据持久 evidence 推进恢复，而不会重复含糊副作用；`cancelOperation` 只记录闭合的持久 cancellation reason；`onChanged` 提供 post-commit 唤醒，而 snapshot 保持权威。调用方 `AbortSignal` 只限制单次调用，并非持久取消。

StageFiles 与 UnstageFiles 携带 observation-scoped change id 和 fingerprint，绝不携带路径。Commit 携带精确 status、HEAD、index tree、worktree、继承变更 baseline 与 message；Host 派生 Git identity 和 publication target。Commit 接受 attached 与 unborn HEAD；detached HEAD 仍可用于 inspection、Diff、stage 与 unstage，但 Commit 会在 effect 前失败。成功结果会记录 Host 解析的路径，或 commit id、tree、parent、target、author 与 committer；每份 Commit signature 都是在应用执行环境规范化后，Service Provider 创建该 object 时实际使用的精确 identity，而非未经规范化的配置输入。生命周期区分 prepared、accepted、planning、publishing、succeeded、已证明无副作用的 failure 或 cancellation，以及 publication evidence 未知或矛盾时的 `reconciliation-required`。

Service Definition 没有配置。每个 Service Provider 拥有其执行环境机制与必需的资源限制。

## 模型体验

### Host execution 值

#### 模型看到什么

什么也看不到。`ctx.sakiHostExecution` 向 Host 侧 Saki Consumer 提供分离的检查、Diff 与 operation 值，不注册工具、prompt section 或 session event。

#### Token 影响

每次请求直接增加零个 token。

#### KV Cache 影响

与模型请求相互独立：该服务不组装或更改请求前缀。

## 已知限制与暂缓事项

- **受约束的 Git 操作集合**：per-hunk staging、stash、conflict editing、branch management、push、worktree management、repair 与 retirement 仍不属于该服务。Commit 不运行 hook 且不签名；需要 hook、签名或不受支持 external filter 的仓库必须使用另一项显式受信提供方。
