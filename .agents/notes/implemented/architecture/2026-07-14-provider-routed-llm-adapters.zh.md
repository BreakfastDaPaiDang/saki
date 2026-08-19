# Agent Note: 基于提供方路由的 LLM 适配器与通用 pi-ai 后端

Status: implemented

[English](2026-07-14-provider-routed-llm-adapters.md) | 中文

## 问题

`dsh-llm` 按精确模型名称注册适配器。插件在 Cordis 启动时提供模型列表，`LlmRuntime` 为列表中的每个字符串保存一个适配器，`GenerateOptions.model` 同时选择适配器与提供方模型。两个随附的适配器都只面向相同的两个 DeepSeek 模型时，这种方式可以工作，但它混淆了两个独立决策：由哪个上游提供方承接请求，以及该提供方应运行哪个模型。

这种混淆使提供方网关无法提供开放的模型目录。例如，OpenRouter 是一个包含大量模型 ID 的提供方，私有 OpenAI 兼容端点也可能在不修改 Harness 插件树的情况下增加模型。目前，每个新选择的模型都必须在插件启动期间完成注册。同一个模型 ID 还可能存在于多个提供方中，因此仅按模型注册无法表达调用方预期使用的提供方。

`dsh-llm-pi-ai` 没有暴露 pi-ai 的提供方抽象。它以内联方式构造 DeepSeek `openai-completions` 模型，应用 DeepSeek 专用的 payload 补丁，并将每条回放的助手消息标记为 DeepSeek。pi-ai 自身提供提供方/模型目录，能够选择 `openai-responses`、`anthropic-messages`、`google-generative-ai` 等 API，并保留提供方专用的响应 ID，以及后续轮次所需的推理和工具签名。Harness 转换丢弃了提供方／模型路由和提供方响应字段，因此仅将内联模型替换为目录查询，会导致同模型回放与跨提供方移交不完整。

适配器配置同样假定只存在一个 DeepSeek API 密钥和端点。通用后端需要为各提供方分别配置凭据和端点覆盖，同时继续由 pi-ai 处理 AWS、Google ADC、OAuth 等环境认证机制。

## 决策

### 提供方作为适配器注册键

`GenerateOptions` 与 `LlmCallConfig` 在 `model: string` 之外携带 `provider: string`，`AgentOptions` 则携带对应的可选创建字段。只有两个值都非空时，agent loop（智能体循环）请求才有效；两个值也都会写入请求头日志。`agent/request` 可以在任意步骤返回替换后的字段组合，因此会话可以切换提供方与模型，无需改变 Cordis 插件生命周期。

`LlmRuntime` 按提供方注册和解析适配器。`registerAdapter(providers, adapter)` 在修改注册表前检查整个提供方列表，遇到重复项时返回 `DUPLICATE_ADAPTER`，并以一个 effect 为单位整体 dispose（资源释放）。模型 ID 不作为注册键；仍由选中的适配器负责验证或转发。后续的 [LLM 目录与 ACP 模型选择 Agent Note](2026-07-15-llm-model-catalog-and-acp-selection.md) 增加了建议性的 `listProviders()` / `listModels()` 发现接口，但不会把目录成员关系变成请求校验规则。

在一个 Cordis 上下文中，一个提供方只能有一个适配器所有者。`dsh-llm-deepseek` 注册 `deepseek`；`dsh-llm-pi-ai` 也可以注册 `deepseek`，但同时加载两个所有者属于配置错误，不采用顺序规则或回退行为。若部署选择手写的 DeepSeek 实现，需从 pi-ai 配置中排除 `deepseek`；若部署选择 pi-ai 的 DeepSeek 实现，则不挂载 `dsh-llm-deepseek`。

`dsh-llm-deepseek` 移除模型注册列表，接受通过 `deepseek` 提供方路由的任意模型字符串。其请求序列化、`/chat/completions` 端点、thinking 选项、SSE（Server-Sent Events）解析和错误行为保持不变；`options.model` 仍会原样发送。

