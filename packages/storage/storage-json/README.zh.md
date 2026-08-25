# @deepseek-ai/dsh-storage-json

[English](README.md) | 中文

[存储中心](../storage/README.zh.md)的 JSON 后端：配置根目录下每个单元使用一个人类可读的 `<unit>.json` 文件，并以可配置的名称注册；该名称默认为 `json`。设计见[领域 KV 存储 Agent Note](../../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.zh.md)。

## 模型

- 内存中的单元状态具有最终决定权；每个写入原语都会通过临时文件写入 + fsync + 原子 `rename()` 替换重新发布整个文件。单元文件始终是完整的当前状态：可读性是该后端存在的理由，规模问题则属于 SQLite 后端。
- 每个已物化文件都使用物理 v1 的精确字段 `unit`、`global` 与 `tables`；`unit` header 只携带名称、领域拥有的版本、`formatVersion: 1` 与全局槽声明。物理格式版本独立于领域迁移版本演进。普通读取与 closed 读取使用致命 UTF-8 解码并共用一个严格无损 parser：非法字节序列、字节序标记、注释、尾随逗号、嵌套重复成员、会被 JavaScript 舍入、下溢或上溢的数字词法、无版本或不受支持的文件、未知字段、布局差异、外来 header 及其他畸形数据都以 `malformed-medium` 拒绝；只有领域版本不同时才以 `version-mismatch` 拒绝。
- 缺失文件会作为空 unit 打开，并在第一次写入时物化。后端在构造时把配置根一次解析为绝对路径，并固定其创建或观察到的第一个真实目录身份。根必须持续为真实目录，每个已有 unit 入口必须持续为普通文件；symbolic link、Windows junction、dangling link，以及读取期间观察到的入口替换都以 `malformed-medium` 拒绝。若在 `rename()` 或 `link()` 紧前检测到根目录替换，则以确定的 `malformed-medium` 失败，且不会发布最终入口；若在 `rename()` 或 `link()` 之后检测到不匹配，则报告 `commit-outcome-unknown`：直接 unit 或实时领域会中毒，closed 物化则返回 `uncertain` token，以便保留证据地读回。
- 跨调用的写入顺序属于调用方（领域层的写入链）；每次调用都在发布前验证并克隆可无损保存的 JSON，且只有达到持久状态后才会完成。确定发生在发布前的失败会恢复先前内存状态。如果替换已经可见但目录持久性失败，调用会以带 `published: true` 的 `durability-uncertain` 拒绝，并在内部保留已发布状态；该直接 unit 随后的每次读写都会拒绝，直到它被关闭。跨 provider 恢复会丢弃并重建受影响的后端（或重启），再从介质打开新 unit。`loadAll()` 返回分离的值图，因此之后变更写入输入或已加载快照都无法改变内存状态或持久状态；`close()` 会同步停止准入并排空此前接纳的读写。
- 可选的 `kv.closed.withReservedUnit` operation 会在返回 promise 前预留一个 unit 名。作用域一旦观察到 callback 已结算，就会停止向 lease 接纳新方法；名称预留的释放与后端关闭都会等待 callback 以及此前已经接纳的每个 lease 方法，包括 callback 未等待的方法。该 lease 可以在不打开或更改 unit 的情况下检查和读取，也可以先验证再原子物化完整的缺失 unit，而不替换任何已有入口。预留遇到存活句柄、正在打开的访问或其他预留访问时立即以 `unit-open` 拒绝。发布前方法观察调用方的 `AbortSignal`。仅创建式发布在目录同步失败后绝不删除已经链接的最终入口，并返回 `uncertain` token；同一 lease 的 `readBack()` 会提供精确可见性证据，迟到的 cancellation 不会阻止该读回。

## 配置

| Key | 类型 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `backend` | string | `json` | 存储注册表与生命周期服务名称；不同名称允许同一组合挂载多个 JSON 根目录 |
| `root` | string | 必填，无默认值（cwd 回退会让文件散落各处） | 保存单元文件的目录；构造时相对当前 cwd 一次解析并按需以 `0o700` 创建，最终入口绝不接受 symbolic link 或 junction |

## 模型体验

### 已存领域记录

#### 模型看到的内容

无。该后端不贡献提示词、工具或 schema；它在 `ctx.storage` 后面持久化非会话领域数据，只供宿主侧消费方使用。

#### Token 影响

实时请求 token 为零。

#### KV Cache 影响

无：该后端从不触碰实时请求前缀。

## 已知限制与暂缓事项

- 缺失单元物化要求文件系统支持同目录 hard link，以同时保持原子发布和仅创建语义。
- Windows 命名空间持久性没有显式 write-through 调用：普通替换依赖 libuv 的 `rename()`，缺失单元物化则通过无覆盖 hard link 发布已同步的临时文件。追加日志分面落地时，计划把会话日志后端更严格的 Win32 辅助函数下移到此处（见 Agent Note 的迁移章节）。
- Node 的路径型文件系统 API 无法在所有受支持平台上把发布绑定到已经打开的目录句柄。后端会在发布前后立即检查固定的根身份并拒绝检测到的替换，但其他进程仍可能在最后一次路径解析间隔内替换根；部署必须让宿主独占配置根的管理权限。
- 没有跨进程写锁：两个进程写入同一根目录时，可能交错执行整文件替换（最后写入者胜出）。当前消费方采用单一宿主进程部署；多进程方案按 Agent Note 的范围外事项表暂缓。
