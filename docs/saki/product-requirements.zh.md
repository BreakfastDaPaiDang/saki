# Saki 产品需求

[English](product-requirements.md) | 中文

状态：草稿，供产品定位、核心抽象和阶段边界评审。版本实现范围由独立规格承载。

## 产品定位

Saki 是建立在 DeepSeek Harness（DSH）之上的 Agent 原生项目操作系统。它把目标、工作、资源、Agent 执行、自动化和结果证据组织成可以持续运行的 Project，使个人能够先管理软件开发，再管理业务系统，最终与组织成员共同使用一套工作系统。

Saki 不以复制传统 IDE、项目管理工具或聊天机器人为目标。它提供这些工具之间缺少的产品内核：一个 Work Item 能够进入正确 Project，在合适的 Host 上获得资源和权限，触发可追踪的 Execution，并以可验证的 Outcome Evidence 回到工作状态、里程碑和业务结果。

## 问题

Agent 开发分散在多个编辑器窗口、独立对话、终端、GitHub 页面和本地目录中。项目与 Session 没有稳定关系，Issue 和看板不能可靠启动 Agent，代码结果也不会自然回到 PR、CI、Milestone 和 Release。项目越多，寻找上下文、手工同步状态和恢复中断工作的成本越高。

软件交付以后仍然是一个需要管理的业务系统。机器人、内容流水线、定时工具、服务、数据库和外部平台各有日志、凭据、任务与部署入口，但它们缺少统一的项目视图、可观测状态和 Agent 操作入口。

多人协作进一步引入身份、授权、个人与公共空间、共享执行资源和审计问题。直接把单用户主机暴露给其他人既不安全，也无法建立清楚的工作归属。

## 产品内核

Saki 把 Project 视为可运行、可观察、可迁移的管理单元，而不是文件夹、仓库或看板的别名。

### Project

围绕一个持续目标组织工作、资源、自动化和结果的持久范围。Project 通过不同能力组合形成 Development Project、Managed System 或后续类型，而不是为每种业务复制一套产品内核。

### Resource Binding

Project 与外部或本地资源之间稳定、可重新验证的关联。资源可以是 Workspace、Git worktree、GitHub Repository、GitHub Project、部署环境、服务、数据库、消息频道或专用工具。Saki 保存身份、所属 Host、带 revision locator、健康状态和访问方式，不复制资源自身拥有的完整数据；位置迁移改变观察，不改变 binding 的历史身份。

### Principal

可以认证并接收 Grant 的持久 Saki 安全主体。人类用户、持久 Agent Identity 和 Project 自动化可以拥有 Principal identity；浏览器 session、Host 和外部凭据保持独立。

### Grant

签发给 Principal 的版本化权限记录，限定具名操作、资源范围、有效期和委派上限。Grant 定义安全上限，不决定何时运行工作。

### Actor

Saki 接受 Control Intent 时派生的不可变归因，记录哪个 Principal 代表谁、通过哪些 Grant 版本行使权限。Actor 是历史解释，不是身份或权限来源。

### Agent Identity

可被指派长期职责、接收后续工作并跨越多次 Execution 保持连续历史的持久 Agent 主体。Agent Identity 可以拥有 Attention Inbox、职责范围和长期记忆，但不决定某次工作的具体配置或运行位置。

### Agent Profile

Project 中一种具名、可复用、可版本化的 Agent 执行配置。Agent Profile 声明角色指令、上下文来源、所需工具与权限、模型路线、预算和允许响应的触发类型；它决定 Agent 如何工作，不承担长期责任归属。每次 Agent Run 记录实际使用的 Profile 版本。

### Work Item

具有明确结果和验收条件的一项预期工作。Work Item 的共享载体可以来自 GitHub Issue 或后续业务系统，但 Saki 使用统一的 Work Item Status、Blockage 和 Milestone 语义组织它。

### Work Assignment

