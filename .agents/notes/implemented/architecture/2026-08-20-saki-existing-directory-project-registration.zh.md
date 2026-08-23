# Agent Note: Saki 已有目录 Project 登记与控制域 v2 恢复

Status: implemented

[English](2026-08-20-saki-existing-directory-project-registration.md) | 中文

## 问题

本地 bootstrap 会建立已认证 Host Operator，但不会标识 Development Project。首次登记必须接受已有 Git worktree，不能把浏览器提供的路径当作权限依据；必须暴露足够证据供用户确认，同时不泄漏 Host 路径或变更文件内容；还必须在提交 Project 记录前创建或接纳 DSH Workspace。Workspace 创建与控制面存储无法加入同一事务，因此进程终止或响应丢失后，重试不得创建第二个 Workspace、Project、Resource Binding 或回执。

## 决定

**把 Host Execution 限制为只读的专用检查。** `ctx.sakiHostExecution` 只暴露 `inspectProjectSelection(request, signal)`。请求指定一个已登记 Saki Host，并携带不可信目录 locator。Local Host 提供方会先从文件系统控制文件发现 ordinary、linked 或 detached，以及本地 separate Git directory 拓扑，再运行 repository-aware Git。它会把已准入 config、启用的 `config.worktree`、HEAD、当前 ref、index，以及 repository-local exclude 与 attribute 文件复制到私有控制目录；显式 `git config --file ... --no-includes` 查询负责审计复制配置，随后封闭的只读 argv 集合使 repository-aware Git 在该轮观察中不会重新打开 source config、HEAD 或 index。Repository 与 worktree scope 的 include 指令都会闭合失败且永远不会被跟随，`core.fsmonitor` 则必须缺失或明确为 false。Source object alternate 会闭合失败；私有视图仅生成一条指向已准入 live source object database 的 alternate。只有两次独立采集且各自有效的观察及其 source-control manifest 一致时，提供方才接受成功结果；这会检测已观察到的变化，但不声称阻止每个瞬时同用户竞态。直接 reparse locator，以及最终 Git marker、管理目录、控制文件、对象目录与配置 worktree 会被拒绝；当前 FileSystem capability 无法证明每个祖先 component 都经过 no-follow 遍历。只有证明规范化 containment 后，才接受位于 Git 顶层目录之下的 locator；返回的 worktree 与 Workspace 证据都使用该顶层目录。Projection 包含经过净化的 Git 事实、安全 remote 可提供时小写、排序并去重的公共 GitHub repository 候选、带 revision 的指纹，以及准确的 raw-byte 继承变更 baseline；其中路径与内容材料只保留为摘要和有界元数据。候选项用于支持确认，不会绑定 repository 或提供授权。干净的零条目 baseline 属于完整结果；不可用 baseline 只带有界原因，不包含部分条目或伪造的完整摘要。本次实现会观察已初始化 gitlink 的嵌套 HEAD，但不会观察嵌套的 staged、unstaged 或 untracked 成员，因此每个已初始化 gitlink 都属于 conversion-ambiguous，并阻止自动修改。可信观察包含规范路径，以及每 worktree 与 common Git 管理目录的不透明同 Host 身份；保留的身份、路径或先前 Projection 绝不授权后续 effect。

**在控制域 version 2 中增加第一版 Project Registry，但不声称实现更广的 binding 生命周期。** `saki_control_plane` domain 的 version 2 增加 `schemaVersion: 1`、带 revision 的 `development_project_registry` 聚合记录，以及按 id 索引的 `registration_intents`。Registry 包含 Development Project、Resource Binding、按 Host 限定的规范 worktree 与每 worktree Git 目录索引，以及已提交 Intent 映射。Project、Binding 与 Workspace 各自拥有独立稳定 id；规范路径仍是带 revision 的观察，不是产品身份。登记 Intent 保留不可变请求、服务端派生的 Actor 与 Grant revision、完整的已接受检查、与阶段对应的 Workspace 证据、确定性回执 id，以及所有已提交身份。同一 Host 上重复使用规范 worktree 或每 worktree Git 目录会产生冲突；保留的管理目录身份会阻止把同一路径上的替换 repository 当作原 Binding，而 common Git directory 只对 linked worktree 分组，不会折叠它们。

**在可能发生的 Workspace effect 前持久化，并通过观察恢复。** 新的 `register-development-project` 提交必须在新鲜 Host 检查下匹配浏览器确认的指纹和 baseline，并匹配当前 Registry revision。控制面根据状态为 `active` 的 Browser Session 与当前 Grant 派生 Actor，写入 `prepared`，推进到 `workspace-dispatching`，并在可能调用 `WorkspaceRegistry.create` 前把保留的规范 worktree 路径作为不可信 locator 重新检查。它把准确 Workspace 记录为 `workspace-observed`，再通过比较并设置把 Project、Binding、路径索引与 Intent 映射提交到一个 Registry revision，记录 `registry-committed`，最后记录 `confirmed`。如果该比较并设置失败，Intent 会进入 `conflict`，而已创建或接纳的 Workspace 会保持登记状态以供复用；控制面不会删除本次登记可能并非独占的 Workspace。Host 或 Workspace 调用绝不在 `storageDomain` update callback 内运行。

进程内会按 Intent id 串行执行，每次持久阶段变化还会检查预期 Intent revision 与 phase。准确重放从已存阶段继续，并收敛到同一个确定性回执和已提交身份；用变化后的内容重用 id 会产生冲突。如果 Workspace 创建可能已经成功但确认丢失，恢复流程会把保留的规范 worktree 路径作为不可信 locator 重新检查，并且只接纳 id 与路径都匹配所保留证据的唯一 Workspace。开始新 effect 前必须具备当前权限。因此，Principal 退役、Installation State Generation 替换、Grant 撤销或 scope 收窄会阻止尚未 dispatch 的工作；dispatch 后恢复可以检查并接纳准确的可能结果，但不会启动第二次 effect。

