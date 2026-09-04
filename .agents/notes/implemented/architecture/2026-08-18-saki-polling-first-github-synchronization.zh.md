# Agent Note: polling-first 分阶段 GitHub 同步

Status: implemented

[English](2026-08-18-saki-polling-first-github-synchronization.md) | 中文

## 问题

Saki 把 GitHub Projects v2 作为共享 Work Item Status 与手动排序的权威来源。然而，直接用分页响应组装 Board 仍可能混合从未同时存在的事实：page cursor 不是变更 offset，GitHub 没有把 Project 级 `updatedAt` 记录为每次 item 或 field-value 变化都会推进的 revision，进程也可能在任意页面后停止。配置还带来第二个原子性问题：新保存的 Project、Repository、field 或 option mapping 必须先由 GitHub 完整确认，才能替换仍然可用的 mapping。

首个版本还需要有用的离线行为。网络、权限、mapping、rate limit、取消或重启失败必须保留最近一次已确认 Board，并暴露安全的恢复 evidence，而不能发布局部候选结果或乐观状态。

## 决策

**把 GitHub transport 与 Saki Board 语义放在不同插件中。** `@breakfastdapaidang/saki-github` 定义品牌化外部标识、严格的原始事实、完整扫描候选结果、类型化失败，以及可替换的 `SakiGitHub` Service。`@breakfastdapaidang/saki-github-app` 提供 Product App 实现。它只在单次 operation 中解析 private key，要求 `local-user-trust`，并创建只包含该 operation 所需准确读取或写入权限的短生命周期 installation token。Installation identity 读取使用 App JWT；Repository access 枚举与 Project 读取使用 installation-wide token，Repository 读取与完整 Board 扫描则把 token 绑定到已配置 Repository。只有 installation-token REST 响应会贡献 installation-token rate observation。Provider 会拒绝意外的 Installation grant、Repository access 或 token scope。控制面拥有配置、mapping、调度、持久发布与产品 Projection。Host API 投影这些结果，但不暴露存储记录或凭据。

**只接纳稳定的完整候选结果。** Product App 会完整枚举 Project field、按顺序排列且包含 archived 与 unarchived 的 item 及其全部 field-value 页面，以及已配置 Repository 中的开放 Issue。每个页面都必须重复并校验所属 Project、Repository 或 item 身份，才能贡献事实。同一 Repository Issue number 只能对应一个 Issue 身份；同一 Issue 身份若同时出现在 Project membership 与开放 Issue 枚举中，必须携带完全相同的事实。每一遍都具有 page、item、field-value、响应、timeout、rate-observation 与并发上限，并要求稳定的前后 Project、Repository 与 connection-count 观察。Installation Repository identity 与 Project field 使用固定的 Service 接纳上限；Provider 可配置的 item 上限只适用于 Project item 与 open Issue。由于这些观察不是已记录的全局 revision，一次 operation 会执行两遍连续的完整扫描。两遍的版本化语义指纹必须一致。指纹包含外部身份与来源 revision、field 与 option 身份、Project membership、Status、archive state、Issue state、API order 与邻居，以及每遍 fence。指纹会排除 Provider timing、rate observation 与只用于展示的值；保留的 Repository、Project、Issue 与 item revision 覆盖会影响 Board 的可变展示事实。两遍不一致就是扫描失败，绝不是候选结果。

Page cursor 与局部数组只存在于一次 operation 内。Service 没有局部结果类型，控制面也会在 mapping 前重新校验每个候选结果。定向 Work Item mutation inspection 仍是独立 operation，不会推进 Board checkpoint。[Branch Delivery 与 Milestone Release Evidence 决策](../feature/2026-08-18-saki-branch-delivery-and-milestone-release-evidence.zh.md)拥有 delivery 专属的 PR、review、CI、Milestone、tag、Release、Commit 与 ancestry 读取，以及限定在 Provider 生命周期内的 pending-record loop；这些读取也绝不推进该 checkpoint。

