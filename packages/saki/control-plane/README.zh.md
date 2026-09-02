# `@breakfastdapaidang/saki-control-plane`

[English](README.md) | 中文

Saki 私有控制面模块拥有本地 Installation 置备、Installation Access、Development Project Registry、可恢复的项目登记与结构化 Git Intent、可恢复且由 GitHub 支持的 `CreateWorkItem` 与 `MoveWorkItem` saga、手动 Give-to-Agent dispatch、持久 Intervention 回答、Principal-scoped My Work 与 Attention，以及持久 GitHub Board 同步。它要求维护层先发布固定且已经验证的 `ctx.sakiInstallationState`，其中包含活跃 Installation 与 storage generation 标识，再注册 `ctx.sakiControlPlane`；调用方使用收窄的 `SakiAccess` 与 `SakiControlPlaneModule` 接口，而不访问存储表。仅供 Host 使用的 `./host` 入口把传输凭据解析为可信的进程内 `SakiAuthenticationContext`，面向浏览器的 `./fixtures` 入口则发布经过脱敏的访问、检查、登记、Project-index、Development-Workspace、Changes、有界 Diff、结构化 Git 操作、Board、Project Settings、Work Item detail 与 Agent Run 状态。

`SAKI_GIT_CHANGES_PROJECTION_FIXTURES` 覆盖干净、已暂存、未暂存、未跟踪、继承、无法归因与冲突状态事实。`SAKI_GIT_DIFF_PROJECTION_FIXTURES` 提供有界成功与观察已陈旧示例；`SAKI_GIT_OPERATION_RESULT_FIXTURES` 提供类型化的成功、冲突、失败、取消与 effect 未知回执。`SAKI_BOARD_PROJECTION_FIXTURES` 覆盖未配置、等待首个 checkpoint、mapping 重验，以及 freshness 已陈旧且带有当前失败证据的已确认视图；`SAKI_BOARD_MUTATION_OVERLAY_FIXTURES` 覆盖 optimistic、targeted-confirmed、conflict、partial-failure、reconciliation 与 repair 状态；`SAKI_WORK_ITEM_RESULT_FIXTURES` 覆盖成功与可恢复回执。`SAKI_PROJECT_SETTINGS_PROJECTION_FIXTURES` 覆盖已保存、激活中与已激活视图。已配置 fixture 把同步与配置 revision、已确认 Board generation、checkpoint、mapping evidence、失败与 freshness evidence、扫描状态、实际 mutation availability 与 mutation overlay 作为一组具有明确关系的示例予以保留。

## 持久记录

版本化的 `control_state` 置备所有者只记录稳定的子记录引用，以及 `provisioning` 或 `ready` 阶段。其 Installation id 必须与维护层验证的活跃 Installation 相同；被中断的置备恢复前也会执行这项校验。`installations`、`hosts`、`principals` 与 `grants` 表按品牌类型 id 保留各自带修订号的实体生命周期和历史。每个当前标识均由类型专属前缀与规范 UUID 文本组成；物理 storage generation 使用 `storage-generation-`。只有精确的 v2 迁移输入会保留历史 `installation-generation-` 字段。Principal 类型采用封闭的 `human | automation` 判别字段。置备流程会创建一名人类 Host Operator，并在每次启动时校验所引用 Principal 的类型；无关的自动化 Principal 是合法记录，但置备流程不会创建自动化 Grant。Installation 只选择当前本地 Saki Host，不拥有 storage generation 的选择权。启动时会先以纯读取方式校验全部置备、访问、Project、Binding 与 Intent 记录；只有完整库存均有效，系统才会协调或恢复任何状态。

保留的迁移链消费精确 B03 v2-v7 状态，并且只生成当前 v8 记录。其中相邻 v5-to-v6 步骤会加入 Work Item Intent 与 targeted-recovery 表。v6-to-v7 步骤会加入空的手动 Agent table，为每个保留 Project 加入一条不含 Model Route 的默认 Agent Profile，向已置备的 Host Operator 授予 Give-to-Agent action，并保留每条既有 write-admission row。v7-to-v8 步骤会显式记录 Assignment owner，增加 waiting 与 resume-pending Run 状态和 Intervention table，并向 Host Operator 授予 answer action。可变的当前 schema 只校验迁移后的 v8 output。

