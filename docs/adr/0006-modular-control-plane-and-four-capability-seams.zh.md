---
status: accepted
---

# 在四个 capability seam 后构建一个模块化 Saki 控制面

[English](0006-modular-control-plane-and-four-capability-seams.md) | 中文

0.1.0 是由插件组成的模块化单体：Saki 特有 package 位于 `packages/saki/`，使用 `@breakfastdapaidang/saki-*` 命名空间；一个深控制面 Module 在内部包含 Work Management、Agent Operations、Model Supply 和恢复模块。外部变化只通过四个新增 capability seam 进入：Host Execution、GitHub、Model Account 和 Image Generation。Session、Agent、Workspace、LLM streaming、凭据、attachment、compaction、skill、job 和 tool 继续使用已有 DSH Service 作为接口。

## 为什么这样决定

Saki 领域仍在形成，开始工作、预留工作树、选择模型账号、同步 GitHub 和解释证据等产品规则需要协同变化。此时按 bounded context 拆成多个 package，会在所有权稳定前把编排数据暴露成公共接口，并把一次产品操作变成对多个浅 package 的调用。把私有领域模块放在同一个控制面 Interface 后，可以集中处理授权、revision、Control Intent 恢复和 Projection 构造，同时不合并各自的领域语言。

Host 资源、GitHub、提供方账号和生成式媒体提供方确实存在不同实现或外部协议，因此值得建立可替换 seam。其他所需能力已经由 DSH 提供；为每个已有 Service 包一层同名 Saki 接口，只会增加透传接口、丢失上游改进，并让测试停留在包装层而不是 Saki 真正使用的运行时。

Saki 自有路径与 package 名称让上游同步过程中的所有权保持可见，避免产品 package 看起来像官方 `@deepseek-ai/dsh-*` module；单仓库仍允许在 DSH 接口变化时进行原子更新。

## 考虑过的方案

**为每个 Saki bounded context 建立公共 package。** 形式上更纯粹，但在尚无独立 consumer、部署或发布周期时，会过早形成跨 context 公共依赖图。私有 module 可以保留语言分离，又不承担这项协调成本。

**在 0.1.0 拆分控制面与执行面服务。** 第二个 Host 尚不存在时，这会提前引入 RPC 认证、交付、部署和局部网络故障。已经接受的逻辑分离保持不变；未来网络 adapter 可以实现 Host Execution，而无需移动产品规则。

**把 Saki 行为写入上游 DSH package。** 这样 package 数量更少，但会增加合并冲突、模糊所有权，并让通用 harness 依赖 Saki 的 Board 和 Project 语义。

**为每个 DSH Service 新建 Saki seam。** 透传包装层会成为只有一个实现的浅 Module。Saki 直接依赖稳定的 DSH Service Definition，只在行为确实变化或必须隔离外部协议时新增 seam。

**使用一个万能外部 adapter 接口。** Host 操作、GitHub mutation、设备授权和生图 attempt 的取消与观测语义不同。只共享标识、错误类别和对账规则，可以让每个 Interface 保持精确，避免积累大量可选方法与字段。

## 影响

控制面 package 是一个深 Module，不是一组导出的 repository 或 domain manager。它的公共 Interface 只包含 Intent 提交、类型化 Projection 读取和失效通知。只有出现独立 consumer、部署、安全生命周期或发布节奏时，内部 context module 才拆成 package。

每个新增 capability seam 都包含 Service Definition、至少一个 Provider 和一个 Consumer。提供方专用 package 不拥有 Saki Project 语义，Web 代码也不直接调用它们。Saki 后端参考文档定义初始 Interface 与 package 拓扑。

第一个 Saki package 落地前，仓库检查与发布工具必须识别 Saki 命名空间，同时不削弱现有 `@deepseek-ai/dsh-*` 规则。除非明确增加独立 Saki 发布流程，否则 0.1.0 的 Saki package 保持 private。