启动时会在任何修复写入或外部调用前，解析并交叉校验完整的置备、访问、Registry、Binding、索引、映射与 Intent 库存。只有完成这项纯校验后，系统才继续非终态登记；它可以识别 Registry 映射先于 Intent phase 推进而提交的情况，并通过新鲜 Host 检查刷新每项已提交 Binding。暂时不可用的检查会让 Intent 保持可恢复；身份变化或矛盾 Workspace 证据进入 `reconciliation-required`；预期 revision 或重复身份失败进入 `conflict`；dispatch 前失去当前权限进入 `failure`。回执只暴露对其 `prepared`、`confirmed`、`conflict`、`failure` 或 `reconciliation-required` 状态有效的字段。

本决定只实现更广的[控制面能力 seam](../../proposed/architecture/2026-08-18-saki-control-plane-capability-seams.md)、[稳定 Resource Binding](../../proposed/architecture/2026-08-18-saki-stable-resource-bindings.md)与[可恢复 Control Intent](../../proposed/architecture/2026-08-18-saki-recoverable-control-intents.md)提案中的 Host 检查与首次登记子集。这三篇 Agent Note 保持 proposed，因为其他三项能力 seam、重绑定、退役、repair、Execution Lease、后继 Session、通用外部 dispatch、补偿和其他 Intent 家族尚未实现。

## 验证

Host Execution 约定测试固定严格的安全与可信 schema、raw-byte baseline 完整性、恶意路径拒绝、双观察稳定性、取消、边界，以及不存在修改占位接口。Local provider 测试覆盖 ordinary、linked、detached 与 separate Git directory repository，common 与 worktree-specific config 优先级，只使用私有控制数据的 repository Git，直接 reparse 拒绝，source config 与 checkout 竞态，SHA-256 object，明确拒绝非 files ref storage，source object alternate 拒绝，以及所需 shared index 位于私有视图之外时的 split-index 失败。控制面测试在每个持久登记转换处注入中断，包括 Workspace effect 可能发生的窗口，以及 Registry 已提交但 Intent 尚未推进的窗口；随后重新打开存储，并验证结果稳定且没有重复 effect。测试还覆盖准确重放、payload 变化冲突、路径索引冲突、恶意持久记录、effect 前的当前 Grant 检查、dispatch 后撤销恢复、Projection 失效和与阶段匹配的回执。组装后的源码与普通 Node 组合包场景会登记一个真实临时 Git 仓库，使用同一个 SQLite 数据库重启，重放同一个 Intent，并验证 Project、Binding 与 Workspace 身份稳定，且 transcript（文本记录）不包含路径、凭据或原始继承变更值。

## 已考虑的替代方案

**把浏览器 locator 或返回的可信路径作为权限依据。** 陈旧或被替换的路径可能在没有当前 Host 观察时授权后续 Workspace effect，而且规范 Host 路径会泄漏到浏览器状态。

**让 repository-aware Git 直接读取 source 管理文件。** Repository 自己控制的 config、HEAD、index 或 linked-worktree 控制文件可能在命令间变化，或启用 repository 指定的行为。私有控制快照把 Git 收窄到已准入的准确文件，同时让 worktree 与 object database 保持 live data。

**复制完整 worktree 与 object database，或强制使用操作系统隔离。** 前者提供更强的不可变边界，后者提供进程级边界，但会把有界本地检查变成可能达到 repository 规模的复制或平台 sandbox。0.1.0 对不支持的控制布局闭合失败，并明确记录仍然存在的 live-data 与同用户竞态限制。

**创建 Workspace 后只写一条最终 Registry 记录。** 创建后发生崩溃或确认丢失时，没有持久阶段能指示恢复流程应在重试前检查并接纳可能存在的 Workspace。

**在存储 update callback 内创建 Workspace。** Callback 可能重试，并且只拥有一条本地记录更新；把外部 effect 放入其中，既不能让 effect 加入事务，也不能保证安全重放。

**使用路径或 Workspace id 作为 Project 与 Binding 身份。** 路径可能移动或出现别名，而 Workspace 身份归 DSH 所有。独立的 Project 与 Resource Binding id 可以在观察和 Workspace 关联按所属记录演进时保持产品引用稳定。

**在首个切片中实现完整 Resource Binding 与通用 Control Intent 设计。** 重绑定、退役、lease、dispatch 与补偿需要额外 Consumer 和生命周期证据。在这些使用方出现前增加方法或状态，会让规划语义看起来已经受到支持。

## 后果

已认证 Host Operator 可以检查一个已有本地 Git worktree、确认其有界检查证据、只登记一次，并在重启后读取带 revision 的 Project-index 与 Development-Workspace Projection。恢复机制增加了持久中间记录与重复 Host 检查，但它会隔离歧义结果，而不是猜测外部 effect 已失败。因此，预期 revision 的失败方可能留下没有对应 Saki Project 或 Resource Binding 的可复用 DSH Workspace；该可复用登记的 repair 与清理不在本切片范围内。登记把调用方 locator 作为不可变重放内容保存，并把可信观察作为私有控制面恢复证据保存；浏览器响应、诊断与快照只暴露经过净化或规范化的值。

操作集保持有意收窄。它不会创建或移动 repository、重绑定或退役 Resource Binding、启动 Agent Run、修改 Git，或解决进入 reconciliation-required 的登记。这些能力必须先具备各自的权限检查、持久证据与已实现 Agent Note，才能扩展本服务。