`installation_access` 是一条版本化聚合记录，包含带修订号的 Bootstrap Challenge 与 Browser Session 条目。其 id 在所属 Access id 后追加 `:challenge:<ordinal>` 或 `:session:<ordinal>` 与规范十进制序号。只增不减的挑战序号和会话序号生成确定性条目 id，每个校验摘要都绑定其条目 id。每次成功交换都会执行一次带预期修订号的更新：消费选中的挑战、撤销其他状态为 `issued` 的挑战，并插入恰好一个会话。即使详细终态条目已经清理，该聚合仍保留不可变的首次 bootstrap 完成摘要；清理不会降低两类序号的高水位。

`development_project_registry` 是一条带修订号的聚合记录，包含 Project、Resource Binding、按所属 Host 划分的规范工作树与逐工作树 Git 目录索引，以及已提交的 Intent 映射。`registration_intents` 保留不可变的浏览器确认内容、接受时 Actor 归因、完整登记检查、与阶段对应的 Workspace 证据，以及确定性的回执身份。登记按 Intent id 串行执行，在 dispatch 前持久化 `prepared`，在 Registry 比较并交换前记录可能已发生的 Workspace effect，并能识别先于 Intent 阶段推进而提交的映射。同一 payload 的重放会收敛到同一回执；同一 Host 上的 payload 变化或路径身份重复会产生冲突，且不会复用该回执。不同 Host 上相同的规范路径文本不代表同一资源。

`git_operation_intents` 是 StageFiles、UnstageFiles 与 CreateCommit 共用的持久表。浏览器 payload 只引用观察范围内的 change id 与 fingerprint，不携带路径，并重复其确认过的 Project、Binding revision、status、HEAD、index tree 与 worktree 证据。控制面只有在新鲜且完整的 Host 观察逐项匹配后才会持久化可进入 Host 的 request；可归因的证据或选择不匹配则持久化一条不含 Host request 的终态 conflict，新鲜 baseline 暂时不可用时仍可重试。Detached HEAD 只会给 CreateCommit availability 增加 `detached-head`；除此之外原本 eligible、但没有 staged ordinary change 的 status 会增加 `no-staged-changes`。Inspection、Diff、StageFiles 与 UnstageFiles 仍分别判断 eligibility。完全相同的重放返回同一回执，所有 Control Intent 表共用一个 id 命名空间。

`binding_write_admissions` 为每个 Resource Binding 保存恰好一条默认拒绝的记录。`manual-host-operation` reservation 会在 Host prepare 前记录 Intent source、action 与 Binding revision；`agent-run` reservation 则记录来源 Intent、Agent Run、payload digest 与 Binding revision。accepted row 会固定 effect boundary 使用的 revision。直接 Git operation 在结果已经证明为终态后释放其精确 ownership；已启动 Agent Run 会继续持有 ownership。effect 证据未知或矛盾时进入 `reconciliation-required` 并继续占用 admission。启动时会在恢复当前 owner 前校验全部记录，未知变体与缺失 row 永远不能授权 mutation。

`agent_operation_intents`、`work_assignments`、`work_sessions`、`agent_runs` 与 `execution_dispatches` 拥有手动 Ready-to-Run 路径。提交会重新验证当前 GitHub Issue body 与 branch safety、活动 Binding 与完整 inherited-change baseline、Host Operator authority、验收条件、Blockage 和默认 Agent Profile，随后要求当前 LLM adapter 在持久接受前解析精确的 provider/model route。解析失败会返回 `model-route-unavailable`，不会保留 Agent operation 记录或启动生成。接受 Intent 会固定完整模型可见输入，并在唤醒前预分配每个子记录 identity。短期 Dispatch Claim 会对一次交付进行 fencing；同一个 executor 可以在预期 revision 上续期该 claim，并且等待 Host 工作结束后的最终 acceptance compare-and-set 会要求该精确 claim 仍是当前 claim 且尚未过期。共享 `agent-run` write admission 则拥有生命周期更长的可写 Run。只有 Host 确认精确 Session、Run 与输入 MessageId 后，一条稳定的子 `MoveWorkItem` Intent 才会把 Work Item 移到 In progress。精确 replay 会复用这些记录；未知或冲突 evidence 会停下等待对账。恢复原理由[手动 dispatch 决策](../../../.agents/notes/implemented/feature/2026-08-18-saki-manual-give-to-agent-dispatch.zh.md)说明。