把 Work Item 的持续责任关联到预期推动它的 human Principal、Agent Identity 或 Project Automation Principal 的持久关系。Assignment 不授予权限，也不启动 Execution。

### Work Session

围绕一个 Work Item 的持久、用户可见协作会话。它在多次执行尝试和协调者替换之间保留人和 Agent 各自带来源的参与记录；一个 Work Item 可以有多个 Work Session，但最多把其中一个指定为主要会话。

### Execution

由 Agent、工作流或定时任务执行的一次可追踪尝试。Agent Run 是第一种 Execution；后续可以增加 Scheduled Run、Event-triggered Run 和分布式 Run。Execution 与 Work Item Status 分离，成功退出不等于工作已经验收。

### Execution Dispatch

根据已接受 Control Intent 产生、要求已登记 Host 创建或恢复一次 Execution 的持久命令。系统通过有界 Dispatch Claim 和一条幂等 Host Operation，把重复交付指向同一目标 Execution；交付状态不证明 Execution 成功。

### Host Operation

Host 为一条 Execution Dispatch 拥有的持久 admission 与 inspection 记录。它在产生外部副作用前把稳定 dispatch identity 绑定到目标 Execution，使重复交付找到同一 operation；它既不是 Control Intent，也不是 Execution 成功的证据。

### Outcome Evidence

证明 Work Item 验收条件或业务结果是否满足的可定位事实，例如 Diff、测试结果、Commit、PR、CI、Release、部署状态、日志或业务指标。自动完成必须依据 Outcome Evidence，而不是 Agent 的成功自报。

### Automation Policy

Project 对触发条件、类型化资源限制、并发、暂停条件、交付操作和自动完成证据的版本化配置。它决定 Project Automation Principal 何时可以使用 Grant 已提供的权限，但不能自行创造权限。自动 effect 会在 dispatch 前预留适用预算，并在之后结算带归因用量。未知提供方全局用量遵循明确的暂停或 local-limits-only 规则，而不会变成零或无限。自动化程度是每个 Project 的显式选择，不是隐藏的全局开关。

### Automation Budget Reservation

在外部 effect 前，为一项自动 operation 持久、幂等分配类型化 limit。它把 policy revision 与 Actor 关联到受影响 Project、Work Item、Execution、provider profile 和 Host Operation；已确认用量会结算它，已确认不存在会释放它，未知结果会让它继续保持预留并等待协调。

### Usage Ledger Entry

与支持它的外部 evidence 关联的一条带归因测量、估算、修正、释放或未解决金额。Ledger entry 让 Saki 解释并执行自动资源使用，但不会假装拥有提供方订阅 balance 或账单。

### Signal

由人、机器或 Agent 产生的带来源时点事实，例如人工指派、定时到期、状态告警、外部事件、Work Item 变化、Agent 交接或 Execution 结果。Event Subscription 把符合条件的外部事件规范化为 Signal；Signal 本身只提供信息，不授予执行权限。

### Event Subscription

Project 对外部事件源的持久订阅，声明来源、过滤条件、去重和生成 Signal 的归属。它不直接启动 Agent，Automation Policy 决定 Signal 是更新状态、通知人、追加已有工作、创建 Work Item 还是启动 Execution。

### Intervention Request

要求具名人类或后续 Agent Identity 提供输入、审批、凭据授权、验收、冲突解决或恢复操作的持久请求。系统单独记录回答的归因，回答不能扩大 Grant，而且请求可独立于发起它的实时进程或 model turn 接受回答。

### Attention Inbox

面向一个 Principal 或 Agent Identity，投影尚未解决的 Work Assignment、Intervention Request、恢复状态和选定 Signal。它既不拥有这些事实，也不充当执行队列，并且不同于名为 Inbox 的 Work Item Status。

### View

针对同一 Project 数据提供不同信息密度和操作方式的投影。Board、Milestone View、Development Workspace、Operations Cockpit、操作者控制台和 Attention Inbox 可以服务不同判断与偏好，但不成为新的权威数据源。

