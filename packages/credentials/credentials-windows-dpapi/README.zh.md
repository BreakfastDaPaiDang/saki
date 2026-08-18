# dsh-credentials-windows-dpapi

[English](README.md) | 中文

Windows 当前用户 DPAPI [凭据](../credentials/README.md)提供方。它只持久化不透明密文并报告 `protectionLevel: 'local-user-trust'`；绝不回退到进程环境、`.env`、明文凭据文件或机器作用域 DPAPI。

> **`local-user-trust` 不是进程隔离。** 任何刻意以同一 Windows 用户身份运行的进程都可以调用 DPAPI 解密复制来的 blob。本提供方保护静态值免受其他普通用户访问并减少意外传播，但不抵御 Host 账户失陷或恶意同用户代码。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `path` | `<harness home>/.credentials.dpapi.json` | Host 本地密文文档。 |
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | `path` 缺省时使用的 Harness home。 |

提供方在非 Windows 主机上拒绝激活，并在发布 `ctx.credentials` 前校验已有文档。

## 存储文档

版本 1 的根对象只有两个字段，每条记录也只有两个字段：

```json
{
  "version": 1,
  "records": {
    "OPENAI_REFRESH_TOKEN": {
      "kind": "dpapi-current-user",
      "ciphertext": "<canonical base64>"
    }
  }
}
```

格式错误的 JSON、未知或缺失字段、不支持的版本、无效引用、非规范 base64、空密文，以及 `dpapi-current-user` 之外的任何记录类型都会明确失败。这里不存在兼容回退：未来格式必须提供显式迁移。整个文档都是 Host 本地数据，必须排除在可携带的安装导出和 Host 更换备份之外。

写入在 [`dsh-atomic-write`](../../util/atomic-write/README.md) 的跨进程锁内重读文档、替换一条记录、按引用排序以获得确定性输出，再原子提交。同一提供方实例中的写入串行执行；删除不存在的引用是空操作。`credentials/updated` 只在发生变化的文档提交后触发，且只携带引用。

## DPAPI 参数

原生适配器以 `CRYPTPROTECT_UI_FORBIDDEN` 调用 `CryptProtectData` 和 `CryptUnprotectData`。它不传入 `CRYPTPROTECT_LOCAL_MACHINE`，因此 Windows 选择当前用户作用域。描述、可选 entropy、reserved data 和 prompt structure 均为 null；恢复过程没有第二份可携带机密，也不会弹出交互提示。DPAPI 所有的输出在复制后通过 `LocalFree` 释放。

适配器会清零自身的临时明文与密文 `Buffer` 副本。JavaScript 字符串无法可靠清零，因此受信任的提供方消费方必须让解析值只活在当前操作中，不得记录、缓存、投影或序列化它。

## 解析与安全观察

`resolve(ref)` 在每次操作时读取并校验当前文档，解密选中的记录，并返回非空值、来源 `windows-dpapi-current-user` 与保护级别 `local-user-trust`。`resolveRequired(ref, CREDENTIAL_PROTECTION_LOCAL_USER_TRUST)` 是消费方的失败关闭入口：缺失值以及缺失、无效或不同的保护元数据都会在调用方拿到值之前失败。

`describe(ref)` 只返回 `ref`、配置状态、来源、保护级别、可写性、健康状态和观察时间。它探测当前用户能否解密，但不会构造含凭据的 JavaScript 字符串。复制而来、损坏或作用域不同的记录报告为 `configured: true, health: 'unavailable'`；原始密文和原生输入字节绝不进入结果或诊断消息。

只有受信任的 Host 插件应当拿到原始凭据服务。浏览器 API、Agent 工具、Projection、Session 事件、日志、诊断、崩溃产物和可携带导出应当只携带 `CredentialRef` 与安全观察，绝不携带明文或密文。

## 模型体验

经由 `ctx.credentials` 的消费方间接生效：解析值可以为某个提供方操作授权，而所有模型可见效果都由该消费方负责。本包不注册 prompt、工具或模型上下文。

#### KV Cache 影响

无直接失效；凭据绝不进入请求前缀。

## 已知限制与暂缓事项

- **同用户代码可以解密复制来的记录**——只有独立隔离的凭据代理或外部机密管理器，才能让 Host 提供的凭据真正不可被 Agent 进程取得。
- **恢复与 Host 绑定**——把文档移到另一 Windows 用户或机器通常会让记录不可用；请在目标 Host 上重新授权 OAuth 账户或重新导入私有材料。
- **外部编辑不触发事件**——每次操作都会重读文件并观察到修改，但只有提供方自身的提交会发布 `credentials/updated`。
- **JavaScript 字符串无法清零**——临时字节缓冲区会被清零，但已解析字符串仍受 JavaScript 运行时的内存行为约束。
- **原子但不具备崩溃持久性**——继承自 `dsh-atomic-write`；下次启动或操作会重新校验完整文档。
