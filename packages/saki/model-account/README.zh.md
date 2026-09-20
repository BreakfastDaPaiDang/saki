---
description: "分别管理订阅账户，仅激活明确选择的账户路由。"
kind: "package-reference"
---

# `@breakfastdapaidang/saki-model-account`

[English](README.md) | 中文

## 概述

分别管理订阅账户，仅激活明确选择的账户路由。

## 目录

- [使用本包](#use-this-package)
- [实现](#implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

[Saki 组合包](../bundle/README.zh.md) 将本服务与账户提供者一同加载。[控制平面](../control-plane/README.zh.md) 拥有持久化配置档案、授权意图和操作员选择。

本插件没有配置字段。激活要求凭据保护等级与账户身份匹配；已知请求额度耗尽时拒绝激活。


<a id="implementation"></a>
## 实现

<details>
<summary>实现细节</summary>

`ModelAccountProvider` 提供授权、检查、配置解析和账户专属 LLM 适配器。注册表拥有适配器注册与释放，不会选择其他账户。

路由标识配置档案的一个配置修订。移除提供者会撤销其路由。重新授权保留档案身份，并分配新的凭据地址和路由修订。

</details>

<a id="model-experience"></a>
## 模型体验

### 账户路由

#### 模型看到的内容

没有直接内容。`ctx.sakiModelAccounts` 不添加提示、工具或消息内容。

#### Token 影响

不直接消耗 Token。

#### KV Cache 影响

账户路由不改写对话前缀。提供者缓存行为由提供者负责。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- **显式选择**——不提供账户池、故障转移或自动模型替换。
- **依据观测判断资格**——额度不可用不代表额度为零，也不代表已确认使用资格。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护上下文</summary>

运行时注册和撤销由同一组效果拥有，不维护独立持久化注册表，因此本包不发布不变量伴随模块。

</details>