### Saki Installation

一个活动 Saki 控制面的稳定、可迁移身份与产品命名空间。Installation 拥有可迁移的产品状态与 policy，并可登记多个 Saki Host；它不是当前运行它的机器或进程。

### Saki Host

具有稳定身份和可重新验证 capability inventory 的已登记执行节点。它拥有机器本地文件、进程、capability Provider、凭据解析和执行资源。一个 Project 可以逐步绑定多个 Host 上的资源，但资源位置和执行归属必须始终可见。

### Installation State Generation

Saki 自有 Installation 状态的一份完整、带版本副本。一个 generation 处于活动且可写状态；升级 candidate 与保留 generation 保持关闭，直到显式维护 operation 选择或删除它们。

### Recovery Backup

一份 Installation State Generation 与兼容 Saki build 的精确本地回滚 artifact。它保护升级回滚点，但不是可迁移 Host transfer 格式。

### Installation Export

由声明的 Installation 记录与依赖组成的加密、带版本可迁移 archive。它保留产品身份与关系，但 restore 后仍要求重新绑定 Host 资源与凭据，并对账未解决 operation。

核心关系为：`Saki Installation -> Installation State Generation`、`Project -> Work Item -> Execution -> Outcome Evidence`、`Work Item -> Work Assignment`、`Work Item -> Work Session -> Agent Run`、`Control Intent -> Execution Dispatch -> Host Operation -> Execution`、`Automation Policy -> Automation Budget Reservation -> Usage Ledger Entry`、`Project -> Agent Identity -> Agent Run -> Outcome Evidence`，以及 `Principal -> Grant -> Actor -> Control Intent`。Work Session 组织 Agent 工作中带来源的协作，但不排除非 Agent Execution。Agent Identity 是可选的长期责任主体，每次 Agent Run 必须固化它实际使用的 Agent Profile 版本。Resource Binding 定位 Project 能访问什么，Grant 限制谁可以操作它，Signal 提供变化事实，Automation Policy 决定何时具备执行资格并受到哪些限制，Intervention Request 持久保存所需回答，Attention Inbox 投影未解决工作，View 决定人如何观察和干预。

## 模型供应与上下文生命周期

Saki 把模型访问视为执行供应，不把它当作 Work Item 属性。Agent Profile 可以请求 Model Route，但每次 Execution 都记录实际解析得到的提供方、模型、推理配置和 Provider Account Profile。Provider Account Profile 暴露认证、能力、健康和带来源的 Usage Snapshot，而不把原始凭据复制进 Project 或 Session 记录。

Context Capacity、Runtime Context Limit 和 Context Policy 保持为三个独立事实。模型声明 Context Capacity；产品界面、订阅或账号可以开放更低的 Runtime Context Limit；可版本化的 Context Policy 选择更低的压缩触发点，以及压缩、裁剪、恢复和观测策略。Saki 不得从其中一项推断另一项，也不得把经过检索的逻辑历史展示成物理模型窗口。

生成式媒体是持久 Project 输出，而不是临时聊天回复。Generation Job 记录其已解析 Model Route、输入、生命周期、输出产物和来源，并可以在 Provider Account Profile 限制内并发运行。[Model Supply 领域词汇](../contexts/model-supply/CONTEXT.md)定义这些术语。

## Agent 协调与工作会话

Project Coordinator 是由 Agent Identity 承担的角色，不是一个永久 Session。它通过可替换的 Coordination Session 委派和监督 Work Item，从持久 Project 状态读取事实，而不把每个子会话的全文都保留在模型上下文中，并且可以在 Session 重启或 Host 迁移后继续协调。

