---
description: "将凭据引用和记录存储为 Windows 当前用户 DPAPI 密文，并在不暴露值的情况下检查其可用性。"
kind: "package-reference"
---

# dsh-credentials-windows-dpapi

[English](README.md) | 中文

## 概述

将凭据引用和记录存储为 Windows 当前用户 DPAPI 密文，并在不暴露值的情况下检查其可用性。

## 目录

- [使用本包](#use-this-package)
- [配置](#config)
- [存储文档](#stored-document)
- [CNG DPAPI 参数](#cng-dpapi-parameters)
- [解析与安全观察](#resolution-and-safe-observations)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

Windows CNG DPAPI `LOCAL=user` [凭据](../credentials/README.zh.md)提供方。它把凭据引用与持久记录都持久化为不透明密文，并报告 `protectionLevel: 'local-user-trust'`；绝不回退到进程环境、`.env`、明文凭据文件、经典 DPAPI 或机器作用域 CNG DPAPI。

> **`local-user-trust` 不是进程隔离。** 任何刻意以同一 Windows 用户身份运行的进程都可以调用 DPAPI 解密复制来的密文。本提供方保护静态值免受其他普通用户访问并减少意外传播，但不抵御 Host 账户失陷或恶意同用户代码。

<a id="config"></a>
## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `path` | `<harness home>/.credentials.dpapi.json` | Host 本地密文文档。 |
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | `path` 缺省时使用的 Harness home。 |

提供方在非 Windows 主机上拒绝激活，并在发布 `ctx.credentials` 前校验已有文档。

<a id="stored-document"></a>
## 存储文档

版本 2 为两种凭据键空间各设一个分区。引用条目只存储 DPAPI 类型与密文。持久记录还会存储安全的 `recordKind` 标签，让 `describeRecord()` 与 `listRecords()` 无需解密或暴露值：

```json
{
  "version": 2,
  "refs": {
    "OPENAI_REFRESH_TOKEN": {
      "kind": "dpapi-ng-local-user",
      "ciphertext": "<canonical base64>"
    }
  },
  "records": {
    "llm-pi-ai/openai-codex": {
      "kind": "dpapi-ng-local-user",
      "recordKind": "grant",
      "ciphertext": "<canonical base64>"
    }
  }
}
```

格式错误的 JSON、未知或缺失字段、不支持的版本、无效引用或凭据键、非规范 base64、空密文、`dpapi-ng-local-user` 之外的保护类型，以及共享 `CredentialRecord` 联合类型之外的持久记录标签都会明确失败。提供方只接受版本 2，不提供兼容回退。整个文档都是 Host 本地数据，必须排除在可携带的 Installation Export 和 Host 更换备份之外。

写入会在 [`dsh-atomic-write`](../../util/atomic-write/README.zh.md) 的跨进程锁内重读文档、替换一个条目、对两个分区分别排序以获得确定性输出，再原子提交。同一提供方实例中的写入串行执行。`modifyRecord()` 会让读取、所有者回调与替换操作始终处于该跨进程锁内；返回 `undefined` 会保持条目不变。对不存在的条目执行 `unset()` 或 `deleteRecord()` 是空操作。`credentials/reference-updated` 与 `credentials/record-updated` 只在各自变更提交后触发。

<a id="cng-dpapi-parameters"></a>
## CNG DPAPI 参数

原生适配器创建 `LOCAL=user` 保护描述符，并以 `NCRYPT_SILENT_FLAG` 调用 `NCryptProtectSecret` 和 `NCryptUnprotectSecret`。解密时，它取得受保护数据块携带的描述符，通过 `NCryptGetProtectionDescriptorInfo` 读取完整规则，并在把明文复制到 JavaScript 前要求该字符串严格等于 `LOCAL=user`。经典 DPAPI 数据块不提供 CNG 描述符，机器作用域 CNG DPAPI 数据块则报告 `LOCAL=machine`；即使文件元数据声称记录类型符合要求，两者也都会失败关闭。

每个描述符句柄都通过 `NCryptCloseProtectionDescriptor` 关闭；Windows 拥有的描述符字符串与数据分配通过 `LocalFree` 释放。无论调用成功还是失败，返回的数据分配都会在释放前被覆写，包括地址非空但长度为零的结果。

适配器会清零自身的临时明文与密文 `Buffer` 副本。JavaScript 字符串无法可靠清零，因此受信任的提供方消费方必须让解析值只存在于当前操作中，不得记录、缓存、投影或序列化它。

<a id="resolution-and-safe-observations"></a>
## 解析与安全观察

`resolve(ref)` 在每次操作时读取并校验当前文档，解密选中的记录，并返回非空值、来源 `windows-dpapi-current-user` 与 Credential Protection Level `local-user-trust`。`resolveRequired(ref, CREDENTIAL_PROTECTION_LOCAL_USER_TRUST)` 是消费方的失败关闭入口：缺失值或任何不同的 Credential Protection Level 都会在调用方拿到值之前失败。

`describe(ref)` 只返回 `ref`、配置状态、来源、Credential Protection Level、可写性、健康状态和观察时间。它验证受保护描述符和明文有效性，但不会构造含凭据的 JavaScript 字符串。复制而来、损坏、采用经典 DPAPI 或作用域不同的记录报告为 `configured: true, health: 'unavailable'`；原始密文和原生输入字节绝不进入结果或诊断消息。

`readRecord(key)` 会在每次调用时解密并校验选中的持久记录。解密后的标签必须与密文外的 `recordKind` 一致；`grant` 载荷与 `api-key` 字段必须符合共享记录格式，并能经 JSON 往返保持不变。`describeRecord(key)` 与 `listRecords()` 只返回配置状态、可写性、地址与标签。因此它们仍能识别并删除复制而来或损坏的条目，而 `readRecord()` 与 `modifyRecord()` 会失败，且不会回显密文或解密数据。

只有受信任的 Host 插件应当拿到原始凭据服务。安全观察只携带引用或记录地址及文档列出的安全字段，绝不携带明文或密文。`credentials.set` 是具名的只写 Host API 例外：明文会随请求通过协议传输，但绝不会在响应中回显。本包不注册包含凭据材料的 Agent 工具、Projection、会话事件、导出记录或模型上下文，其诊断也不包含输入或存储字节。应用组合层仍负责把凭据材料排除在进程崩溃收集与可携带导出之外。

<a id="model-experience"></a>
## 模型体验

经由 `ctx.credentials` 的消费方间接生效：解析值可以为某个提供方操作授权，而所有模型可见效果都由该消费方负责。本包不注册提示词、工具或模型上下文。

#### KV Cache 影响

无直接失效；凭据绝不进入请求前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- **同用户代码可以解密复制来的记录**——只有独立隔离的 Credential Broker 或外部机密管理器，才能让 Host 提供的凭据真正不可被 Agent 进程取得。
- **恢复与 Host 绑定**——把文档移到另一 Windows 用户或机器通常会让记录不可用；请在目标 Host 上重新授权 OAuth 账户或重新导入私有材料。
- **外部编辑不触发事件**——每次操作都会重读文件并观察到修改，但只有提供方自身的提交会发布 `credentials/reference-updated` 或 `credentials/record-updated`。
- **JavaScript 字符串无法清零**——临时字节缓冲区会被清零，但已解析字符串仍受 JavaScript 运行时的内存行为约束。
- **原子但不具备崩溃持久性**——继承自 `dsh-atomic-write`；下次启动或操作会重新校验完整文档。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

不发布 runtime invariant companion，因为凭据 Service Definition 拥有更新事件一致性，该提供方在访问时校验加密介质。

</details>