`intervention_requests` 拥有可在重启后恢复的 Development Agent 问题及其首个已接受回答。Saki 工具会在结束提问轮次之前提交 `opening`；精确 Session evidence 会先把所属 Run 改为带有一个 blocker 的 `waiting`，随后请求才变成 `open`。`answer-intervention` 使用请求 revision 及当前 Principal、Grant、Assignment、Session、Binding 与 write-admission 事实选定一个回答，随后为同一个 Run 与物理 Session 创建一条携带稳定回答 MessageId 的新有序 Dispatch。只有 Local Host flush 并确认该输入后才会清除 blocker。My Work 与 Attention 直接从当前 owner record 派生，不存在 inbox table 或全局 revision；本地可用 eligibility 可以生成一个候选 Action Offer，但提交仍会重新检查 live authority 与 operation condition。写入与恢复顺序的理由由[持久 Intervention 决策](../../../.agents/notes/implemented/feature/2026-08-18-saki-durable-intervention-answer.zh.md)说明。

启动流程会先根据精确的 succeeded Host Operation 与物理 Session evidence 恢复每个已经过交叉验证的 running Agent，随后才协调保留的手动 Intent、opening Intervention、已接受回答，或进入 ready。在 acceptance 前取消会记录 canceled Dispatch；acceptance 后取消会保留 accepted receipt 与终态 Host snapshot。live Agent disposal 必须成功，之后子记录取消与 write-admission release 才能持久化。合法的终态与 Intervention 多记录前缀保持单调，重启会幂等完成这些前缀。

每次被接受的检查都包含面向浏览器的安全 Git 事实和继承变更 baseline；其中明文路径与文件内容会替换为精确摘要和有界元数据。采集时间与耗时仍作为证据保留，但不会造成 baseline 身份漂移。每次执行 Workspace 列举、创建或恢复前，控制面都会把保留的规范 worktree 路径作为不可信 locator 交给新的 Host 检查，并比较所需的 Git、规范路径、Git 管理目录文件系统对象与 Workspace 证据。因此，在同一路径替换 clone 或 Git 管理目录会使 Binding 进入 `repair-required`；先前保留的 Projection 或可信路径观察本身绝不授权后续 effect。

`github_project_sync` 是每个 Development Project 一条带 revision 的 aggregate。它拥有 pending 与 active GitHub 同步配置、下一条持久扫描请求或 in-flight lease、最近一次 confirmed Board 与 GitHub Sync Checkpoint、有界 failure 与 rate evidence，以及单调递增的本地扫描 generation。`github_sync_configuration_intents` 保存带 Actor 归因与准确 changed-field evidence 的幂等 field-scoped 配置变更。若 patch 解析后与当前 pending 或 active 配置相同，系统会返回 `configuration-unchanged`，而不会分配 candidate 或 synchronization revision。保存已变更配置只会使它进入 pending；只有完整且经过校验的 GitHub 扫描才会在同一次 expected-revision update 中激活配置并发布 Board 与 checkpoint。一次发布最多接纳 10,000 个 Work Item；更大的完整候选结果会记录带固定上限与观察数量的类型化容量失败，不会发布或截断。任何局部、不稳定、超限、已取消、权限、mapping、rate-limit、transport 或过期 attempt 都会保留此前 active configuration 与 confirmed publication。启动时会在 effect 前校验每项身份关系、使残留 attempt 过期并请求立即恢复。

`github_work_item_intents` 把经过 Actor 归因的 `CreateWorkItem` 与 `MoveWorkItem` request 持久化为分阶段 saga。每个外部阶段都会在 Provider dispatch 前持久 prepare，并通过 targeted inspection 解析结果；Provider 绝不在内部重试，控制面也只有在 inspection 证明准确 effect 前状态后才会再次提交 request。完全相同的 Intent 重放返回已有回执，系统仅在完整状态校验后恢复非终态 saga，effect 未知证据也不会触发盲目重试。`github_work_item_recovery` 为每个限定在 Project 内的 Work Item 保留一项 confirmed targeted observation 与最近非终态 Status；这些证据驱动本地 Board overlay，但不会发布或推进完整 Board checkpoint。