Work Session 是围绕 Work Item 的协作记录，不是固有的 subagent。DSH 可以把它作为顶层 Session 或可继续 subagent 执行，其中工作的 Agent 也可以为有限的内部工作创建一次性或嵌套 subagent。Saki 独立于 DSH 父子谱系保存 Work Item 关联、Work Assignment、主要活动 Work Session 和消息来源；参见 [Agent Operations ADR 0002](../adr/agent-operations/0002-work-sessions-and-subagent-lineage.md)。

## 可追溯的项目运行图

Saki 使用同一张可追溯关系图连接产品意图、Work Item、Signal、Agent Identity、Agent Profile 版本、Execution、资源变化与 Outcome Evidence。第一阶段对开发操作者开放较完整的图和证据链，以支持调试、恢复、审阅和自动化。后续阶段不删除这些关系，而是通过 View 让日常运营人员、组织成员和只提需求的参与者主要看到 Board、待办、状态与需要干预的部分。

Project 运行图是解释与恢复能力，不要求所有用户都操作图界面。高密度操作者控制台、项目资产概览、Agent 运行监督、Attention Inbox 和简化 Board 都从同一组领域事实投影；产品不预设所有人共用一种首页。

## 控制面与执行面

一个活动控制面写入某个 Saki Installation 的状态。Installation 可以在机器之间迁移，也可以登记多个 Host，但 0.1.0 不支持活动—活动控制面。同进程的 Local Host 仍保留独立身份，使后续远程执行和 Host 替换不改变 Project 归属。

控制面拥有 Principal、Grant、Actor 归因、Project 登记、Resource Binding 元数据、Work Item 投影、Work Assignment、Agent Identity、Agent Profile、Signal 路由、Automation Policy、Execution Dispatch、Intervention Request、调度、Attention Inbox 投影、运行历史投影和审计关系。它决定希望什么工作在什么条件下执行，但不直接持有工作目录、进程、模型会话或凭据内容。

执行面位于 Saki Host 或后续远程执行目标，拥有 Host Operation、Workspace 定位、Git 工作树现实、DSH Session、终端与进程、工具和模型调用、凭据引用解析以及 Host 能力状态。它在一次已授权 Execution 内改变现实资源，并回报带来源的进度、结果和 Outcome Evidence；它不自行决定 Project 优先级、创建无限后续工作或扩大权限。

两个面通过稳定的 Execution 接口连接：控制面交付带归因的 Execution Dispatch，其中包含目标 Host、Project、触发来源、Profile 版本、资源要求、限制和委派权限；执行面先准备一条幂等 Host Operation，再返回状态事件、Intervention Request、结果和证据引用。0.1.0 可以把两者放在同一进程和仓库，但不允许 Web View 或控制逻辑绕过该接口直接操作 Host 资源。只有出现第二种真实远程实现时，才增加网络传输适配器，而不在第一版提前微服务化。该决定见 [ADR 0004](../adr/0004-control-and-execution-planes.md)、[ADR 0007](../adr/0007-single-control-plane-and-enrolled-hosts.md)、[ADR 0008](../adr/0008-principals-grants-and-actor-attribution.md)、[ADR 0009](../adr/0009-durable-dispatch-intervention-and-attention-projections.md)和 [ADR 0010](../adr/0010-fenced-idempotent-dispatch-admission.md)。

## Signal 传输与协作

外部平台事件、时间到期、Host 状态、人类操作和 Agent 输出都先经过来源 Adapter 变成带来源的 Signal，不直接进入模型上下文或启动执行。Signal 至少保存稳定标识、来源、事件发生与接收时间、Project 归属、去重键、相关对象、因果关联和载荷引用，以便重放、对账和追踪连锁行为。

Automation Policy 对 Signal 可以选择五类效果：只更新 Project 读模型；通知人或 Agent Identity；把新事实关联到已有 Work Item 或 Execution；在存在持续预期结果、人类协作或验收需求时创建 Work Item；在工作边界明确且已授权时直接启动 Execution。因此例行定时检查可以只产生 Execution 和 Outcome Evidence，只在发现异常或需要协调时升格为 Work Item。

