---
description: "从本仓库启动本地 Saki Host，提供持久 Installation 状态、经过认证的项目操作和固定 Development Agent preset。"
kind: "package-bundle"
---

# `@breakfastdapaidang/saki-bundle`

[English](README.md) | 中文

## 概述

从本仓库启动本地 Saki Host，提供持久 Installation 状态、经过认证的项目操作和固定 Development Agent preset。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

Saki 私有组合根。它在 [`dsh.bundle`](package.json) 中声明 [`cordis.patch.yml`](cordis.patch.yml)；该补丁在空的 [`cordis.yml`](cordis.yml) 上挂载定时调度、默认 JSON 存储后端、由启动器替换为同一 manifest-selected generation 的惰性 SQLite 路由，其中共用该 generation 的三个 domain 是 `saki_control_plane@9`、`saki_host_execution@4` 与 `saki_storage_generation@7`；此外还挂载 JSONL Session 持久化及 Session projection registry、与提供方无关的 LLM、Agent、System Prompt、Tools、Agent Loop、preset 与 checkpoint policy 运行时、Workspace、本地文件系统与子进程提供方、沙箱化 PowerShell 栈、Local Host 执行提供方、回环 Web 服务器、Connection、Saki 控制面、`/saki` Host API 与 `saki-readiness`。

启动器把 preset 名册绑定到包内 `config/agent-presets` 的绝对路径，并禁用 DSH 随包 preset 和用户 preset 根目录。随包提供的 `development` preset 提供仓库指令、持久 `request_intervention` 工具、Windows 前台 PowerShell，以及基于 Agent 隔离沙箱文件系统的 `read`、`write` 与 `edit` 工具；Host 操作继续使用独立的本地文件系统提供方。生产组合不安装模型 adapter；创建或恢复 Agent 后会保持 idle，直至拥有该 Agent Run 的 operation 提交持久输入。

在 Windows 上，该组合还挂载当前用户 DPAPI 凭据 Provider 与 Saki Product GitHub App Provider；不支持的平台会禁用这两个配置项，而不会把更弱的凭据来源报告成 `local-user-trust`。启动流程会先根据精确的 succeeded Host Operation 与物理 Session evidence 恢复每个已经过控制面校验的 running Agent，随后启动器才会发布就绪记录或 bootstrap handoff。就绪配置项提供稳定的 `{"product":"saki","status":"ready"}` 记录。启动器只在 `boot()` 完成配置项激活审计后将其写入 stdout；报告失败时，启动器会对应用执行 dispose（资源释放）并进入失败路径。

在 POSIX 上，Connection 通过 `dsh-credentials-local` 将浏览器会话签名记录存储在 harness home 中，保护等级为 `plaintext`。Product GitHub App 在该平台保持禁用；它要求的 `local-user-trust` 由 Windows DPAPI 组合提供。

在仓库根目录运行：

```sh
pnpm run saki
```

该命令通过仓库的 ESM 钩子与路径映射启动 TypeScript 源码。执行 `pnpm run build:lib:host` 后，对应的产物平面命令是 `node packages/saki/bundle/lib/bin.js`。两者解析同一个由包声明的补丁，并持续运行至收到 `SIGINT` 或 `SIGTERM`。`SAKI_ONESHOT=1` 保留供组装冒烟测试与快照使用的“就绪后退出”模式。

启动组合前，启动器会取得 Installation 全局排他 lease、调和精确具名的恢复元数据，并且只通过 `installation.json` 选择状态；没有 manifest 时才使用精确配置的 B03 数据库。无状态 Installation 会直接配置为当前 state v9。任何精确保留的 v2 至 v8 Installation 都会以 `upgrade-required` 闭合失败；启动当前 build 前需让其 Host 保持离线，并通过保留的维护迁移升级到 v9。启动器在准备、对外服务和完整 teardown（拆卸）期间始终持有 lease；畸形或不受支持的选中状态也会闭合失败。

每次非一次性启动还会写出一行启动器交接 JSON，其中包含 `bootstrapPurpose`、`bootstrapSecret` 与回环基础 `url`。首次完成前用途为 `initial-bootstrap`，此后为 `local-reauthentication`。明文机密值只供立即执行本机登录使用；不得重定向、持久保存或公开这行内容。重启会保留先前尚未过期的挑战并签发新挑战；交换任一状态为 `issued` 的挑战时会消费该挑战，并撤销其余挑战。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `SAKI_DATABASE_PATH` | `dshHomePath('saki', 'control.sqlite')` | 精确的无 manifest B03 源路径；它绝不覆盖 manifest，且拒绝 `:memory:` |
| `SAKI_PORT` | `43119` | 回环 HTTP 端口，必须是 `1` 至 `65535` 的整数 |
| `SAKI_ONESHOT` | 未设置 | 设为 `1` 时打印就绪记录并退出，且不消费 bootstrap 交接值 |

<a id="model-experience"></a>
## 模型体验

无，因为本地 Host 组合会把所有模型可见输入与请求委托给它挂载的包。

#### KV Cache 影响

基础 Host 不安装模型 adapter，因此启动 Session 或恢复已经 running 的 Run 不会发起模型请求、wake 或产生模型可见消息。配置模型 provider 后，恢复已接受但尚未交付的 Intervention 回答时可以只追加该条精确回答、唤醒其所属 Run，并发起对应请求。其他 Agent Run 输入仍通过显式配置的 route 进入。`development` preset 会加入稳定的 persona 与工具 schema 前缀，其中包括持久 `request_intervention` 以及 `read`、`write`、`edit` 和 Windows `pwsh`；仓库指令和当前 sandbox／approval 事实仍属于请求上下文，提供方特定的缓存行为由所选 route 负责，而 Intervention 回答是既有 Session prefix 之后仅追加的输入。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

- **受限的 GitHub mutation**：操作者安装并配置 Product App 后，Windows 组合可以发布已确认的 Board 读取结果、执行可恢复的 `CreateWorkItem` 与 `MoveWorkItem` saga，并通过持久 marker，根据准确 Repository、head、base 与 Commit identity 创建 Branch Delivery PR。尚未提供任意 Issue edit、Repository Contents 与 Workflow write。
- **只支持有界 Project 生命周期**：Host 支持本地访问、已有目录检查、Development Project 首次登记、Project index 与 workspace 读取、返回有界 repository-relative 展示路径且不暴露规范 Host 路径的 Changes 读取、同样不暴露规范 Host 路径的有界 Diff 页面读取，以及浏览器请求不携带路径的直接结构化 stage、unstage 与 Commit 操作。Branch Delivery Push 已通过 Local Host 组合，但默认未设置 `pushCredentialHelper`，因此保持不可用；操作者必须选择 `git-credential-manager` 或 `git-credential-manager-core`。尚未组合 Resource Binding 重绑定与退役、automated dispatch、生产模型 adapter 和渲染后的 Web 界面。
- **固定的 Product Agent 能力**：名册只发现由系统拥有的 `development` preset。用户自定义 preset 要等其授权规则与 Project Profile 选择语义确定后，才会进入 Saki Host。
- **可执行入口仅供仓库本地使用**——Saki 包保持私有，不属于任何 npm 发布族。
- **仅限回环开发 Host**：固定的本地 bootstrap 流程不会授权远程浏览器，也不替代 [Saki Host 启动器](../../../docs/saki/host-launcher.zh.md)所述的 Windows Host 包装层。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

不发布 runtime invariant companion，因为该包拥有静态组合元数据，并将可变状态交给挂载的服务。

</details>
