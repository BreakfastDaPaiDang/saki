# Agent Note: Saki 控制面与 capability seam

Status: proposed

[English](2026-08-18-saki-control-plane-capability-seams.md) | 中文

## 问题

Saki 需要一个位置协调 Work Item、Work Session、Agent Run、模型账号 routing、生图、自动化与恢复规则，同时不得把产品 policy 写进上游 DSH package、让 Web 代码直接耦合 provider SDK，或为每个现有 DSH Service 新建浅 Saki 包装层。初始 package 边界必须在领域形成期保持易变，也要保留未来可替换的远程 Host 边界。

## 提案

以 plugin-composed modular monolith 实现 [ADR 0006](../../../../docs/adr/0006-modular-control-plane-and-four-capability-seams.zh.md)、[ADR 0007](../../../../docs/adr/0007-single-control-plane-and-enrolled-hosts.zh.md)、[ADR 0012](../../../../docs/adr/0012-forward-migrations-and-installation-maintenance.zh.md)和 [0.1.0 后端架构](../../../../docs/saki/architecture/0.1.0-backend.zh.md)。Saki 自有 package 位于 `packages/saki/`，使用 `@breakfastdapaidang/saki-*` 命名空间。一个深 `saki-control-plane` package 把 Work Management、Agent Operations、Model Supply 和恢复保持为私有 module。它把 `SakiAccess.readAccess`、`exchangeBootstrap` 与 `logoutCurrentSession` 和 `SakiControlPlane.submit`、`query` 与 `onChanged` 并列暴露；Host API 发布这两个 Interface。

持久化稳定 Saki Installation identity 与已登记 Saki Host registry。0.1.0 在同一进程运行一个活动控制面写入者和一个具有独立身份的 Local Host；迁移前让旧写入者完全停稳，不支持活动—活动控制面。每个 Host 回报可重新验证的 capability inventory，并拥有机器本地资源解析。Resource Binding 与 Host operation 指向 Host identity，而不是隐式本机。

0.1.0 只增加四个 Saki capability seam：Host Execution、GitHub、Model Account 和 Image Generation。它们共享 Control Intent identity、稳定外部 reference、provider-neutral error category、cancellation signal 和 reconciliation 义务，但不实现万能 adapter 基类。它们的授权、取消、排队、自然身份和结果观测语义差异足够大，需要精确的 capability-specific Interface。

已实现的[已有目录 Project 登记](../../implemented/architecture/2026-08-20-saki-existing-directory-project-registration.zh.md)提供只读 Host Execution definition、Local Host Provider 与首个控制面 Consumer 操作。本 Agent Note 保持 proposed，因为 Host 修改操作以及 GitHub、Model Account 与 Image Generation seam 尚未实现。

Workspace、Session、Agent、LLM、compaction、credential reference、attachment、live job、skill、file、shell、terminal、sandbox 与 tool 直接使用现有 DSH Service。除非产品需要 DSH Interface 无法表达的行为，否则不增加透传包装层。普遍可复用的缺失行为，应先进入上游或通用 DSH Provider，再考虑成为 Saki 专用能力。

把 Saki 权威控制状态通过 `storageDomain` 路由到专用 SQLite 数据库。通用可选 schema migration 继续由 `storage-domain` 拥有；Saki 专属 generation 切换、Recovery Backup、加密 Installation Export、restore、retention 与替换 Host 恢复属于 `installation-maintenance` 产品 plugin。[Migration 与维护 proposal](2026-08-18-saki-forward-migrations-and-installation-maintenance.zh.md)定义这项所有权分离，但不增加第五个外部 capability seam。

Host transport 只暴露公共 `SakiAccess` 与 `SakiControlPlane` 操作。Host API 从 HTTP state 取得请求呈现的 cookie，并使用只对该 trusted Consumer 可用的 package-private SakiAccess resolver 构造 `AuthenticationContext`；resolver 与 context 都不是 wire API。它把该 context 显式传给每次受保护 `query(authentication, query, signal)` 与 `submit(authentication, intent, signal)`，后两者重新验证 Browser Session、Installation generation、Principal lifecycle，以及当前 Grant scope 与 revision。Bootstrap exchange 与 logout 是仅有的两个不经过 Control Intent 的产品 mutation，并且只修改 Installation Access aggregate。Principal 或 Grant 变化会使受影响 Projection 失效。Web client 不接收 Provider object、storage handle、必需的本地路径、活动 DSH handle、secret 或 provider-specific response object。未来远程 Host 实现 Host Execution，但不获得 Work Item、policy、模型选择或恢复所有权。