Agent 之间的交接同样产生带来源 Agent Identity、Agent Run 和因果关联的 Signal，不使用能够直接扩权的私有消息通道。Signal 路由必须处理重复事件、事件风暴和 Agent 循环；后续 Agent 只能在 Automation Policy 授予的因果深度、并发、费用和时间限制内被唤起。

## 产品原则

### 工作必须留下证据链

产品意图由 PRD 或规格保存，原子工作由 Work Item 保存，实施讨论由 PR 保存，交付事实由 CI、Release、部署或业务指标保存。Saki 连接这些记录，不把聊天记录当作唯一事实来源。

### 自动化必须渐进授权

Ready 只表示 Work Item 可以被领取。手动模式要求操作者触发和验收；只有 Project Automation Principal 拥有所需 Grant、Automation Policy 允许且每项必需预算都已预留时，自动模式才可以自动领取、提交、交付和 Done。Signal、policy、Agent 和子 Agent 都不能扩大权限，预算耗尽绝不意味着 Done，失败时必须停在可解释、可恢复的状态。参见 [ADR 0015](../adr/0015-reserved-automation-budgets-and-usage-ledger.md)。

### 权威来源必须明确

Git、GitHub、DSH Session 和业务系统继续拥有各自的数据。Saki 只拥有 Project 关联、Execution 关联、Automation Policy、已确认同步 checkpoint 和必要缓存；每个 View 都必须显示数据来源、确认时间、乐观或陈旧状态和失败位置。GitHub 扫描原子发布，page cursor 或 webhook delivery 永远不会成为权威。参见 [ADR 0013](../adr/0013-polling-first-staged-github-synchronization.md)。

### Agent 上下文必须声明来源

Agent 上下文可以组合 Agent Identity 的长期职责与记忆、Agent Profile 的角色指令和上下文配方、Workspace 的 `AGENTS.md`、Work Item、系统状态与告警、历史 Outcome Evidence 和其他 Agent 的交接信息。每项模型可见内容都必须标明来源并写入可恢复的 Session 记录；Signal 和 Agent 消息不能成为绕过 Automation Policy 的隐藏指令通道。

### 插件优先、单仓库优先

Saki 功能优先通过 DSH bundle、Service Definition、Provider 和 Consumer 形成可替换模块，但当前阶段默认与产品代码位于同一个 Saki 仓库。只有接口、用户、维护者、发布节奏或安全生命周期独立时才拆出仓库。该决定见 [ADR 0002](../adr/0002-plugin-first-single-repository.md)。

降低耦合的标准是变化能否停留在拥有它的模块中，而不是目录或仓库数量。Resource Adapter、Signal Source 和 Execution Provider 等真实变化点应通过窄接口替换；只有一种实现时不预先公开假设性插件接口。一项能力后续能不改产品语义地拆仓，是模块已经足够独立的证据，不是当前必须达成的目标。

Plugin composition 不是沙箱边界。以 Cordis 或 npm plugin 安装到 Host 的代码是有特权的可信代码；仓库内容、模型输出、浏览器 payload 和外部事件仍是不可信输入。模型动态生成的 plugin 保持为一次性材料，直到 Host Operator 通过常规安装路径完成审查与提升。

### 凭据保护声明必须说明威胁模型

产品记录、Projection、Agent 和浏览器 client 只接收凭据 reference 与安全观测，不接收原始值。每个 Host 凭据 Provider 都声明 Credential Protection Level；0.1.0 在单操作者 Windows Host 上接受 `local-user-trust`，并明确说明该等级仍然信任同用户 Agent 进程。相关决定见 [ADR 0011](../adr/0011-dpapi-local-user-trust-credentials.md)。

