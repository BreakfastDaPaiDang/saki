# @deepseek-ai/dsh-storage-domain

[English](README.md) | 中文

DeepSeek Harness 存储中心的领域数据形式：在所有已配置的后端注册后，公开可注入的 `ctx.storageDomain` 服务及对应的 `ctx.storage.domain` 投影。一个领域通过 `defineDomain`（zod 记录 schema、从 `z.infer` 派生的类型）声明一次，通过 `DomainFacility.open` 打开，并由具有最终决定权的内存状态提供服务：读取同步执行；写入在每个领域各自的一条链上串行化，先在已路由后端达到持久状态，再更新内存并发出 `domain/changed`。后端一旦报告发布或持久性不确定，实时领域就会中毒，但不会改变内存或发出事件：原调用方收到后端原始错误，所有已排队及之后的读写都以 `write-outcome-uncertain` 拒绝，`close()` 仍会排空并释放句柄。恢复时应关闭该句柄、丢弃并重建受影响的后端（或重启），然后才从介质重新打开。打开领域的消费方负责管理句柄的生命周期，并通过 `Domain.close()` 释放它（幂等；通常作为其自身的 `ctx.effect` 资源释放函数）；插件卸载时，该设施会尝试关闭每个剩余领域并等待全部结束后才报告失败，而且始终卸载其存储形式。维护期间，`defineDomainMigrations` 声明完整的逐版本前向链，`DomainFacility.migrate` 校验已关闭的保留版本源，并以仅创建方式物化到另一个缺失目标；`materialize` 为全新的当前版本状态提供相同的校验与发布路径。

`DomainSpec.version` 必须是非负安全整数；负零无效。

设计原理、打开语义和存储／领域分层见 [Agent Note](../../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.zh.md)。

## 配置

| key | 含义 |
| --- | --- |
| `backend` | 每个领域的默认后端名称（必填；不存在普遍适用的存储介质）。 |
| `routes` | 逐领域覆盖：领域名称 → 后端名称。 |

## 冷迁移

迁移是显式且按需启用的。普通 `open` 保持严格版本匹配，绝不会发现或改写旧 unit。`defineDomainMigrations` 是唯一的计划构造器：它校验连续链，并捕获 schema 声明容器的冻结副本，因此伪造计划或之后修改原声明都无法改变已接纳计划。迁移会预留领域名和两个后端的 unit 名，在读取源之前拒绝已经存在的目标，校验保留版本的源 schema 以及每个相邻步骤的输出，再在同一预留中读回目标。读回必须在原始 JSON 数据语义上等于拟写的已校验快照（对象成员顺序无关），并独立通过当前 schema；即使值仍符合 schema，只要被改变也会以带 `committed: true` 的 `migration-target-invalid` 拒绝。源不会改变；过程中不会打开实时领域，也不会发出 `domain/changed`。调用方取消在目标发布之前有效。不确定物化会按读回证据分类：精确返回的目标报告带 `committed: true` 的 `migration-target-durability-uncertain`，确认缺失报告 `migration-target-not-committed`，读回拒绝则报告 `migration-target-outcome-unknown`。持久物化的提交结果已知；若其读回拒绝，目标无法验证，因此报告带 `committed: true` 的 `migration-target-invalid`；成功返回但不符合 schema 或发生偏离的快照也报告同一失败。任何一种结果都不会触发盲目重试或删除目标。

## 模型体验

### 持久领域状态

#### 模型看到的内容

无。该包不注册工具、不注入提示词，也不追加会话事件；它在 `ctx.storageDomain` 后面存储非会话数据（工作区记录、未来的会话伴随数据），只发出进程内 `domain/changed` 事件。只有 Consumer 包通过自身有文档说明的接口呈现该事件时，它才会到达模型。

#### Token 影响

为零。该包的文本不会进入任何模型请求。

#### KV Cache 影响

相互独立：领域读写绝不触碰请求前缀，因此这里没有任何内容能使提供方缓存复用失效。

## 已知限制与暂缓事项

- **变更只在单进程内可见**：`domain/changed` 是进程内事件；在 Agent Note 暂缓的跨进程修订模式落地前，第二个主机进程或重新连接的 GUI 无法观察变更。
- **没有跨表事务、二级索引或多段键**：每次写入只触碰一条记录；这些扩展的触发点和返工点列在 Agent Note 的暂缓工作清单中。
