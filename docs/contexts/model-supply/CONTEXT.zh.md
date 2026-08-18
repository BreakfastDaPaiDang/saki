# Model Supply

[English](CONTEXT.md) | 中文

Model Supply 定义 Saki 如何命名外部模型账号、为 Execution 解析模型、管理可用上下文并记录生成式媒体工作。

## 语言

**Provider Account Profile**：对一个模型提供方账号的具名引用，并携带可观测的认证、权益、用量、健康和能力元数据。原始凭据保留在凭据存储中，该 Profile 不合并不同账号的额度。_避免_：账号池、模型提供方

**Credential Protection Level**：对哪些身份与进程可以恢复 Provider Account Profile 背后原始凭据的明确分类。`local-user-trust` 信任以 Host OS 用户身份运行的进程，不能被表述为 Agent 进程隔离。_避免_：Grant、凭据健康

**Credential Broker**：位于 Agent execution identity 之外的凭据权限主体，它在不向 Agent 进程暴露原始值的情况下提供模型访问。_避免_：凭据存储、Provider Account Profile

**Model Route**：为一次 Execution 选择的提供方、模型、推理配置和 Provider Account Profile。Agent Profile 可以请求一条 Route，而 Execution 记录实际解析得到的 Route。_避免_：Agent Profile、模型账号

**Context Capacity**：底层模型声明的最大上下文窗口，独立于产品界面、订阅或账号分配。_避免_：Runtime Context Limit、压缩阈值

**Runtime Context Limit**：特定 Provider Account Profile 和运行时界面实际开放的可用上下文上限。产品配置、订阅或提供方策略可以使它低于 Context Capacity。_避免_：Context Capacity、压缩阈值

**Context Policy**：依据 Runtime Context Limit 测量、压缩、裁剪、恢复和观测 Session 上下文的具名、可版本化策略。压缩阈值属于配置，不是模型属性。_避免_：上下文窗口、Context Capacity

**Usage Snapshot**：对一个 Provider Account Profile 的额度周期、剩余用量、credits 和读取状态所作的带提供方来源、带时点观测。它不是 Saki 拥有的余额，也不授权超过提供方限制。_避免_：额度余额、共享额度

**Generation Job**：通过已解析 Model Route 生成或编辑媒体的一次可追踪请求。它记录输入、状态、输出和来源，并可把产物关联到 Work Session 或 Work Item。_避免_：Agent Run、图片消息
