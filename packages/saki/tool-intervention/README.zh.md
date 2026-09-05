---
description: "让 Development Agent 向操作员提出持久问题，并可在当前进程退出后回答。"
kind: "package-reference"
---

# `@breakfastdapaidang/saki-tool-intervention`

[English](README.md) | 中文

## 概述

让 Development Agent 向操作员提出持久问题，并可在当前进程退出后回答。

## 目录

- [使用本包](#use-this-package)
- [工具](#tool)
- [职责](#role)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

Saki Development Agent 私有的模型侧 `request_intervention` 工具。它通过 `ctx.sakiControlPlane` 创建持久化的操作员问题，而不是挂起一个 live question Promise。

<a id="tool"></a>
## 工具

`request_intervention` 接受一个必填 `question` 字符串。控制面会校验非空、well-formed 且不超过 4,096 个字符的值，提交或精确复用一条 `opening` Intervention Request，并返回稳定 id。只有持久写入成功才会结束当前轮次，并渲染精确采用 `{"interventionId":"<id>"}` 形式的紧凑 JSON；请求被拒绝时会返回工具错误，且不会结束轮次。

规范工具结果与完整轮次出现后，插件会 flush Session，并请求控制面完成 opening。短暂失败会在 `openingRecoveryRetryDelayMs`（默认 1,000 ms）后安排一次本地重试；新的完整轮次也可以更早唤醒同一待办项。重试只是唤醒提示：控制面、Local Host 与 Session persistence 拥有 evidence inspection 和 recovery；本包不保留回答或 authority 状态。

<a id="role"></a>
## 职责

此包是 Saki Intervention Request 的 Development Agent 消费方。产品 Host 会在系统自有的 Development Agent Preset 中组合它。通用 DSH question 与 approval 工具仍是 live interaction，不会被替换。

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到的内容

模型会看到[生成的 `request_intervention` schema](../../../docs/tool-catalog.zh.md#breakfastdapaidangsaki-tool-intervention)，其中带有一个必填文本问题。其描述会说明持久写入成功将结束轮次，回答稍后会进入同一个 Agent Run。

#### Token 影响

工具可见时，固定 schema 会为每次 Development Agent 请求增加少量 token 开销。

#### KV Cache 影响

只要 Development Agent Preset 与工具定义不变，schema 前缀即可稳定复用。

### 工具调用历史、结果与回答

#### 模型看到的内容

问题会保留在 assistant 工具调用参数中，成功工具结果只包含 Intervention id。操作员回答不会替换原工具结果：持久接受后，Saki 会通过一条新的 Execution Dispatch，把带归因的 user message 追加到同一个 Session。

#### Token 影响

问题、紧凑 id 结果和后续回答都是依数据而定的保留 token。等待操作员期间不会执行模型请求。

#### KV Cache 影响

后续回答是位于可复用前缀之后、仅追加的 Session 输入。结束提问轮次可以防止后续 assistant 输出假定缺失回答已经存在。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- **只支持文本输入**：请求只声明一个有界文本回答；approval、credential authorization、acceptance 与结构化选项需要相邻产品 schema。
- **每个 Agent Run 只能有一个阻塞问题**：并行的 open 问题会冲突；在前一个回答交付期间，已接受回答的 handoff 可以保留一条后继 `opening`。
- **必须处于 Saki Agent 上下文**：在活动的 Saki 自有 Agent Session 之外调用时会失败，且不会创建请求。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

不发布 runtime invariant companion，因为control-plane 与 Host 提供方校验该工具使用的持久关系。

</details>