**通过一个持久 owner 发布配置、Board 与 checkpoint。** 控制面状态版本 4 为每个 Development Project 保存一个 `github_project_sync` aggregate，并保存幂等的 `github_sync_configuration_intents`。配置 Intent 校验 field-scoped patch、expected revision、Actor 与准确外部 id，再保存一份 pending candidate configuration。若 patch 与当前 pending 或 active 配置相同，系统会返回 `configuration-unchanged`，且不分配 revision。保存并不会使已变更配置生效。该配置的首次完整扫描会执行一次 expected-revision update，同时激活配置、发布 confirmed Board、推进本地 generation 与远端指纹、记录 freshness 与 rate evidence，并安排下一次 polling。

同一 Project 的每次持久 scan write 都经同一条逐 Project operation tail 串行。因此，其原子更新 callback 只有一个 writer；control plane 的所有权不变量使这些 callback 中针对并发变化的防御 guard 不可达。

失败或过期的 attempt 会记录一条有界类型化 failure 与重试计划，同时保留此前 active configuration、Board、checkpoint、generation、confirmed time。Attempt id 与 configuration revision 会阻止旧 Provider 结果在替代配置或 lease 之后发布。Aggregate commit 与 saved receipt 是两次独立持久写入。启动时，每个 Project 最多只能存在一个 prepared configuration Intent。若其准确 aggregate commit 已经存在，恢复流程会在重新校验权限前识别该 commit，再完成 saved receipt，而不重复分配 revision；否则，它会把保留的 Intent 继续处理为 conflict、failure 或 saved 结果。随后系统会在其他 effect 前重新校验全部跨记录身份、使残留 in-flight work 过期并请求立即恢复。交互刷新在持久层优先于后台工作，并立即返回当前 Projection；它不会等待网络。

**只映射准确配置的身份。** 已配置 Status field 与全部七个 Status option id 必须仍存在于候选结果。名称可以显示，但绝不用于修复身份。只有已配置 Repository 中的 Issue item 会进入 Board。它们的 GitHub item order 决定邻居；匹配且 archived 的 Issue 变为 Canceled，尚未进入 Project 的开放 Repository Issue 变为 Inbox，并携带明确的非 membership 事实。一个 Issue 对应多个 Project item、重复派生 Work Item identity、跨 Repository 事实或与当前配置不符的 Provider mapping failure 都会使 attempt 无效。Mapping repair 保持只读：Projection 会指出缺失身份，并阻止 Work Item mutation，而不会按名称猜测。

控制面在一个 confirmed Board 中最多持久化并交付 10,000 个 Work Item。完整候选结果派生出的 Board 超过该限制时，系统会记录 `{ kind: 'capacity', resource: 'board-work-items', limit: 10_000, observed }`，保留此前 Board 与 checkpoint，并且绝不截断候选结果。Mapping evidence 另有独立上限，因此失败 attempt 不会通过 failure Projection 重现超大 payload。

**使用一个可恢复 polling Consumer。** 控制面插件可选注入 `ctx.sakiGitHub`；没有 Provider 的现有 composition 仍能加载。Provider 存在时，内含的 Consumer 会处理持久 attempt，只调用 Service，并通过 aggregate owner 发布或记录失败。逐 Project active 与 background interval 以及 background rate reserve 是经过校验的配置字段。Scan-attempt lease lifetime 是经过校验的控制面插件配置。Dispose 会取消 Provider work 并等待 Consumer；任何残留 lease 都可以在到期或重启后恢复。Product App 还会按 installation 串行 API 请求，使 interactive work 优先于 background page，并限制跨 installation 的完整扫描并发数。

Host API 暴露准确的 cached 与 interactive Board query，以及 Project Settings 同步 evidence。Cached 路径是纯持久读取。Interactive 路径只在返回同一个当前状态 schema 前写入 scan request。未配置和已配置 Project 都有明确 Projection state；confirmed Projection 会交叉校验 Project、Repository、configuration revision、checkpoint、generation、Work Item source、failure、mapping、freshness 与 mutation-availability 关系。