Host 迁移不会通过复制替换 Host 无法安全使用的加密凭据 blob 来制造表面可移植性。在组织成员共享由 Host 供应账号支持的 Agent 能力前，Saki 必须采用运行于独立 OS 身份下的 Credential Broker 或外部 secret manager，并验证 Agent execution 无法恢复原始值。

### 持久产品状态必须显式跨越演进

Saki 自有产品记录从第一个 0.1.0 schema 开始获得向前兼容承诺。升级迁移独立 Installation State Generation，并且只在验证后发布；回滚使用已验证 Recovery Backup，不依赖反向迁移。Host 替换使用明确排除机器权限的 Installation Export，然后要求重新绑定、重新授权与对账。相关决定见 [ADR 0012](../adr/0012-forward-migrations-and-installation-maintenance.md)。

### 集成通用能力，拥有产品语义

Saki 不应重复建设 DSH 或社区能够提供的通用 Agent、模型、终端、文件、LSP、浏览器、电脑控制、SSH 和供应商接入能力。Saki 必须拥有 Project、Resource Binding、Work Item 到 Execution 的编排、Outcome Evidence 和跨系统 View，因为这些共同构成产品差异。

## 能力来源策略

每个版本在拆 Issue 前维护一次能力判断，而不是把对社区未来的猜测写成依赖：

| 类别 | 判断标准 | Saki 的动作 |
| --- | --- | --- |
| 直接继承 | DSH 已提供稳定能力 | 通过 profile 或插件装配，不复制实现 |
| 薄适配 | 外部平台或社区能力存在，但接口与 Saki Project 不一致 | 只实现 Adapter 和必要映射，保持可替换 |
| Saki 拥有 | 能力承载 Saki 的核心产品语义 | 在 Saki 仓库实现并形成清晰的插件接口 |
| 暂缓等待 | 通用能力不阻塞当前闭环，且 DSH 或社区很可能提供 | 记录缺口和替代路径，不提前建设 |

是否等待不能只看“社区可能会做”。只有存在可运行项目、持续维护者、与 Saki 接口相容的设计或明确上游计划时，才把它当作候选依赖；阻塞当前版本且没有可信候选的能力由 Saki 做最薄的可替换实现。

## 产品阶段

阶段描述产品能力边界，不等同于单个版本。0.1.0 只是第一阶段的第一个可用切片。

### 第一阶段：Agent 原生开发系统

第一阶段让单个主机操作者把 Saki 作为主要开发环境和个人 Agent 平台。它对开发操作者提供较完整的 Project 运行图和证据链，从本地多项目闭环开始，随后补齐日常开发界面、Project 级 Agent Profile、多模型与工具接入、Event Subscription、定时自动化、并行 worktree、任务队列、远程 Host、分布式执行和主机迁移。

第一阶段内部按能力递进：

1. **开发闭环**：登记 Development Project，从 Work Item 启动 Agent，审阅 Diff，提交并跟踪 PR、CI、Milestone 和 Release。0.1.0 交付这一切片。
2. **开发环境替代**：补齐代码导航、搜索、LSP、Git 深层操作、Actions、插件管理和足够的浏览器、电脑或 SSH 接入，使日常开发不再依赖 VS Code，并允许一个 Project 选择不同职责的 Development Agent Profile。
3. **自主开发编排**：增加 Project Coordinator 身份、Signal 接入、事件触发、定时任务、持久 dispatch、Agent Attention Inbox、预算、并发 worktree、自动验收和失败恢复，使多个项目和 Agent Profile 能够持续推进。
4. **分布式开发执行**：把 Execution 派发到不同 Host 或远程环境，支持 Host 上下线、项目迁移、资源匹配和可恢复调度。

第一阶段完成的边界是：一个操作者可以在 Saki 中规划、执行、自动化和观察多个软件项目，并让工作安全地跨本地或远程执行资源运行；它不要求多人登录或组织授权。

### 第二阶段：业务系统与业务 Agent 平台

