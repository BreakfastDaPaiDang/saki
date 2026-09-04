# Agent Note: Saki Branch Delivery 与 Milestone Release Evidence

Status: implemented

[English](2026-08-18-saki-branch-delivery-and-milestone-release-evidence.md) | 中文

## 问题

一项经过审阅的本地 Commit 还不是已经交付的 Work Item。分支可能尚未到达 GitHub，PR（Pull Request）可能指向另一个 head，CI 可能不完整或已经陈旧，而 Agent Run 或 GitHub review 即使报告成功，也不代表获得授权的人已经验收结果。Branch、PR 与 check 的可变状态不能仅因为各项事实曾在不同时间成立，就成为完成证据。

Push 与 GitHub mutation 还会跨越无法共享事务的持久边界。进程可能在 remote ref 或 PR 已经改变、但 Saki 尚未记录结果时停止。盲目重试可能覆盖远端并发工作或创建重复 PR；把缺失 acknowledgement 视为失败，则可能让 Work Item 与实际已经发生的副作用失去关联。

Milestone 发布证据还存在范围更大的完整性问题。GitHub 拥有 Milestone scope 与 metadata，Saki 则拥有 release phase 和用于派生 Released 的证据。局部 scope read、调用方选择的排除项、可变 tag target、不相关的 GitHub Release、陈旧 CI 结果或未经验证的 upstream baseline，都可能使系统发布一项从未描述过同一个完整世界的 release 声明。

## 决策

### Branch Delivery

Saki 控制面为每个 Development Project 与 Work Item 组合保留至多一个当前 Branch Delivery 聚合。该聚合具有稳定 identity 与 expected revision，并把当前准确本地 Commit、规范 GitHub head ref、base ref、Push Host Operation、PR identity、定向交付观察以及任何人工验收，绑定到准入这些事实的准确 Project、Repository、Work Item、Resource Binding 与 GitHub mapping revision。

在验收前，新选择的 head、Push、PR 或刷新后的证据只能通过 expected revision 更新同一个聚合。此前的 Control Intent、Host Operation 与外部观察继续作为历史证据，而不成为相互竞争的当前 Delivery。验收会封存该聚合：此后的 branch、Commit、PR 或 CI 变化不能改写人工已经验收的内容，而需要另行归因的产品工作。

Push 复用[可恢复结构化 Git 决策](../architecture/2026-08-28-saki-recoverable-structured-git-operations.zh.md)建立的 Host Operation 与恢复机制，同时仍作为现有 `BindingWriteAdmission` 下独立的交付 operation。其不可变 request 把一个准确本地 Commit 绑定到一个规范 GitHub Repository 和 `refs/heads/*` target。Local Host 在 effect 前记录准确的远端 object id 或已经证明的 branch 缺失，证明 fast-forward ancestry 或该缺失，并且只使用准确的 `--force-with-lease=<ref>:<expected>` 远端 compare-and-set。

Local Host 隔离仓库控制的配置、钩子、transport override、提示词与递归 submodule 行为。它调用一项受信任且由 Host 配置的 system Git credential helper，但不返回或持久化 credential 字节。如果无法建立这些限制，production Push 不可用。operation 一旦记录副作用可能已经发生，acknowledgement 丢失就通过准确 remote-ref inspection 解决；缺失、旧、已改变、相互矛盾或不可用的证据都绝不授权盲目执行第二次 Push。

PR 创建通过现有[可恢复 GitHub mutation 协议](../architecture/2026-08-16-saki-recoverable-github-work-item-mutations.zh.md)，使用一个稳定的隐藏 delivery marker，以及准确的 Repository、head ref、base ref 与 head Commit identity。关联现有 PR 是另一项本地 Control Intent，只有在一次完整定向读取之后才准入。Branch Delivery 分别保留实际 branch、Commit、URL、PR identity 与 Product App identity，不把它们与 Saki Actor、Host Git credential identity 或 Commit author 混为一体。

### 定向交付观察