Board mapping 只使用已配置的 GitHub node id。已配置 Repository 中匹配的 Issue item 按 GitHub Project API order 排列；archived item 变为 Canceled，尚未进入 Project 的开放 Repository Issue 变为 Inbox，并带有明确的非 membership evidence。其他 Repository、pull request、draft item、redacted item、重复 Issue membership、重复派生 Work Item id 与畸形 Provider 关系绝不会进入 confirmed Board。Status field 或 option 缺失时进入可见 mapping repair，不会按名称猜测。每个 confirmed item 都携带 `latestNonTerminalStatus`：非终态 item 记录其当前 Status，Done 或 Canceled 则保留最近已知的非终态 Status；未知时为 `null`。后续完整扫描会合入更新且身份匹配的 targeted-recovery 记忆。关闭的 Issue 仍处于非终态时，Board 派生 `external-close` repair；开放、未 archived 的 Issue 仍处于终态时，则派生 `external-reopen` repair。这些 overlay 建议执行带 Actor 归因的 `MoveWorkItem`，目标为 Done 或已记忆的非终态 Status；没有记忆时回退到 Backlog，但绝不会自动修改 GitHub。

只有经过域分离的 bootstrap 哈希摘要与 Cookie 哈希摘要会持久化。原始 bootstrap 机密值、原始 Cookie 凭据、派生请求令牌和独立的请求防伪机密值都不会进入存储。Bootstrap Challenge 与 Browser Session 条目的终态转换保持单调，且只有经过 `terminalRetentionMs` 后才会删除。

## 访问与控制操作

`SakiAccess` 读取封闭的 Access Projection、交换启动器机密值，并登出当前 Browser Session。Bootstrap 与登出只能修改 Installation Access。主模块暴露稳定的 Installation 与 Host 身份标识；只读的项目选择检查、Project-index、Development-Workspace、Changes、Diff、Board、Project Settings、My Work 与 Attention 查询；持久化的 `register-development-project`、`configure-github-synchronization`、StageFiles、UnstageFiles、CreateCommit、`CreateWorkItem`、`MoveWorkItem`、`give-work-item-to-agent` 与 `answer-intervention` Intent；以及提交后的 Projection 失效通知。Changes 只发布仓库级 eligibility 与封闭原因，不替浏览器选择文件；每次 StageFiles 或 UnstageFiles 提交都携带自己的 selection，并用新鲜观察重新校验。Cached Board query 与两项 Principal-scoped work query 都是纯持久读取。Interactive Board query 会持久请求一条高优先级扫描，并在不等待 GitHub 的情况下返回当前 Projection。仅写入 Intent 阶段不会使 Project 视图失效；Registry、write admission、Host Operation、Work Item、Agent operation、Intervention 或同步更新提交后会使受影响视图失效。一个失效通知 listener 失败时，系统只发出固定且不含凭据的诊断，不会阻止后续 listener 运行；每项注册仍可独立 dispose（资源释放）。

该模块可选消费 `ctx.sakiGitHub`。没有此 Provider 的 composition 仍能加载，并暴露未配置或缓存状态。Provider 存在时，内含 Consumer 会按 interactive-first 顺序处理持久 scan attempt、只通过 aggregate owner 发布完整候选结果、通过 targeted inspection 恢复可恢复的 Work Item saga，并在 dispose 时取消活跃工作并等待完全停稳。同一 Project 的每次 scan write 都通过同一条逐 Project operation tail 串行，因此其原子存储更新只有一个 writer。逐 Project 同步配置拥有 active 与 background polling interval 及 background rate reserve；控制面插件只拥有 attempt lease lifetime。完整发布协议参见 [ADR 0013](../../../docs/adr/0013-polling-first-staged-github-synchronization.zh.md)。

每个受保护操作都会重新解析状态为 `active` 的 Browser Session，并检查其 storage generation id 是否等于 `ctx.sakiInstallationState.storageGenerationId`，同时检查 Principal 生命周期，以及当前 Grant 的 action 与 scope。保留的登记 Actor 可以为历史归因引用更早的合法 storage generation，但只有维护层选择的活跃 storage generation 拥有当前权限。Intent 接受时保留的 Actor 修订号是不可变归因，而不是授权快照：Principal 或 Grant 的良性修订变化不会阻止恢复；退役、storage generation 替换、scope 收窄或撤销会阻止尚未开始的 effect。一旦 Workspace dispatch 可能已经完成，恢复流程可以接纳其精确的持久 Workspace 身份，而不会启动第二次 effect。