第二阶段把已经开发或已经存在的业务系统登记为 Managed System，并把第一阶段的开发 Agent 平台扩展为业务 Agent 平台。Saki 通过 Resource Binding 连接运行服务、部署环境、数据库、消息平台、内容流水线、定时任务和专用工具，并通过 Operations Cockpit 统一展示健康状态、待处理工作、Agent Profile、自动化、事件、日志和业务结果。

Development Agent 通常从 Workspace、`AGENTS.md`、Work Item 和仓库状态获得上下文；业务 Agent 还可以读取人类编写的职责与操作手册、Managed System 当前状态、告警、业务指标、历史 Execution 和相关人员信息。持续承担值守、运营、内容生产或审批职责的业务 Agent 是 Agent Identity；它们可以按工作类型选择不同 Agent Profile，共享 Project 与部分 Resource Binding，但保持各自的 Attention Inbox、职责和连续历史。

人类输入通过职责、操作手册、Work Item 和显式指令进入系统；机器输入通过定时任务、状态告警和事件订阅产生 Signal；其他 Agent 通过带来源的交接 Signal 与 Outcome Evidence 协作。Automation Policy 决定 Signal 是否创建 Work Item、启动特定 Agent Profile、追加已存在 Execution 的上下文或请求人工处理，Agent 不能因为收到另一个 Agent 的消息就自动获得更多权限。

业务 Agent 平台至少提供 Agent Identity 与 Attention Inbox、Agent Profile 管理、上下文来源装配、Event Subscription、Signal 路由、持久 Execution Dispatch、Intervention Request、权限与预算、Agent 间交接、Outcome Evidence 和运行观察。Agent Profile 可以复用 DSH 的 per-session Agent Preset；Saki 不另造模型循环，而是拥有 Project 与这些运行时能力之间的产品关系。

第二阶段完成的边界是：操作者能在 Saki 中同时管理项目的代码和运行现实，并把 `feishu-bot`、自动工具、内容或视频流水线等既有系统接入统一的观察、Agent 执行和操作闭环；它仍可以是单用户产品。

### 第三阶段：组织工作系统

第三阶段以 Web 应用作为组织成员的主要工作空间，增加 GitHub 身份登录、个人空间与组织空间、项目发现与授权、角色与审计、共享 Agent 供应、资源配额、协作式 Work Item、审阅和批准。GitHub identity 用于认证或关联 human Principal；组织成员身份可以为 Grant 管理提供依据，但不直接授予 Host 访问。自动化使用独立 Principal；任何人都不会获得 Host Operator 的原始模型凭据或订阅登录态。共享 Host 供应账号需要超越单操作者版本所用 `local-user-trust` 边界的 Credential Broker。

第三阶段的具体信息架构仍需在前两阶段的真实使用中形成，目前不预设它是传统项目管理、门户还是社交协作产品。确定的是 Web 界面拥有完整的 Project、Work Item、Agent、资源、审阅和组织管理能力；飞书、QQ 等 Adapter 只承担事件输入、通知、审批或轻量快捷操作，不是主要工作入口，也不拥有独立的组织工作状态。

第三阶段完成的边界是：组织能够在权限清楚、执行可追踪、资源可计量的条件下共同开发和运营 Project，并能迁移主机或扩展执行节点而不丢失项目身份和历史。

## 产品角色

| 首次出现 | 角色 | 责任 |
| --- | --- | --- |
| 0.1.0 | Host Operator | 拥有主机资源，登记 Project，配置凭据和自动化，并验收高风险结果 |
| 第一阶段后续 | Automation Operator | 管理队列、预算、远程 Host、失败恢复和无人值守策略；可以与 Host Operator 是同一人 |
| 第二阶段 | System Operator | 负责 Managed System、业务 Agent Identity 与 Profile、运行状态、业务任务、发布和恢复 |
| 第三阶段 | Organization Member | 在授权 Project 中创建、领取、审阅和观察 Work Item |
| 第三阶段 | Organization Administrator | 管理成员、空间、Project 授权、共享执行资源和审计策略 |