### 以路由为键的 pi-ai 提供方配置

`dsh-llm-pi-ai` 接受可选的 `providers` 字典，并以提供方路由为键。字典无法表达重复路由；省略或传入空字典时，适配器以休眠姿态挂载，不注册任何路由。每个 profile 可以指定一个 `apiKeyEnv` 凭据引用（解析时验证为 `CredentialRef`），以及 `api`、`baseURL`、`models`、`modelOverrides`、模型默认值、headers、推理与预算设置、缓存保留、传输方式、SDK 超时、Harness 流空闲超时和由提供方拥有的 `retryPolicy`。通用插件会为每个请求通过 Harness 凭据 seam 解析已指定的引用；引用缺失时以 `MISSING_CREDENTIAL` 失败，不会回落到无关的 ambient 凭据。catalog 路由的 profile 不指定凭据时，会保留已安装提供方的原生 ambient 认证；手工声明路由的 profile 不指定凭据时，则把认证要求留给其协议。通用插件不注入 OAuth 存储；专用适配器所有者可以把一份 pi-ai `CredentialStore` 绑定到它构造的每个不可变集合。适配器强制将 pi-ai 的 `maxRetries` 设为零，使一次 `stream()` 调用只发起一次可见的提供方尝试；`dsh-llm-retry` 在 agent 失败步骤扩展点上执行解析后的策略。

插件把字典解析为不可变的 pi-ai `Provider` 与 `Models` 快照，并将路由键原子注册到同一个 `PiAiAdapter`。catalog 路由以已安装提供方和模型 catalog 为默认值：`models` 列表缺席或为空时原样服务该 catalog，非空列表会替换它；catalog 未被替换时，`modelOverrides` 会重塑选定的已安装条目。受约束的手工声明路由必须提供 `api`、`baseURL` 和非空 `models` 列表；catalog 外模型使用本包受约束的模型 profile 字段，而不是原始 pi-ai 描述符。无法服务的声明会在配置解析期间失败；请求的模型若不在已解析路由中，则在网络 I/O 前以 `UNKNOWN_MODEL` 失败。[声明式提供方 catalog 决策](2026-08-03-pi-ai-declared-provider-catalog.md)规定物化细节。

适配器调用 pi-ai 的 `streamSimple()`，因此每个目录模型会选择其注册的 API 实现；描述符为 `openai-responses` 时使用 OpenAI Responses，而非 Chat Completions。Harness 的 temperature、最大 token 数、signal、Session id 和提供方配置中的通用流选项均直接传递；循环写入的 Session id 与当前轮次也可供模型不可见的请求钩子使用。静态 profile 不能设置请求自有的 Session 身份、Codex 粘性状态或 `User-Agent`；可选钩子会在已解析认证和部署头部之后添加动态头部，Harness 强制归属最后合并。适配器不再维护 DeepSeek 专用 payload 重写或提供方协议矩阵。

pi-ai 的通用流选项不支持停止序列。若 Harness `stop` 选项已定义，`dsh-llm-pi-ai` 会以 `UNSUPPORTED_OPTION` 拒绝请求，不会静默忽略，也不会增加第二套提供方专用 payload 实现。`dsh-llm-deepseek` 继续通过原生请求序列化器支持 `stop`。

### 已记录的助手路由与回放状态

助手消息携带请求的 `provider` 和 `model`，以及可选的 JSON 可序列化适配器回放状态。成功的 `assistant/message` 会话事件记录这些字段，`deriveMessages()` 返回助手消息时也会包含它们。用户、系统、上下文与工具结果消息不携带助手路由字段。提供方/模型字段是 agent loop 的权威数据；适配器仅拥有其不透明回放状态 payload。