Browser Session 只授权结构化 Git Intent 的首次提交。持久恢复与 Host effect-boundary callback 改为根据保留的 Actor，重新校验当前 Installation、storage generation、Host、Principal、Grant action 与 scope，以及精确的目标 Binding。无关 Project 导致的 Registry revision 提升不会撤销已接受操作，但目标 Project 或 Binding 发生变化会撤销授权。Project 登记 acknowledgement 丢失时，启动校验只会针对同一可恢复 Binding 上的 `prepared` Git Intent 暂时容许 write-admission row 缺失，在 Git 恢复前补回该 row；若 Project 恢复推进了 Binding revision，则旧 Intent 会以已证明无副作用的取消结果收口。调用方取消只终止本次尝试，不会虚构持久操作结果；后续 inspect 仍是权威来源。

每次启动具备权限的启动器都会签发新挑战。首次交换完成前，其用途为 `initial-bootstrap`；此后为 `local-reauthentication`。先前尚未过期且状态为 `issued` 的挑战继续有效，直到一次交换以原子方式消费选中的挑战并撤销其余挑战。首次 bootstrap 完成后不会重新开放；Cookie 过期、登出或 `Set-Cookie` 响应丢失后，操作员使用后续启动器提供的新挑战重新登录。本机重新认证建立新会话时不会撤销其他仍然有效的会话，登出也只撤销当前提交的会话。

## 浏览器会话安全

Bootstrap 交换要求准确匹配配置的回环 Origin。配置只接受主机名通过 Connection 共用回环判定函数的规范 HTTP(S) Origin。持久提交成功后，系统只允许通过不透明的一次性 Host 交接发送一条 `HttpOnly; SameSite=Strict; Path=/saki` Cookie 响应头；HTTPS Origin 还会加入 `Secure`。认证会计算浏览器所提供原始 Cookie 的哈希摘要并执行固定时间比较，随后使用带版本且经过域分离的 HMAC，从同一个原始 Cookie 派生请求令牌。此后的每个状态变更请求都要求准确匹配 Origin，并对请求令牌执行固定时间比较。

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| `origin` | 必填 | 不带路径的准确回环 HTTP(S) 浏览器 Origin |
| `challengeTtlMs` | 15 分钟 | Bootstrap Challenge 生命周期 |
| `sessionTtlMs` | 12 小时 | Browser Session 生命周期 |
| `terminalRetentionMs` | 7 天 | 清理终态记录前的最短保留期 |
| `cookieName` | `saki_session` | 仅供 Host 提取 Cookie 的名称 |
| `githubScanAttemptTtlMs` | 5 分钟 | 一次持久完整扫描 lease 的最长生命周期 |

## 模型体验

无，因为该模块只会固定由 Host 拥有的 payload，不注册模型侧工具、prompt section 或 Session event。

#### KV Cache 影响

控制面不会组装 provider request 或可复用 prefix；它会固定 Give-to-Agent 输入与后续 Intervention 回答以供 Local Host 交付，而独立的 Saki Intervention 工具拥有其模型侧投影。Route 预检只解析 adapter metadata，不会发送生成请求；Local Host 会在模型组装前过滤恢复 wake，而已接受的 Intervention 回答是既有 Session prefix 之后仅追加的输入。

## 已知限制与暂缓事项

- **只支持一个本地 Host Operator**：尚未实现 GitHub 登录、组织成员关系、多用户、远程 Host 或非回环部署。
- **只支持显式 operation**：尚未实现 Resource Binding 重绑定与退役、自动领取、仓库或 Board 自动变更、mapping repair、reconciliation repair 与 inherited-change 人工接管。StageFiles、UnstageFiles、CreateCommit、`CreateWorkItem`、`MoveWorkItem` 与 Give-to-Agent 都是显式操作员 Intent；repair overlay 不会自动执行它们，浏览器输入也不能指定仓库路径或 Provider 拥有的 GitHub target id。预期 revision CAS 的失败方会保留已创建或接纳的可复用 DSH Workspace，而不创建 Saki Project 或 Resource Binding；控制面不会删除本次登记可能并非独占的 Workspace。
- **只支持启动器恢复**：本地访问恢复需要重新启动具备权限的启动器，不提供只依赖浏览器的凭据恢复流程。
- **Detail Projection 仍只提供 fixture**：My Work 与 Attention 可以查询，但 Work Item detail 与当前/最近 Agent Run contract 仍只有面向浏览器的 fixture，没有控制面 query 或 view builder。
- **只解析精确 route**：手动 Give-to-Agent 会验证当前 LLM runtime、已登记的 provider adapter 与精确 model metadata，但不会启动生成。它不会建立生产 provider authorization，也不会验证 credential availability、quota 或 account health。