[ADR 0013](../../../../docs/adr/0013-polling-first-staged-github-synchronization.zh.md)拥有更广泛的同步协议，包括 mutation recovery 与后续 webhook 行为。已实现的[可恢复 GitHub Work Item mutation](2026-08-16-saki-recoverable-github-work-item-mutations.zh.md)拥有 Create、Move 与定向 Work Item inspection。已实现的 [Branch Delivery 与 Milestone Release Evidence](../feature/2026-08-18-saki-branch-delivery-and-milestone-release-evidence.zh.md)拥有定向 delivery read、当前限定在 Provider 生命周期内的 pending loop，以及 PR delivery mutation。已实现的 [Saki 上游同步](../process/2026-08-15-saki-upstream-synchronization.zh.md)仍是独立的 repository maintenance 工作流。

## 后果

稳定情况下，两遍扫描规则会让完整读取成本翻倍；活跃变化的 Project 也可能需要等下一次 polling 才能让两遍一致。单操作者基础版本接受这项成本，因为它移除了未经记录的全局 revision 假设；经过校验的 interval、rate reserve、priority 与有界 admission 会保护交互工作。0.1.0 不要求 webhook，后续 webhook 最多只能持久请求提前扫描。

10,000 个 Work Item 的限制为持久与 wire 校验成本设定了上限。系统因此放弃为更大 Board 发布新 generation，但类型化失败会保留此前 snapshot，并同时避免静默截断与超大失败 payload。

无 key 测试通过真实 bundle、control plane、Host API、持久重启路径与 snapshot transcript 使用 fake `SakiGitHub` Provider。Transcript 先在 Provider 缺席时证明 `saved`，再 hold 首次扫描以证明 `activating`，随后放行一次完整扫描以证明 `activated`，再用同一 Board 与 checkpoint 重启，并证明类型化 transport failure 会保留两者。Provider 测试以受控 GitHub 响应覆盖真实 Octokit request 边界，包括分页、父身份不匹配、跨表面 Issue 事实分歧、两遍稳定性不匹配、权限、token scope、响应上限与 rate failure。Live Product App smoke 仍是 operator prerequisite，因为 CI 不拥有已安装 App、private key、organization Project 或外部 allowance。

本决策中的 Service mutation declaration map 支持准确的 Issue 创建、Project membership、Status、API position 与 Issue state operation。PR 创建归 [Branch Delivery](../feature/2026-08-18-saki-branch-delivery-and-milestone-release-evidence.zh.md)所有；Contents 与 Workflows write 仍然不存在。Board 绝不从 App installation grant 推断任何 mutation availability。

## 考虑过的方案

**把 Project `updatedAt` 当作全局 fence。** GitHub 记录对象 update field，但不承诺每次 item Status 或 field-value 变化都会推进所属 Project。计数不变的编辑可能通过相等的 Project fence。

**完成一遍遍历后发布。** 即使 membership count 不变，页面之间发生 mutation 仍可能构造 torn candidate。在没有服务端 snapshot token 的情况下，两遍相同的语义遍历是最强的有界验证。

**保存配置时立即激活。** 拼写错误、被删除的 option、不可访问的 Repository 或重建的 Project field 会在替代配置得到证明前丢弃最近一次可用 Board。Pending activation 会让现有配置继续保持权威，直到一次原子成功发布。

**持久化 cursor 或逐页发布。** Cursor 只为一次遍历分页，不能证明移除或较早页面保持不变。持久化 cursor 会把 transport 细节变成错误的恢复 evidence。

**按名称修复 mapping。** 人类可读名称可以重命名，也可以在重建后复用。准确 node id 与未来带归因的 repair Intent 可以避免把 Saki status 静默关联到不同的远端含义。
