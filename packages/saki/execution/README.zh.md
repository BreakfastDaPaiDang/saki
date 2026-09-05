---
description: "通过提供方无关的 Host 接口请求项目检查、有界 diff、结构化 Git 变更和持久 Agent 启动。"
kind: "package-reference"
---

# `@breakfastdapaidang/saki-execution`

[English](README.md) | 中文

## 概述

通过提供方无关的 Host 接口请求项目检查、有界 diff、结构化 Git 变更和持久 Agent 启动。

## 目录

- [使用本包](#use-this-package)
- [项目选择检查](#project-selection-inspection)
- [已绑定 Project 状态](#bound-project-status)
- [已绑定 Project Diff](#bound-project-diff)
- [持久结构化 mutation](#durable-structured-mutations)
- [持久 Agent 启动](#durable-agent-starts)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

Saki 私有 Host Execution Service Definition 注册 `ctx.sakiHostExecution`。它定义提供方无关的 Project 检查与 Diff 值，以及结构化 StageFiles、UnstageFiles、Commit、PushBranch 和 Agent Run 启动副作用所使用的持久 Host Operation 生命周期。[Saki 控制面](../control-plane/README.zh.md)拥有授权、Project 策略、写入准入和持久 Control Intent。[Saki 后端架构](../../../docs/saki/architecture/0.1.0-backend.zh.md)定义更完整的控制面与执行面划分。

<a id="project-selection-inspection"></a>
## 项目选择检查

请求包含所选 Saki Host id 与调用方提供的目录定位值。该定位值是不可信输入：Service Provider 每次调用都会独立解析并检查它，该拼写或先前的 Projection 都不能授权后续操作。必填的 `AbortSignal` 把检查工作绑定到调用方生命周期。

成功结果把可供浏览器使用的 `ProjectSelectionProjection` 与 `TrustedProjectSelectionObservation` 分开。安全 Projection 包含经过清理且不呈现为路径的展示标签、有界 Git 事实、可选的现有 DSH Workspace id、带版本的指纹和完整或不可用的 `InheritedChangeBaseline`；它不包含规范 Host 路径、Git 管理路径、发生变化的明文文件名、文件内容或带凭据的远程 URL。当经过清理的 HTTPS 或 SSH remote 指向公共 `github.com/owner/repository` 坐标时，Projection 还会携带小写、排序、去重后的候选列表。候选项用于支持用户确认，不是 Resource Binding 或授权结果。可信观察保留同一次检查的规范路径身份、每 worktree 与 common Git 管理目录的不透明同 Host 身份，以及闭合 Git 比较设置；其 schema 仅接受可移植的 POSIX、Windows 驱动器或 Windows UNC 绝对路径结构。只有同一 Host 上的新鲜 Service Provider 检查拥有规范 `realpath` 与管理目录身份，持久保留的路径本身绝不授权 effect。严格 schema 会根据保留证据重算 baseline 条目、baseline 聚合与完整检查摘要，其中 Workspace 观察以明确的存在或缺失分支表示。检查不会创建 Workspace 或 Resource Binding。

baseline schema 区分完整捕获与不可用捕获；前者包括干净的零条目结果，后者只携带有界原因与已观察限制。Consumer 不得把不可用证据当作部分完整 baseline。

<a id="bound-project-status"></a>
## 已绑定 Project 状态

`inspectProject` 接受 `ActiveHostProjectBinding`，其中包含稳定 id 与 revision、字面量 active health、Host 与 Workspace 身份、已接受的登记检查和登记时继承变更 baseline。严格 schema 要求 Host 和 baseline 身份与该登记证据一致。登记检查可能早于 Workspace 创建，因此 Service Provider 会重新验证当前 repository 与 Workspace 关系后再返回状态；保留的路径和指纹绝不授权读取。

成功的 `ProjectGitStatusObservation` 包含 branch、HEAD、upstream、规范 index 与 worktree 摘要，以及按 UTF-8 字节排序的完整 repository 相对变更路径列表。每项变更都有一个不透明且仅属于本次观察的 `ProjectGitChangeId`，并区分 tracked、untracked 或 conflicted 状态、staged 与 unstaged 事实，以及 inherited、subsequent、mixed 或 unknown 的登记来源关系。在完整解析 row 或校验 fingerprint 前，严格 status schema 会拒绝超过协议 row 上限的原始 changes array，并且最多扫描已准入的 row 数，提前拒绝聚合 UTF-8 path 字节预算超限。随后，严格 schema 会重建不含 id 的完整状态 seed、每个 change id 和最终带版本指纹；它还会拒绝路径穿越、NUL、无效 Unicode、重复或非规范路径顺序、不可能的 untracked 标记、不一致的 Git object 宽度和不匹配的指纹。失败是以下闭合且不含路径的原因之一：`binding-stale`、`missing`、`malformed`、`limit`、`invalid-path`、`ambiguous` 或 `unavailable`；调用方取消会通过必需的 `AbortSignal` 拒绝，而不会返回部分状态。

`inspectProjectCommit` 会重新验证 active Binding，并只接受宽度匹配 repository format 的精确 object id。它确认该 local object 是 Commit 并返回同一个 id；否则，它会区分陈旧 Binding、缺失 Commit 和不可用 Host evidence，并且不接受任意 revision、ref 或 path。

<a id="bound-project-diff"></a>
## 已绑定 Project Diff

`readDiff` 接受 active Binding、精确 status fingerprint、不透明 change id、staged、unstaged 或 conflict layer，以及可选 continuation cursor。Service Provider 会在内部解析文件并返回一个有界 `ProjectGitDiffPage`；patch fingerprint 把每页绑定到同一份完整 patch，而 line 与 byte range 会明确表达截断。请求不包含调用方选择的路径或 Git command。陈旧 observation 或 cursor、缺失或含糊 row、不支持的 untracked、conflict 或 binary 内容、无效 UTF-8 及资源限制都会返回闭合且不含路径的原因，而不是局部输出。

<a id="durable-structured-mutations"></a>
## 持久结构化 mutation

`prepareOperation` 会在任何副作用前把一个不可变 Host request 持久绑定到其 Control Intent source，并返回无法跨越 JSON 的 provider-owned acceptance。`startOperation` 会在 planning 或 publication 前检查该 acceptance 与当前同进程 Binding Write Admission。`inspectOperation` 根据持久 evidence 推进恢复，而不会重复含糊副作用；`cancelOperation` 只记录闭合的持久 cancellation reason；`onChanged` 提供 post-commit 唤醒，而 snapshot 保持权威。调用方 `AbortSignal` 只限制单次调用，并非持久取消。

StageFiles 与 UnstageFiles 携带 observation-scoped change id 和 fingerprint，绝不携带路径。Commit 携带精确 status、HEAD、index tree、worktree、继承变更 baseline 与 message；Host 派生 Git identity 和 publication target。Commit 接受 attached 与 unborn HEAD；detached HEAD 仍可用于 inspection、Diff、stage 与 unstage，但 Commit 会在 effect 前失败。成功结果会记录 Host 解析的路径，或 commit id、tree、parent、target、author 与 committer；每份 Commit signature 都是在应用执行环境规范化后，Service Provider 创建该 object 时实际使用的精确 identity，而非未经规范化的配置输入。生命周期区分 prepared、accepted、planning、publishing、succeeded、已证明无副作用的 failure 或 cancellation，以及 publication evidence 未知或矛盾时的 `reconciliation-required`。

PushBranch 将一个精确 local Commit 和 active Resource Binding 绑定到一个 canonical GitHub `nameWithOwner` 与 `refs/heads/*` target。Request 不携带 remote URL、credential-helper 选择或 caller 提供的 remote observation。Provider 在 planning 期间观察并固定 publication 前 remote state，拥有 transport 与 credential-helper 选择权，并返回精确 repository、ref、Commit、previous remote state 和不含 credential bytes 的安全 helper identity。

Service Definition 没有配置。每个 Service Provider 拥有其执行环境机制与必需的资源限制。

<a id="durable-agent-starts"></a>
## 持久 Agent 启动

`StartAgentRun` 携带 `execution-dispatch` source、精确可写 Git precondition、预分配的 Agent Run、Work Session、DSH Session 与输入 MessageId、固定 Agent Profile 与 Model Route，以及一条完整的纯文本 `UserMessage`。其 payload digest 覆盖该 message，以及初始 `saki-agent-run` source 或带归因的 `saki-intervention-answer` source。Preparation 保持 inert；start 要求已接受的 Dispatch mapping 和当前 `agent-run` Binding Write Admission。稳定结果会重复 Run、Work Session、Session 与输入这四项 identity。

Host 成功证明目标 Session 与已 dispatch 输入已经持久化，并不表示模型轮次已经完成。精确 replay 会复用一条 Host Operation。Provider 会在交付前检查完整 Session history：只有输入不存在时才允许发送该输入；canceled、replaced、unknown 或 conflicting evidence 一律不得重新发送。参见[手动 dispatch 决策](../../../.agents/notes/implemented/feature/2026-08-18-saki-manual-give-to-agent-dispatch.zh.md)。

Intervention answer 使用新的 Dispatch 与稳定 MessageId，但保留所属 Agent Run、Work Session 与 Session。它的 source 记录 Intervention Request、answer Control Intent 与不可变 Actor 归因。交付复用普通 `StartAgentRun` operation 与 `user/message` event；系统不会增加 answer 专用 Host effect，也不会直接写入 Session。`inspectInterventionOpening` 会另行读取持久 `request_intervention` call、精确成功的模型可见 result，以及已完成的最终 step 和 turn，并且只返回 `absent`、`pending`、精确 `confirmed` turn/step evidence 或 `conflict`。它既不暴露也不修改 Session。

`resumeAgentRun` 是仅供启动恢复使用的 operation，目标是已经过控制面校验的 running Run，以及与其精确匹配的 succeeded `StartAgentRun` operation 和 request。只有物理 Session header 与原始输入匹配该 request 时，Provider 才会恢复 live Agent handle。它不会增加输入、wake 或模型请求；Host、Session 或 Agent evidence 缺失、不可用或冲突时，启动流程会失败。

<a id="model-experience"></a>
## 模型体验

### Host execution 值与 Agent Run 输入

#### 模型看到什么

Inspection、Diff 与结构化 Git operation 不会增加模型可见内容。已启动的 `StartAgentRun` 通过选定 DSH Session 交付其精确纯文本 user message；初始 source 保留 Dispatch、Agent Run 与 Work Session id，answer source 还会保留 Intervention、answer Intent 与 Actor 归因。

#### Token 影响

Inspection、Diff、preparation 与结构化 Git operation 直接增加零个 token。原始输入持久化后，启动 Agent 可能发出选定模型请求；其 token 用量取决于已固定 message 与组装后的 Agent context。

#### KV Cache 影响

每条初始输入或 Intervention answer 都是新的 user turn，不属于可复用 prefix。仅用于恢复的 wake message 会在模型组装前排除。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- **受约束的 Git 操作集合**：per-hunk staging、stash、conflict editing、一般 branch management、worktree management、repair 与 retirement 仍不属于该服务。Commit 不运行 hook 且不签名；需要 hook、签名或不受支持 external filter 的仓库必须使用另一项显式受信提供方。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

不发布 runtime invariant companion，因为Service Definition 只包含 schema 与规范值辅助函数，没有可变关系。

</details>