[Polling-first GitHub 同步决策](../architecture/2026-08-18-saki-polling-first-github-synchronization.zh.md)继续拥有完整 Board scan 与 GitHub Sync Checkpoint。PR、完整 PR review、CI、Milestone、tag、Release、Commit 与 ancestry 事实使用定向读取，绝不推进该 checkpoint。交互式 View 请求一次 targeted pass。一条可配置且限定在 Provider 生命周期内的 loop 只轮询持久 pending Branch 与 Milestone Delivery 工作；它立即启动，在每次 pass 完成后等待完整 interval，隔离不同 aggregate 之间与不同记录之间的故障，并在 Provider 分离时取消并排空。

每个定向 source 把自己的 last-confirmed observation 与当前 failure、staleness 和 invalidation 分开保留。刷新失败时保留已经确认的事实，但不把它展示为当前事实。PR review 始终是没有 transition、acceptance 或 release authority 的原始展示 observation；其 failure 不替代精确 ref、PR、CI 与 human Intent 要求。浏览器 projection 只从该已保留的精确 Commit fact 派生闭合 CI summary，并独立公开当前 source health。CI success 要求获得精确 Branch Delivery Commit 的完整、已完全分页结果；缺失、不完整、pending、failed、canceled、陈旧、相互矛盾或权限受限的证据都 fail closed。

已经确认的 Push 与 PR 证据创建或准确回放现有可恢复 `MoveWorkItem` 子 transition，把 Work Item 移至 In review。定向读取可以刷新或使 Delivery 证据失效，但不静默改变 GitHub Project Status，也不结算人工验收。

### 人工验收

验收是由当前 human Principal 使用当前 scoped Grant 提交的独立 Control Intent，并携带预期 Branch Delivery revision，以及存储的 mapping revision 下准确的 Work Item remote fingerprint，遵循 [Principal、Grant 与 Actor 归因决策](../../../../docs/adr/0008-principals-grants-and-actor-attribution.zh.md)。在 mutation boundary，控制面重新读取准确本地 Commit、remote ref、PR head 与完整的准确 Commit CI 证据，并拒绝任何陈旧、不完整、失败或相互矛盾的结果。

已接受的 Intent 追加不可变 Actor 与 evidence attribution、封存 Branch Delivery，并创建或准确回放现有可恢复 Done 与 Issue-close 子 transition。Agent 自报、成功的 Agent Run、PR author、Product App identity 或 GitHub `APPROVED` review 都绝不能替代这项人工决策。子 mutation acknowledgement 丢失时，系统进行定向 inspection 与 reconciliation，而不重新打开或改写已经验收的 Delivery。

### Milestone Delivery 与 ReleaseEvidencePolicyV1

GitHub 继续作为 Milestone 的 Issue scope、title、description、due date 与 open 或 closed state 的权威。一个版本化的 Saki Milestone Delivery record 绑定准确 Development Project、Repository 与 GitHub Milestone，并且只拥有 Planned、In Progress、Ready to Release 或 Canceled phase metadata；预期 `saki-v*` tag、预期 release Commit 与官方 Upstream Baseline metadata；repair state；以及可选、不可变且内嵌的 Release Evidence。Phase change 与 finalization 使用预期 record revision。Released 只从内嵌证据派生，绝不写成可变 phase metadata。

Milestone Projection 分别保留各 source 的 confirmation、failure、staleness 与 invalidation。它把准确 GitHub scope fingerprint，与来自一个匹配 confirmed Board generation 的各 Board Status Work Item 总数、unmapped 或 unsupported count、类型化 Blockage、Saki phase 及 Release summary 组合起来。它绝不静默拼接不同 scan generation，也不把局部 Milestone scope 展示为完整结果。

`ReleaseEvidencePolicyV1` 以 `release-evidence/v1` 标识，是 version 1 selection、completeness 与 freshness 的唯一控制面所有者。它不公开调用方提供的 exclusion、predicate 或策略语言。Finalize Intent 准备完成后，该策略要求一次新的完整 Board scan、一次完全分页的 Milestone scope read、一份非空准确 mapping、每个已选 Work Item 均处于 Done 或 Canceled，并要求每个拥有 Delivery 的 Done item 都具备已验收且当前的 Branch Delivery 证据与完整准确 Commit CI success。

