# `@breakfastdapaidang/saki-host-api`

[English](README.md) | 中文

Saki 私有双侧 Host API 把控制面适配到共享 Connection 载体。Host 入口注册由 Saki 拥有的 `/saki` 逻辑通道；`./client` 入口在浏览器上下文注册 `ctx.sakiHostClient`。`./wire` 包含两侧共用、适用于浏览器的严格 schema。

## 端点

| 端点 | 请求 | 结果 |
| --- | --- | --- |
| `access/read` | `{}` | 封闭的 Access Projection |
| `access/exchange` | `{ secret }` | Bootstrap 交换结果；`Set-Cookie` 保持在 JSON 之外 |
| `access/logout` | `{}` 与请求令牌请求头 | 登出结果；Cookie 失效响应头保持在 JSON 之外 |
| `control/query` | `{ type: 'project-index' }` | 已认证的空 Project-index Projection 或拒绝结果 |
| `control/submit` | `{}` 与请求令牌请求头 | 认证后返回稳定的 `intent-unavailable` 结果 |

所有请求 schema 都是严格的。`/saki` 会在分派操作或解码请求体前拒绝非空 URL 查询参数。适配器不会忽略试图提供 Principal、Grant、Actor、AuthenticationContext 或生命周期权限事实的浏览器字段。路由信任校验失败、格式错误的信封、方法不匹配、无效的操作载荷、处理方返回的 RPC 错误与意外实现失败都会使用同一种固定且不透明的内部错误，不包含解析器、请求或异常细节。处理方运行前与运行后的每项 Saki 响应，以及成功、拒绝和错误响应，都会携带 `Cache-Control: no-store`；Cookie 响应头保持在 JSON 之外。

## 传输职责

Connection 负责路由信任校验、有界 JSON 封装、请求关联、取消、dispose（资源释放）和 JSON Content-Type。`/saki` 注册要求 Connection 通道应用 `Cache-Control: no-store` 与固定的不透明错误，因此这些策略也覆盖 Host 适配器运行前的故障。Host 适配器只从 Connection 提供的可信请求元数据读取 Cookie、Origin 与 `x-saki-request-token`。它通过控制面仅供 Host 使用的解析器取得 AuthenticationContext，并消费持久提交后不透明的 Cookie 交接值。AuthenticationContext 与原始 Cookie 材料都不会进入浏览器 JSON。

浏览器客户端的每次调用都使用同源凭据。B01 中只有登出接受请求令牌；Intent 映射为空时不存在成功提交方法。业务拒绝仍作为类型化的 RPC 成功值返回，载体故障与 schema 校验失败则使用 Connection 固定且不透明的 RPC 错误信封。

## 模型体验

无。Host 与浏览器适配器传递 Saki 访问和 Projection 值，但不注册模型可见输入。

#### KV Cache 影响

无；该包既不组装也不发送模型提供方请求。

## 已知限制与暂缓事项

- **仅支持回环通道**：`/saki` 使用 Connection 的回环信任策略；远程认证与网络公开需要另一套部署设计。
- **仅有 B01 操作集**：客户端暴露 Access 与空 Project-index 查询。项目登记功能会引入第一个成功的 Control Intent。
- **不包含前端组合**：该包提供客户端服务与 schema，不拥有路由或渲染后的 UI。