## 阶段性成功标准

- 第一阶段：Saki 自身和多个真实开发项目能够脱离多窗口 VS Code 完成日常开发、自动化与分布式执行。
- 第二阶段：至少一个既有业务系统和一个自动化流水线能够由持续承担不同职责的 Agent Identity 使用多种 Agent Profile 在 Saki 中观察、操作、恢复，并把业务结果关联回 Work Item 或直接执行证据。
- 第三阶段：组织成员能够在 Web 工作空间中使用各自 GitHub 身份访问个人与组织 Project，并通过 brokered 凭据边界共用 Host 供应的 Agent 能力，而不会获得 Host 凭据。

## 关联规格与缺口

- [Saki 0.1.0 实现规格](versions/0.1.0.md)定义第一阶段首个切片的行为、范围、失败恢复和发布条件。
- [Work Management 领域词汇](../contexts/work-management/CONTEXT.md)定义 Work Item、状态、Milestone、Release 和 Outcome Evidence。
- [Agent Operations 领域词汇](../contexts/agent-operations/CONTEXT.md)定义 Agent Identity、Agent Profile、Project Coordinator、Work Assignment、Work Session、Execution Dispatch、Dispatch Claim、Host Operation、Intervention Request、Attention Inbox、Agent Run、Signal 和 Event Subscription。
- [Model Supply 领域词汇](../contexts/model-supply/CONTEXT.md)定义 Provider Account Profile、Credential Protection Level、Credential Broker、Model Route、上下文限制与策略、Usage Snapshot 和 Generation Job。
- [Agent 三分模型决定](../adr/agent-operations/0001-agent-identity-profile-run.md)记录持久主体、执行配置和单次尝试的所有权。
- [Work Session 与 subagent 谱系决定](../adr/agent-operations/0002-work-sessions-and-subagent-lineage.md)让产品协作关系独立于 DSH 运行时父子关系。
- [控制面与执行面决定](../adr/0004-control-and-execution-planes.md)记录两个面的责任与连接方式。
- [持久派发、介入与待处理事项决定](../adr/0009-durable-dispatch-intervention-and-attention-projections.md)分离已接受工作、Host 交付、人工回答与待处理事项投影。
- [带 fencing 的幂等 dispatch admission 决定](../adr/0010-fenced-idempotent-dispatch-admission.md)定义 claim 过期、重试、Host preparation、acceptance、start 与结果不明处理。
- [DPAPI local-user-trust 凭据决定](../adr/0011-dpapi-local-user-trust-credentials.md)定义 0.1.0 的静态保护、明确同用户限制和组织共享门槛。
- [向前迁移与 Installation 维护决定](../adr/0012-forward-migrations-and-installation-maintenance.md)定义 state generation、回滚 artifact、加密可迁移 export 与替换 Host 恢复。
- [GitHub 同步决定](../adr/0013-polling-first-staged-github-synchronization.md)定义完整分阶段扫描、乐观 conflict、mapping repair 与 rate-limit 行为。
- [Resource Binding 生命周期决定](../adr/0014-stable-resource-bindings-over-canonical-worktrees.md)把稳定 Project 资源身份与规范 worktree 位置、历史 Session 路径分离。
- [自动化预算决定](../adr/0015-reserved-automation-budgets-and-usage-ledger.md)定义类型化预留、结算、未知用量与一次性例外。
- [0.1.0 前端约定](architecture/0.1.0-frontend-contract.md)定义客户端信息与交互语义。前端工作可以预先拆成 K0 至 K7，以便明确所有权与依赖；K1 至 K7 必须保持非 Ready，并且只有 K0 的低保真 prototype 获得产品确认、该切片需要的后端 Projection 与 Intent fixture 可用后，才可以开始生产实现。Prototype 与视觉复核都不会把长期 PRD 变成固定页面布局。
