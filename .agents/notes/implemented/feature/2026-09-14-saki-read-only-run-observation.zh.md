# Agent Note: Saki Run 只读观察

Status: implemented

[English](2026-09-14-saki-read-only-run-observation.md) | 中文

## Problem

Host operation 成功只能在模型完成前证明输入已持久投递。把该回执当作 Run 结果会隐藏后续失败，并可能错误表示 Work Item 已完成。读取旧 Session 还可能意外恢复执行，而注册表重启后复用的终端 id 可能选中无关进程。

## Decision

[Host 执行能力](../../../../packages/saki/execution/README.zh.md#durable-agent-starts) 提供独立的 Run 只读观察。Local Host 校验物理 Session 身份并折叠已消费工作；空的已完成轮次不能替换之前的模型工作。它分别报告历史可用性、最近执行结果及当前 Agent 状态。观察不会创建、恢复、唤醒 Agent，也不会向其发送输入。启动恢复保留独立的恢复权限。

启动恢复会在控制面仍在初始化时挂载 Development Agent Preset。因此 Intervention 工具注册不以控制面注入为前提，而是在每次请求或最终确认时解析该服务。preset 激活若依赖仍在初始化的所有者，就会形成依赖循环并阻止 Host 重启。操作时服务不可用会明确失败，不会授权创建问题，也不会绕过恢复校验。

bundle 只在控制面恢复完成后激活 Connection。在此之前，通用 Conversation API 不能抢在 Local Host 之前，以另一个 Agent 所有者恢复保留的 Session。Host 重启期间的浏览器重连同时依赖 Intervention 注册顺序与 Connection 激活顺序。

Terminal 读取只使用该 Local Host 精确拥有的活跃 Agent 及其现有 Terminal 注册表。响应包含有界名称、进程状态及 scrollback。不透明 id 包含注册表生命周期，避免旧选择指向复用的 PTY id。所有权不可用、Provider 不存在及读取失败分别明确显示。Session 可读并不证明其终端进程或后续模型执行可用。

控制面把经过校验的 Work Session、Run、来源、Dispatch 和 Intervention 记录组合为完整受保护视图。它在等待 Host 观察前后检查 Project 范围及当前读取权限。稳定的 Session 与 Dispatch 游标把每页限制为 32 条；近期 Intervention 历史保留当前阻塞项，并提示省略的更早记录。Run 准入状态与最近 DSH 执行结果及 Work Item 状态保持独立。

[Web 客户端](../../../../packages/saki/web-ui/README.zh.md#plan-a-project) 按 Principal 和 Project 保存 Run 选择、标签、分页及返回目的地。模型完成不一定改变控制面记录，因此 watch 心跳会重新读取所选 Run。现有 Conversation 拥有消息及未提交草稿；Session 标题区的操作可返回保留的 Run。Changes 与 Delivery 保留该返回目的地。读取这些执行视图不会授予执行或验收权限。

## Alternatives considered

**给准入记录增加 Run 终态。** 已完成轮次后，Run 仍可收到后续 Conversation 输入。Session 日志已拥有模型结果；第二份持久状态需要同步，并可能偏离该历史。

**打开页面时恢复 Agent。** 读取权限不授权恢复或执行。现有启动恢复会独立校验精确的持久请求。

**保存原始 PTY id 或构建另一套终端运行时。** 注册表 id 可能复用，额外运行时会重复进程所有权与清理机制。在现有注册表上按生命周期限定选择可保留该所有权。

## Consequences

操作者可检查等待、失败与历史工作，不改变 Work Item 状态，也不发送模型输入。完整 Session 读取与所选 Run 轮询存在成本；终端输出及浏览器历史分页保持有界。手动分派、持久回答、规划及浏览器交付决策保留各自独立的准入、修改与恢复理由。本决策实现 [Web 客户端提案](../../proposed/architecture/2026-08-18-saki-projection-driven-web-client.zh.md) 中的 Session 与 Run 观察部分；自动分派、协调者谱系、终端恢复和自动验收仍是独立工作。
