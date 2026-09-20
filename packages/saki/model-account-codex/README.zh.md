---
description: "授权 Codex 订阅账户、查看额度，并使用受保护凭据发送文本请求。"
kind: "package-reference"
---

# `@breakfastdapaidang/saki-model-account-codex`

[English](README.md) | 中文

## 概述

授权 Codex 订阅账户、查看额度，并使用受保护凭据发送文本请求。

## 目录

- [使用本包](#use-this-package)
- [实现](#implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

Windows [Saki 组合包](../bundle/README.zh.md) 将本提供者与 DPAPI 凭据、DSH 授权、会话和[账户注册表](../model-account/README.zh.md) 一同加载。账户配置按档案解析；本插件没有独立的 Cordis 配置。

设备码和浏览器授权使用 pi-ai。可刷新的授权信息存储在受保护记录中；不导入环境变量密钥或外部凭据文件。

`baseURL` 默认为 `https://chatgpt.com/backend-api`；可选的 `models` 限制维护中的模型目录。`timeoutMs`、`streamIdleTimeoutMs` 和 `usageTimeoutMs` 分别默认为 120000、300000 和 15000 毫秒。


<a id="implementation"></a>
## 实现

<details>
<summary>实现细节</summary>

集成固定使用 pi-ai 0.85.1 的 OAuth 与 Codex SSE，以及 dsh-codex-subscription 2.1.2 的公开额度助手。它组合 DSH PiAiAdapter，不加载订阅组合包，也不复制传输实现。

受保护记录事务串行执行刷新。请求在异步准备前捕获账户、会话和持久化轮次；响应轮次状态仅保留于该活动轮次。最终 HTTP 标头保留 Harness 归属和所选账户。

额度观测保留单位、来源、时间和重置事实。失败或空响应保持不可用状态。模型目录描述能力，不确认订阅使用资格。

</details>

<a id="model-experience"></a>
## 模型体验

### 账户路由

#### 模型看到的内容

适配器发送已有的 `GenerateOptions.messages` 与工具声明，不添加账户管理指令。

#### Token 影响

输入和输出用量来自维护中的传输实现。授权和额度读取不增加模型 Token。

#### KV Cache 影响

同一轮次的 HTTP 状态仅属于当前账户。轮次结束或会话释放会阻止复用。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- **仅文本 SSE**——不声明支持图片附件或 WebSocket 传输。
- **需要受保护宿主**——随产品提供的实现仅在具有本地用户信任级凭据的 Windows 上启用。
- **真实订阅验收**——无密钥测试使用受控响应执行维护中的授权和传输；真实使用资格与端点访问需要操作员授权的账户。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护上下文</summary>

本包不发布不变量伴随模块：请求状态仅属于各适配器，每次访问受保护记录都会检查凭据归属。

</details>
