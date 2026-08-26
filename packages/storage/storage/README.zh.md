# @deepseek-ai/dsh-storage

[English](README.md) | 中文

非会话数据的存储中心（`ctx.storage`）：具名后端注册表加已挂载的数据形式设施。中心自身不执行 IO：后端拥有介质，数据形式拥有语义。[存储家族概述](../README.zh.md)列出了这些包；[领域 KV 存储 Agent Note](../../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.zh.md)记录了设计理由。

## 结构

- `ctx.storage.backend`：名称 → 后端表。多个后端并排保持挂载（`json`、`sqlite`）；为消费方提供服务的后端由该消费方自身的配置决定（领域层的路由表），绝非中心的全局选择。`register()` 返回资源释放函数；注册重复名称或查找未知名称时都会明确报错。
- `ctx.storage.mount(form, facility)`／`ctx.storage.form(form)`：数据形式挂载。`StorageForms` 可通过合并扩展；领域层合并 `domain`，并通过 `ctx.storage.domain` 访问。
- 后端拥有一种介质，并公开其支持的数据形状**分面**。当前分面为 `kv`；`src/backend.ts` 负责定义其确切约定。Unit 版本必须是非负安全整数；负零无效。存储值必须是精确的 JSON 数据：编码不得省略或强制转换 `undefined`、非有限数、负零、稀疏数组、循环引用、访问器或特殊对象。文本型值使用共享的严格 parser；它还会拒绝注释、尾随逗号、重复对象成员，以及会被 JavaScript 舍入、下溢或上溢的数字词法。写入输入只在准入期间借用，`loadAll()` 返回完全分离的值图，因此调用方之后的变更无法改变内存状态或持久状态。后端关闭会先同步停止新的打开与实时 unit 方法，再排空已接纳工作。后端还可以公开 `kv.closed`，在没有实时句柄时对 unit 做非变更性检查与读取，以及仅创建式物化。每次冷操作都在回调作用域的名称预留中运行：普通打开与竞争预留会立即失败。`ClosedUnitReservations` 是共享的名称所有权与结算跟踪器；后端在调用 `reserve()` 前拒绝关闭开始后的预留请求以及实时／打开冲突，并在关闭时先停止准入，再等待 `settlements()`。作用域一旦观察到 callback 已结算，就会停止向 lease 接纳新方法，因此逃逸出去的 lease 与 commit token 都以 `closed` 拒绝；名称预留的释放与后端关闭都会等待此前已经接纳的每个 lease 方法排空，包括 callback 未等待的方法。
- 写入只有在达到持久状态后才会完成。请求值已经可见但无法确认持久性时，`durability-uncertain` 携带 `published: true`；无法判断是否已经发布时，`commit-outcome-unknown` 携带 `publicationPossible: true`。调用方必须停止通过该实时 unit 提供服务、将其关闭、丢弃并重建受影响的后端（或重启），然后才能从介质重新打开。仅创建式冷物化返回 lease 作用域的 `durable` 或 `uncertain` 结果，不会把这些结果折叠成发布前拒绝。

## 模型体验

### 后端与形式注册

#### 模型看到的内容

无。`ctx.storage` 是主机侧注册表；中心不注册工具、不注入提示词，也不写入会话事件。

#### Token 影响

每次请求都不会直接增加 token。

#### KV Cache 影响

与实时请求相互独立：中心绝不触碰请求前缀，因此无法使提供方缓存复用失效。

## 已知限制与暂缓事项

- **`kv` 是唯一的数据形状**：后端目前只有一个分面需要实现。
- **数据形式按需解析**：在领域插件挂载前读取 `ctx.storage.domain` 会抛出 `form-not-mounted`；组装会按相应顺序排列插件（错误配置会明确报错，而不是静默推迟处理）。
