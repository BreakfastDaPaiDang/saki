---
description: "将已配置的 API 连接导入为独立受保护的 Saki 账户路由。"
kind: "package-reference"
---

# `@breakfastdapaidang/saki-model-account-api`

[English](README.md) | 中文

## 概述

将已配置的 API 连接导入为独立受保护的 Saki 账户路由。

## 目录

- [使用本包](#use-this-package)
- [实现](#implementation)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

Windows [Saki bundle](../bundle/README.zh.md) 挂载此 Provider、受保护凭据、DSH Models 设置和[账户注册表](../model-account/README.zh.md)。本插件没有独立的 Cordis 配置。

在设置 → 模型中配置连接，显式指定协议、端点、凭据引用和模型列表。模型账户提供该连接的显式导入操作。导入捕获配置并将密钥复制到独立的受保护记录。之后修改来源需要再次显式导入；这些修改不会改变保留的账户修订。

DSH 模型发现为可编辑模型列表提供候选项。发现失败不会替换已确认的配置。发现结果不代表使用权限、容量或可用余额。

<a id="implementation"></a>
## 实现

<details>
<summary>实现内部细节</summary>

Provider 组合公开的 DSH PiAiAdapter，并固定 pi-ai 0.85.1。每个 adapter 拥有不可变配置集合，只读取自身的受保护凭据记录。来源连接名称保留已安装目录的默认值；公开路由仍属于特定账户。

API identity 标识本地 Profile，并非已验证的远端账户。已认证表示已配置受保护密钥；端点健康度和使用权限在独立观测前保持未知。Provider 注册变化会重新对账保留的激活选择，而不重复登录。

</details>

<a id="model-experience"></a>
## 模型体验

### API 路由

#### 模型所见

现有 `GenerateOptions.messages` 和工具声明传递给所选协议。账户管理不添加指令。

#### Token 影响

用量来自传输响应。导入和模型发现不消耗模型 token。

#### KV Cache 影响

adapter 保留会话前缀。Provider 缓存行为遵循捕获的连接配置。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **文本输入** — 导入拒绝图片声明；adapter 仅声明文本输入能力。
- **受保护 Host** — 随包 Provider 要求 Windows local-user-trust 凭据。
- **请求头和 URL** — 导入拒绝自定义请求头及端点中的用户信息、查询字符串或片段；凭据由凭据服务持有。
- **额度** — 用量检查报告不支持。TeamoRouter 已记录计费端点，但此 Provider 尚无经过验证的额度 adapter。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文</summary>

不发布 invariant companion，因为 adapter 通过账户注册表拥有的 effect 注册，且此 Provider 不维护独立的持久注册表。

</details>
