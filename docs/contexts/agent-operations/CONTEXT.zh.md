# Agent Operations

[English](CONTEXT.md) | 中文

Agent Operations 定义一个 Saki Installation 如何指挥已登记 Host，以及 Saki 如何命名持久 Agent 主体、可复用执行配置、单次尝试和输入事实。

## 语言

**Saki Installation**：一个活动 Saki 控制面的稳定、可迁移身份与产品命名空间。它可以登记多个 Saki Host，但既不是机器也不是 Host；0.1.0 只允许一个活动写入者。_避免_：Saki Host、进程、部署

**Saki Host**：具有稳定 Host identity、信任状态、可重新验证的 capability inventory，并拥有机器本地资源与凭据解析的已登记执行节点。Local Host 可以和控制面共享进程，但不会因此成为 Saki Installation。_避免_：Saki Installation、浏览器 client、Workspace

**Resource Binding**：从 Project 到具名 Saki Host 上一项资源的稳定关联。其带 revision locator 与健康观察可以通过 rebind 改变，而其身份拥有 execution reference 与 lease。_避免_：路径、DSH Workspace、Execution Lease

**Installation State Generation**：Saki 自有 Installation 状态的一份完整、带版本副本。恰好一个 generation 被选为活动且可写；candidate、保留 generation 与 Recovery Backup 都不会因为文件名或较新时间戳而自动成为活动状态。_避免_：数据库版本、backup

**Recovery Backup**：一份 Installation State Generation 与兼容 Saki build 的精确本地回滚 artifact。它不承诺能够迁移到替换 Host。_避免_：Installation Export、snapshot

**Installation Export**：由声明的 Saki 自有状态与显式包含的可迁移依赖组成的加密、带版本可迁移 archive。Restore 会校验并重新绑定它，而不会把复制的本地路径、凭据或 process 当作 Host 权限。_避免_：Recovery Backup、数据目录副本

**Principal**：可以认证并接收 Grant 的持久 Saki 安全主体。人类、持久 Agent Identity 或 Project 自动化身份可以支撑 Principal；Web session、Host 或提供方凭据不能。_避免_：Actor、账号、session

**Grant**：签发给 Principal 的版本化权限记录，限定具名操作、资源范围和委派上限。它建立安全上限，不是触发或证据规则。_避免_：Automation Policy、凭据、角色

**Actor**：已接受操作的不可变归因，根据当时已认证 Principal、委派和 Grant 事实派生。它解释谁代表谁行使权限，既不用于认证，也不授予访问。_避免_：Principal、Host Operator、调用方 payload

**Project Automation Principal**：代表一个 Project 自动模式的 Principal，只有同时具备显式 Grant 并满足 Automation Policy 才能行动。它不是 policy 本身，也不是 Host Operator。_避免_：Automation Policy、系统用户

**Automation Policy**：决定自动工作何时可以使用已有 Grant、需要哪些预留与证据，以及何时必须暂停的版本化 Project policy。它不能创建权限。_避免_：Grant、trigger、账号 quota

**Automation Budget Reservation**：在外部 effect 前，为一项已准入自动 operation 持久、幂等分配类型化资源 limit。结果未知时继续保持预留，直到 inspection 或 intervention 完成。_避免_：Usage Snapshot、估算、Grant

**Usage Ledger Entry**：与 evidence 来源关联，对已测、估算、修正、释放或未解决资源用量进行归因的记录。它为自动化记账，但不会成为提供方 balance。_避免_：Usage Snapshot、invoice

**Agent Identity**：可被定址的持久 Agent 主体，可以跨越多次 Execution 拥有持续责任、收件箱、长期记忆和历史。它说明谁持续承担工作，不说明单次尝试如何配置。_避免_：Agent Profile、Agent Session

**Work Assignment**：把 Work Item 的持续责任关联到预期推动它的 human Principal、Agent Identity 或 Project Automation Principal 的持久关系。它既不授予权限，也不启动 Execution。_避免_：Agent Run、Grant

**Agent Profile**：具名、可复用、可版本化的执行配置，声明角色指令、上下文来源、所需工具与权限、模型路由、预算和兼容的触发类型。它说明 Agent Run 如何工作，不说明谁拥有持续责任。_避免_：Agent Identity、Agent Preset

**Execution**：由 Agent、工作流、定时或事件驱动进程完成的一次可追踪尝试。Execution 完成本身不证明已验收或已产生业务结果。_避免_：Work Item、Session

**Agent Run**：由 Agent 执行的 Execution。它记录实际 Agent Profile 版本，并可在工作由持久主体承担时引用 Agent Identity。_避免_：Agent Session、Agent Identity

**Control Intent**：在 Actor 与 Grant 下准入的持久、幂等请求，用于改变 Saki 状态或调用外部工作。它记录请求动作、归因和恢复结果，既不是动作成功的证据，也不是从 Signal 推断出的授权。_避免_：Signal、Execution、Grant

**Execution Dispatch**：根据已接受 Control Intent 产生、要求已登记 Host 创建或恢复一次 Execution 的持久命令。它记录交付与恢复状态，不证明 Execution 成功。_避免_：Control Intent、Agent Run

**Dispatch Claim**：允许一个当前执行器协调 Execution Dispatch 的 Host admission 的有界、带 revision 与 fencing 的 claim。它不提供 exactly-once 保证，也不授予 Resource Binding 访问权。_避免_：Execution Lease、Work Assignment

**Host Operation**：Host 为一条 Execution Dispatch 拥有的持久 admission 记录。它在产生外部副作用前把稳定 dispatch identity 绑定到目标 Execution，并提供幂等 inspection 与 cancellation reference；它不是 Execution outcome。_避免_：Execution Dispatch、Agent Run、进程

**Execution Lease**：授予一个 Agent Run 对 Resource Binding 写入权的持久声明。一个 binding 最多由一个活动可写 Agent Run 持有 Lease；只读 Session 不需要 Lease。_避免_：进程锁、Agent Run

**Intervention Request**：要求具名对象提供输入、审批、凭据授权、验收或恢复操作的持久、可寻址请求。系统单独记录回答的归因，而且回答不能扩大响应者的 Grant。_避免_：实时问题、通知

**Attention Inbox**：面向一个 Principal 或 Agent Identity，投影尚未解决的 Work Assignment、Intervention Request、恢复状态和相关 Signal。它既不拥有这些事实，也不充当执行队列。_避免_：Work Management Inbox、mailbox、queue

**Project Coordinator**：由 Agent Identity 承担的 Project 角色，负责跨 Work Item 路由和监督工作。它的责任跨越可替换的 Coordination Session 持续存在。_避免_：主 Session、项目 Session

**Coordination Session**：Project Coordinator 用于规划、委派和跟进 Project 工作的可替换 Session。它不拥有 Project 状态或持续责任。_避免_：Agent Identity、永久 Session

**Work Session**：围绕一个 Work Item 的持久、用户可见协作会话。一个 Work Item 可以有多个 Work Session，但最多把其中一个指定为主要会话；每个会话都跨 Agent Run 和协调者替换保持可寻址，并保留参与者来源。_避免_：Agent Run、subagent

**Signal**：由人、机器或 Agent 产生的带来源时点事实。Signal 提供信息，但不授予执行权限。_避免_：Work Item、命令

**Event Subscription**：Project 用于选择外部事件并把它们规范化为带来源 Signal 的持久订阅。Automation Policy 决定这些 Signal 产生的效果。_避免_：定时任务、Automation Policy