把已安装 Cordis 与 npm plugin 视为有特权的 Host 代码，而不是沙箱扩展。模型动态生成的 plugin 在操作者审查与安装前保持一次性。原始 credential value 留在目标 Host 的 capability Provider 内；控制面保存不透明 reference 与观测。[已实现的 DPAPI 凭据决策](../../implemented/architecture/2026-08-18-saki-local-user-trust-dpapi-credentials.zh.md)进一步细化 0.1.0 的这项规则，但不声称具备同用户 Agent 隔离。浏览器 client、GitHub 用户、仓库内容、模型输出和外部事件 payload 都位于 Host 信任边界之外。

## 考虑过的方案

**为每个 bounded context 建立公共 package。** 产品模型仍在变化时，这会过早发布编排依赖。私有 module 可以保留不同语言和所有权，不必把它们变成浅而类似网络服务的接口。

**立即拆分服务。** 第二个 Host 尚不存在时，这会提前增加 RPC identity、transport delivery、局部网络故障和部署工作。逻辑 plane 分离加 Host Execution 已保留后续选择。

**让控制面、当前进程和 Local Host 共用同一身份。** 这会把机器位置嵌进可迁移产品状态，使 backup restore、Host 替换和远程执行失去稳定所有权边界。

**从第一版开始支持活动—活动控制面。** 在第二个部署目标出现前，这就要求分布式 fencing、主节点选举、冲突解决和外部副作用协调。单一活动写入者让当前所有权明确，同时不阻止后续重新设计。

**在上游 DSH package 内实现 Saki。** 这会模糊所有权、增加同步冲突，并让通用 harness 依赖 Saki Project 与 Board policy。

**包装每个 DSH capability。** 透传包装层会隐藏生产实际使用的 runtime、增加维护，并降低上游 contract test 的价值。

**使用一个万能 provider interface。** 公共接口将需要 device authorization、长时间 generation、本地进程取消、GitHub 自然资源对账和 worktree mutation 等大量可选方法。共享少量类型并建立四个完整 seam，更容易测试，也更不易误用。

## 验收条件

- 除 bootstrap exchange 与 logout 外，每个产品 mutation 都通过 `SakiControlPlane.submit` 进入，并在外部副作用前拥有一条持久 Control Intent；两个 access 例外只能通过 `SakiAccess` 修改 Installation Access。
- 控制面测试只在四个 Saki capability seam 替换依赖；现有 DSH Service 使用真实 definition 或上游 test Provider。
- 每个 seam 都以完整 Definition、Provider 与 Consumer 切片落地，而不是成为未使用的抽象。
- 公共 Interface 与 wire payload 不暴露 storage handle、必需 Host 路径、活动 DSH handle、secret value 或 provider SDK response object。
- 凭据相关 Provider 在有特权 Host consumer 之外只暴露 reference 与安全保护观测；在接受更强的 brokered 边界前，组织账号共享保持阻塞。
- Installation 与 Host identity 跨重启保留；Resource Binding 标明所属 Host，不能仅因浏览器能够访问就获得执行权限。
- Installation 维护可以迁移 candidate state generation、发布恰好一个活动 generation，并在不通过控制面 Interface 暴露 storage backend 或机器权限的情况下 restore 可迁移 export。
- Web surface 默认绑定到 loopback；测试把已安装 plugin 归类为有特权代码，同时保持仓库、模型、浏览器与外部事件数据不可信。
- 未来可以用 transport-backed Host Execution Provider 替换 Local Host Provider，而无需把产品 policy 移出控制面。
- 接受第一个 package 前，仓库 package 治理与发布工具必须显式理解 `@breakfastdapaidang/saki-*`。

## 风险

如果不约束私有 module 的所有权与依赖方向，模块化单体仍可能退化为无差别大 package。四个 seam 在所有 provider 协议验证前设计，因此 contract suite 必须推动接口细化，同时避免 provider 特例泄漏进产品类型。Saki 命名空间还跨越了仓库中“所有 package 都是官方 `@deepseek-ai/dsh-*`”的现有假设；遗漏任何治理或发布检查，都可能导致本地与 CI 行为不一致。单一活动写入者让 Host 迁移成为明确运维步骤，但放弃了控制面自动 failover；generation 切换增加维护与磁盘成本；在出现真正进程沙箱前，每个已安装第三方 plugin 都会加入 Host 信任边界。