成功的终止 `finish` 分片可以以 `ReplayEnvelope` 形式携带回放状态：不透明的响应级元数据，加上与发射块序列对齐的可选逐块条目。`BlockAssembler` 对内容与元数据只做一次保留/丢弃决定——max-token 组装丢弃工具调用时，数据同一位置的条目一并丢弃——因此 agent loop 附加到已组装助手消息模型来源中的状态始终描述存储的块，见 [max-token 回放状态对齐决定](../bug-fix/2026-08-15-max-token-replay-state-alignment.md)。agent loop 不公开响应改写钩子。错误或中止响应不会生成正常助手消息，因此不会进入后续模型历史。

pi-ai 回放状态用其成功 `AssistantMessage` 的带版本最小投影填充该结构：一个响应半区（源 API/提供方/模型、响应 ID/模型、停止原因），以及逐块的文本签名、thinking 签名和工具调用签名。它不会重复 Harness 内容块中已有的文本或工具参数，也不包含诊断信息、时间戳、用量或错误。后续请求中，只有历史提供方和目标提供方当前归同一个适配器实例所有时，`LlmRuntime` 才会把回放状态交给目标适配器。适配器在能够恢复历史响应时，将 Harness 记录的内容与回放状态组合，并负责所需的跨模型或跨提供方转换。持久化内容保持权威：适配器收到无法使用的回放状态——未知 kind 或版本、格式错误的元数据、或与内容不再匹配的块结构——会把该消息降级为提供方无关转换并带出诊断；其他适配器只能收到提供方无关的内容以及提供方/模型字段。

该状态属于模型可见的回放输入，因此遵循现有的[请求可重建规则](2026-07-05-reconstructable-requests.md)：它同时存在于终止 `finish` 分片和驱动派生的已组装 `assistant/message` 模型来源中。恢复和 fork 会原样保留该状态。压缩（compaction）遮蔽助手消息时，也会从活动 surface 中移除其回放状态；摘要属于普通的提供方无关内容。

### 在所有请求生产方中传播目标

每条模型选择路径都同时携带 provider 与 model：声明式 agent、ACP（Agent Client Protocol）和 stdio 应用配置、JSON-RPC initialize 请求、subagent 覆盖与继承、工作流子 agent 覆盖，以及直接压缩摘要。subagent 先从父 agent 继承两个字段，再应用请求覆盖。系统提示词变量集合在 `model` 之外增加 `provider`。

压缩配置在 `summarizationModel` 之外增加 `summarizationProvider`。两个值均为空时继承，均非空时选择显式目标；只配置其中一个会导致加载失败。继承优先使用最近一次记录的请求目标，没有时回退到 agent 创建选项。`compaction/summary` 使用现有模型调用 envelope 记录两个字段。

JSON-RPC 运行时显式接收提供方与模型。仅当 `deepseek` 提供方没有注册所有者时，其便利回退才会挂载 `dsh-llm-deepseek`；其他缺失的提供方会直接失败，不会猜测适配器。

磁盘会话格式仍使用预发布阶段固定的版本 `0`，且不承诺兼容性。seed/load 验证会拒绝省略必需提供方/模型字段的请求头和助手消息，不会接受已无法重建请求的旧格式。

## 考虑过的替代方案

**继续以模型名称作为注册表键，并增加通配适配器。** 通配机制会在精确注册与兜底插件之间引入回退顺序，使重复所有权取决于监听器顺序；若不再增加其他约定，仍无法区分不同提供方中相同的模型 ID。

**将提供方与模型编码到一个字符串中。** OpenRouter 的 `openai/gpt-*` 等值已经包含类似提供方的前缀和斜杠。分隔符约定会把路由语法泄漏到每个模型选择器，并需要转义规则；两个显式字段更清晰，也可以分别记录日志。

**增加 `backend + provider + model`。** backend 键可以让 `dsh-llm-deepseek` 与 pi-ai 的 DeepSeek 实现共存，并按请求切换。最终采用的部署规则是一个提供方对应一个适配器所有者：同一上游的不同实现属于由插件组合选定的替代项。第三个路由维度会增加每个请求与配置的负担，却没有当前消费方。

**让 `dsh-llm-pi-ai` 自动注册所有 pi-ai 提供方。** 这种方式会占用部署无意暴露的环境凭据和提供方名称，并与 `dsh-llm-deepseek` 等原生适配器冲突。显式路由字典使能力和凭据范围可以审查。