同一次 evaluation 还要求：每个保留的 delivery Commit 都是 release Commit 的 ancestor；准确 `refs/tags/saki-v*` reference 递归 peel 到该 Commit；GitHub Release 与同一个 Commit 匹配，且不把 `target_commitish` 当作 identity；以及准确官方 Upstream Baseline 已存在于配置的 upstream Repository，并且是 release Commit 的 ancestor。由于 [installation token 仅限该 installation 获准访问的 Repository](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)，0.1.0 持久化 upstream Repository 的规范 `nameWithOwner`、node id 与 database id，再通过有界、不含凭据的 public read 证明 upstream 存在性。`GET /repos/{owner}/{repo}` 必须匹配这三项 identity 与 public visibility，然后轻量 `GET /repos/{owner}/{repo}/git/commits/{commit_sha}` 必须返回完整且准确的 SHA。一个独立串行队列约束该匿名路径，而该路径仍受 GitHub 共享的低额未认证配额约束；private configured upstream 不受支持。最后一次完整 reread 必须与已评估事实匹配。

一项人工 expected-revision compare-and-set 在 Milestone Delivery record 内嵌策略与 evaluation digest、准确 Development Project、选中的 Work Item 及其 Branch Delivery head/base ref、此前 metadata revision、tag、Release、peeled Commit、upstream Repository 的全部三项 identity、Upstream Baseline 与 ancestry proof、Actor，以及 Intent mapping。Evaluation 与 final fresh scan 可以观察到不同的完整 Board generation；final reread 的语义相等性使用 Board fingerprint 与 facts，内嵌 evidence 和 digest 则保留并绑定最终 generation。外部 Milestone closure、GitHub 并发变化或最终 reread 改变时，系统产生 repair、conflict 或 reconciliation，而不发布局部 phase 或 evidence state。后续外部 drift 不改写内嵌 Release Evidence。

### 所有权与边界

本功能具体实现更广泛的[可恢复 Control Intent 提案](../../proposed/architecture/2026-08-18-saki-recoverable-control-intents.zh.md)与 [ADR 0013](../../../../docs/adr/0013-polling-first-staged-github-synchronization.zh.md)中的定向交付部分。它复用现有 Host Operation lifecycle、Product App Service、Git process launcher、GitHub mutation recovery、Binding write admission、Work Item transition 与单一控制面 Service。它只增加一项相邻 Saki state migration，不增加平行 client、launcher、lease、queue、generic saga 或 release 策略语言。

