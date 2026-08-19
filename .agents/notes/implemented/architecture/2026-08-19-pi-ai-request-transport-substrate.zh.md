# Agent Note: pi-ai 请求传输基础设施

Status: implemented

[English](2026-08-19-pi-ai-request-transport-substrate.md) | 中文

## 问题

通用 pi-ai 适配器原本只接受部署 profile 与逐请求 API 密钥。它无法把应用自有的 pi-ai `CredentialStore` 绑定到不可变模型集合，也没有逐请求扩展点来提供模型不可见的传输头部或观察响应。agent loop（智能体循环）会提供 Session id，却不提供区分同一 Session 内多个轮次所需的持久轮次编号。

这些缺口会阻塞专用 Codex 集成，但基础设施与 carrier 是两项独立义务。当前 pi-ai 依赖中的 Codex carrier 会覆盖调用方的 `User-Agent`，也不会在最终线路上公开全部必需的请求身份。只有适配器扩展点，不能让该 carrier 达到生产就绪状态。

## 决策

**公开模型不可见的轮次身份。** `GenerateOptions.turn` 是可选的 Session 本地编号。agent loop 会在自己构造的每个请求上写入当前持久轮次，因此一个轮次内所有步骤共享同一个值，下一轮次则递增。对话轮次之外的辅助调用可以省略它。该值不会增加模型可见输入，并且可以从既有的持久轮次边界重建。

**在不可变集合构造时绑定凭据。** `PiAiAdapterOptions.credentials` 接受 pi-ai 的公开 `CredentialStore`。每个 profile 快照都会把这个精确值传给 `createModels({ credentials })`；省略时保留 pi-ai 默认行为。已交付的可配置提供方插件会省略该 store，继续通过 Harness 凭据 seam 解析 API 密钥。专用适配器所有者负责登录、持久化、刷新与保护生命周期；`LlmRuntime` 不增加凭据 API。

**让传输准备保持窄小并明确支持异步。** 每次流调用会在首次异步等待前捕获提供方、模型、可选 Session id 与可选轮次。`prepareTransportRequest` 只接收这份已捕获身份，可以直接或通过 Promise 返回动态头部与响应观察器。适配器只等待一次准备结果，随后立即复制头部，并把观察器结果交给 pi-ai 在消费响应 body 前等待。准备被拒绝会阻止派发；观察器被拒绝会遵循 pi-ai 的提供方错误流；调用方突变无法改变已捕获身份或已准备头部。该钩子拿不到消息、系统提示词、凭据、可变提供方对象或取消权限。

**在 profile 解析时保留请求自有头部。** 静态 profile 一旦写入 `session-id`、`thread-id`、`x-client-request-id`、`x-codex-turn-state` 或 `user-agent`，加载期可服务性校验就会不区分大小写地失败，且不暴露对应值。动态头部在已解析认证与部署头部之后合并，Harness 归属头部最后合并。

**等待正式版本再采用 carrier。** 本决策不携带包管理器 patch、不内置 carrier，也不复制 Responses 传输。专用 Codex 消费方继续阻塞，直到上游发布的 pi-ai 正式版本能够保留应用归属并在最终线路上提供所需身份。采用时还必须针对该发布产物补充精确线路 fixture（测试前置数据）。

## 曾考虑的替代方案

- **只按 Session 存储传输状态**——这与官方逐轮次模型客户端生命周期冲突，可能把上一轮次的状态发到后续轮次。
- **向调用方公开可变 pi-ai 提供方**——这会让逐请求代码修改共享提供方行为，并破坏适配器对不可变快照的所有权。
- **给 `LlmRuntime` 增加凭据存储**——这会把提供方库能力移入提供方无关服务，尽管只有 pi-ai 集合需要消费它。
- **在本次改动中 patch 或复制 Codex carrier**——根级包管理器 patch 无法覆盖独立安装的包消费方；复制传输则会重复认证、流式处理、重试、请求序列化与上游修复。

## 后果

核心 LLM 请求如今携带足够的模型不可见身份，让提供方专用所有者可以按 Session 与轮次为临时状态确定键，而无需增加 Session 事件。通用 pi-ai 适配器可以消费应用自有的凭据 store 并观察最终请求／响应元数据，同时仍不了解账户 profile、授权任务、粘性状态映射或产品 schema。

这个扩展点并不声称已有生产 Codex 路由。未来消费方与 carrier 采用仍是另一项改动，受上游正式版本与最终线路证据约束。此前依赖这五个请求自有名称之一的静态部署 profile 如今会明确失败，必须把对应值移入请求准备所有者。

## 测试

聚焦测试证明：每个不可变 profile 快照都收到注入的 store；跨凭据等待的调用方突变无法改变请求身份；异步准备与响应观察各等待一次且会传播拒绝；通用提供方路径实施最终头部所有权；大小写变体的静态冲突会使 profile 解析失败且不暴露其值。agent loop 覆盖证明同一轮次内的步骤共享写入编号，下一持久轮次会递增。本基础设施决策不包含 Codex 精确线路 fixture。