**每个提供方挂载一个 pi-ai 插件实例。** 独立实例可以隔离配置，但会重复插件声明，也无法实现路由注册的原子性。每个请求本就向同一个适配器提供提供方，因此经过验证的路由字典具有更小的生命周期接口。

**接受任意内联 pi-ai 模型描述符。** 拒绝。catalog 外路由和模型可以通过受约束的提供方及模型 profile 字段表达；暴露原始 pi-ai `Model` 描述符则会让提供方库内部结构成为 Harness 配置，并放入没有 Harness 消费方负责的字段。

## 影响

- 提供方名称是部署范围内的路由所有权键：两个提供方可以使用相同的模型字符串，但为同一个提供方挂载两个适配器会在加载时失败，不会形成回退顺序。
- 模型选择不再改变 Cordis 插件图。已配置的 catalog 路由可以服务已安装 catalog 或受约束的替换列表，手工声明路由可以服务 catalog 外模型 ID，原生 DeepSeek 适配器则会转发任意 DeepSeek 模型 ID。
- 在 catalog 路由上，仅覆盖 `baseURL` 会改指已安装模型，同时保留提供方的协议与能力。手工声明路由会明确其支持的 `api`、`baseURL` 与模型 profile；路由级协议适用于其中每个模型。
- pi-ai 凭据、传输选项、SDK 超时，以及默认五分钟的 `streamIdleTimeoutMs` 空闲超时机制均按提供方配置隔离。系统禁用隐藏的提供方重试；有界重试由单独组合的 agent 恢复策略负责。
- pi-ai 的通用流 API 无法表达停止序列，因此 `dsh-llm-pi-ai` 会拒绝停止序列；原生 DeepSeek 适配器仍支持停止序列。
- 仅当历史提供方与目标提供方归同一个适配器实例所有时，回放状态才可移植。适配器负责跨提供方和跨模型恢复；其他适配器只接收不含不透明状态的提供方无关历史。
- 当前预发布会话 JSONL 要求请求头和助手消息都包含提供方/模型。旧格式仍使用版本 `0`，但会被拒绝，不执行迁移。

## 测试

- 单元测试覆盖注册表冲突、请求重建、会话验证、配置解析、单次请求的选项转发、包括 OpenAI Responses 在内的原生 API 选择、转换、回放验证、错误映射、调用方取消、空闲超时导致的传输终止、内容重写，以及同一实例与不同实例间的回放分发。
- 无密钥的 agent loop/会话测试和 ACP 快照覆盖持久化提供方/模型元数据、恢复与 fork 传播、工作流/subagent 覆盖，以及不变的用户可见 transcript（文本记录）；密钥门控的 DeepSeek e2e 测试保留真实提供方的流式输出与工具后续调用覆盖率。
- 公共 JSDoc、package README、架构与子系统文档、生成目录、示例、会话 fixture（测试前置数据）和 Python SDK 配对文档统一使用提供方/模型目标，并由仓库文档与类型等价门禁校验。

## 风险

这是一次覆盖全仓库的预发布 API 破坏性变更：仅模型的请求构造、适配器注册、应用协议、fixture，以及持久化版本 0 事件格式会同时变化，不提供兼容别名。提供方排他规则有意禁止同一上游的两个实现共存于同一上下文。pi-ai 依赖升级可能改变继承的提供方与模型 catalog 默认值，因此锁文件与适配器 e2e 矩阵定义已验证集合。`baseURL` 覆盖无法修复与路由继承或声明的协议不兼容的端点，声明的 `api` 适用于该路由上的每个模型。原始 pi-ai 模型描述符，以及受约束 profile 字段之外的提供方专用要求，仍不受支持。pi-ai 回放状态可能包含不透明的加密推理签名；提供方需要该信息维持连续性，因此系统会持久化该状态，但不会在现有会话记录之外渲染或记录它。