本功能持久化其所属投影需要的 Git、PR、CI、acceptance 与 release 事实。把选定的 Git、PR 与 CI 事实投影到 Principal-scoped My Work 和 Attention，仍推迟到 [follow-up #74](https://github.com/BreakfastDaPaiDang/saki/issues/74)，这与[持久 Intervention 决策](2026-08-18-saki-durable-intervention-answer.zh.md)一致。本功能不增加 generic Signal 聚合、Attention table、dismissal lifecycle，也不让 projection read 执行 network work。

Automatic merge、automatic Done、复杂 Git history editing、任意 release train、GitHub user authorization 与验收后的 Delivery mutation 均不属于本决策。

## 考虑过的替代方案

**使用可变 branch、PR 或 GitHub Release `target_commitish` 作为 delivery identity。**它们可以各自独立移动，并在较早 observation 之后指向不同 Commit。准确 Commit、ref、PR head、递归 peel 后 tag 与 Release relation 保留了 acceptance 和 release finalization 所需的 identity。

**把 Agent Run success、PR approval 或外部 credential 视为 acceptance。**这些事实分别建立 execution、review 或 effect identity，而不是当前 human Principal 的带归因决策。混淆它们会让 provenance 或 external account 取得 Saki authority。

**在 response 不可用后重试 Push 或 PR 创建。**没有响应不能证明远端副作用失败。准确 remote-ref 或基于 marker 的 inspection 可以证明 result、安全 absence、conflict 或 reconciliation requirement，而不会重复或覆盖外部工作。

**把 delivery observation 折叠进 Board scan 与 checkpoint。**PR、CI、tag 与 Release 事实和共享 Work Item Status 具有不同生命周期与 active-view demand。把它们耦合起来，会让局部 delivery refresh 阻塞 Board publication，或者错误推进 Board checkpoint。

**把 Release Evidence 存入单独 record。**第二条 record 会产生跨记录 publication gap，使 phase 与 evidence 发生分歧。通过 Milestone Delivery compare-and-set 内嵌不可变证据，可让 Released 从一个权威值派生。

**允许调用方过滤 Milestone scope，或配置通用证据策略。**调用方 exclusion 可能让不完整 release 看起来完整，而策略语言会在第二项真实策略出现前增加 versioning 与 evaluation behavior。一个固定且带版本的策略可以提供确定性的 version 1 evidence。

**在 delivery 期间创建 Signal 或 Attention record。**复制的 notification state 会重复 Branch Delivery 与定向 observation 所有者。Follow-up #74 拥有从当前 durable producer record 派生 Principal-scoped entry 的工作，但不取得 mutation authority。

## 验证

Branch Delivery schema、存储、控制面与恢复测试固定每个 Development Project 与 Work Item 至多一个当前聚合、验收前 expected-revision update、不可变的已验收证据、准确 Commit 与 ref 准入、Push acknowledgement 丢失后的 inspection、marker 绑定的 PR 创建、准确关联，以及可恢复的 In review 与 Done 子 transition。测试还证明原始 PR review 事实保持为独立展示证据，人工验收仍要求当前 authority 与完整成功的准确 Commit CI reread。

GitHub Service Definition、Product App 与 Host API 测试覆盖严格的 PR、review、CI、Milestone、tag、Release、Commit、public upstream Commit 与 ancestry 事实；完整分页与父身份检查；operation 专属 permission；有界 failure；Provider 分离；以及封闭 wire projection。Polling 测试覆盖限定在 Provider 生命周期内且立即执行的首轮 pass、每次完成后等待完整 interval、pending record 选择、逐记录故障隔离，以及不会推进 Board checkpoint 的取消并排空 dispose。

Milestone Delivery 与策略测试固定与一个匹配 Board generation 结合的完整 scope、类型化 incompleteness 与 repair、Done item 的条件式已验收 Delivery evidence、准确 CI 与 ancestry、递归 tag peel、匹配 Release Commit、不含凭据的 public Upstream Baseline existence，以及最后一次语义 reread。测试还证明未变事实可以进入更新的完整 Board generation，而内嵌 digest 会绑定最终 generation；变化或被篡改的 evidence 会 fail closed。

无密钥组合 delivery 快照运行 production bundle、Host HTTP API、control plane、真实本地 Stage 与 Commit 路径，以及仅替代外部 GitHub 与 Push 的 fake。它覆盖 Commit、一次可恢复 Push、PR 创建、带 confirmed raw review 的 In review、独立归因的人工验收、可恢复 Done 与 Issue close，以及不增加 Attention queue 或 generic Signal 聚合的不可变 Milestone Release Evidence。

## 后果

Host、GitHub、Work Item 与 Milestone 组合后的 recovery path 可能膨胀成通用 saga 框架。固定 operation family、现有 owner、一个当前 Branch Delivery 聚合与一项相邻 migration，有意牺牲复用性，以换取一条可审计的 version 0.1.0 path。

可变 ref、PR head 与分页 CI 可能在读取之间发生变化。准确 Commit binding、source-specific freshness、mutation-boundary reread 与最后一次匹配 release reread 会缩小已接受的 race window，但存在争议的外部 state 仍可能停在 conflict 或 reconciliation，而不是优先保障 availability。

仓库控制的 Git 配置、钩子、transport、提示词或 credential output 可能逸出预期 Host trust boundary。除非 Local Host 能够建立 isolation，并在不暴露字节的前提下使用唯一已配置 system credential helper，否则 Push 保持不可用。

定向 polling 会增加 GitHub API cost，并可能在 rate limit 下延迟 current evidence。把交互刷新限制在 active View、把后台工作限制在持久 pending record、保持 interval 可配置并保留 last-confirmed observation，可以避免第二套后台同步引擎，但也接受可见的 staleness。

固定 release 策略可能不适合后续 multi-repository 或 partial-release workflow。显式 `release-evidence/v1` identifier 允许以后增加策略版本，而无需把首次 release 变成过早的策略 DSL，也不会削弱已经内嵌的 evidence。

已经验收的 Branch Delivery 无法吸收后续 corrective Commit 或 changed PR。这会保留人工实际验收的内容；修正必须成为另行归因的产品工作，而不能静默改变 Done 背后的 evidence。
