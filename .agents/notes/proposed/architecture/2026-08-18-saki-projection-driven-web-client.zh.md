# Agent Note: Saki projection-driven Web 客户端

Status: proposed

[English](2026-08-18-saki-projection-driven-web-client.md) | 中文

## 问题

Saki 必须在一个 Web 产品中呈现本地 Git、GitHub 权威、Agent execution、model supply、自动预算与恢复状态。若浏览器 component join 后端记录、推断权限，或把 push frame 与乐观 gesture 当作权威，重连与失败路径就会和控制面不一致。在这些状态得到验证前定义最终视觉布局，也会把产品正确性与审美偏好混在一起。

## 提案

`packages/saki/web-ui` 在 0.1.0 中保持为一个 DSH 客户端 plugin，并遵循已发布的客户端 Cordis、slot、不可变 snapshot 与 React projection 架构。它通过 `saki-host-api` 消费完整 Saki Projection 并提交 Control Intent；任何 component 都不直接调用 GitHub、Git、filesystem、credential 或 provider。`onChanged` 与 Host frame 使读模型失效，重连则重建它们。

类型化 `SakiViewAddress` 值在不使用 Host 路径的情况下保留 Project 与 object 上下文。客户端区分 confirmed、refreshing、optimistic、stale、conflict、unavailable、repair、reconciliation、intervention 与 empty state。Intent overlay 保留已确认 baseline，并持续存在，直到 Projection 确认外部结果。Project 切换会在所属 address 下保留 draft、pending work 与未提交状态。

Saki 保留已交付的 DSH AppFrame、侧边栏、Conversation 和 Settings 实现。DSH 增加通用的 root scope `main.surface` chain slot，其 fallback 渲染 Conversation，并在 New Session 下方增加 `sidebar.primary.action` list slot。Saki plugin 使用这两个接口提供页面与主要入口；DSH package 不导入 Saki 类型。更小的增量继续使用现有 session header、conversation view 和 settings section slot。

0.1.0 只增加两个 Saki 顶层页面。「工作」用小白可操作的形式呈现跨已授权 Project 的 Principal scope 工作，并在用户请求前隐藏技术 evidence。「项目」为一个已选择 Development Project 提供看板、里程碑、变更、会话与运行、追溯和项目设置等内部目的地。Conversation 与 Settings 继续是继承的 DSH 页面。两个 Saki 页面都与详细视图消费相同的 Projection、提交相同的 Intent。[前端约定](../../../../docs/saki/architecture/0.1.0-frontend-contract.md)和 [Web UI 接入基线](../../../../docs/saki/architecture/0.1.0-web-ui-baseline.md)定义必需 Projection、流程、保留的 DSH 页面、少量壳层改动、可访问性语义与产品级验证。它们有意不决定布局、视觉层级、密度、颜色、字体、动效与 branding，留待 prototype 复核。

取代检查没有发现 Saki 专属前端 Agent Note。本提案扩展而不替代已实现的 [GUI 分层与 RPC](../../implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md)以及 [Web 客户端架构](../../implemented/architecture/2026-07-19-gui-web-client-architecture.md)决定。提议中的[动态客户端 package](2026-08-08-cordis-web-dynamic-packages.md)继续作为独立基础设施；Saki 使用已发布 plugin 路径，但不会让自己的发布依赖尚未解决的 loader 工作。

## 考虑过的方案

**让 component 调用 provider API。** 这会绕过 Actor 派生、Grant、policy、恢复与类型化 Host transport。

**在一个全局浏览器 store 中镜像后端 entity。** 浏览器 join 会复制所有权，并让部分 refresh 显得具有权威性。

**把 push delta 应用为持久事实。** Notification 可能丢失，且被定义为 invalidation hint；完整 Projection 继续作为 baseline。

**立即把每个 Saki view 拆成 package。** 单一 release 与 Consumer 不足以证明多个 package 生命周期；内部 domain 会保留未来拆分点。

**由 Saki plugin 替换 DSH root 或 sidebar。** 这会复制 navigation、settings、响应式 layout 和上游 UI 维护。两个通用的可累加 slot 以更小接口暴露所需变化。

**通过 `shell.overlay`、Settings 或合成 Session 渲染 Saki 页面。** 这些位置分别承载瞬时 chrome、部署配置或 Session scope 状态。把它们用于 Project 页面会让错误的 owner 持有 navigation 与 lifecycle state。

**把一个驾驶舱设为产品首页。** 这会迫使小白工作、项目规划、execution evidence、Git 评审和 Host operation 共用同一阅读任务。多个页面可以保留它们之间的关系，而无需同时显示。

**把每个内部目的地提升为全局导航。** Board、Changes、Run 与 Trace 共享一个已选择 Project 及其生命周期。在读者或发布生命周期尚未分化前创建独立全局页面，会提前扩大 navigation，并使 Project 切换更难推理。

**在架构文档中锁定高保真设计。** 视觉偏好需要 prototype 对比，而状态与失败语义需要持久约定。

## 验收标准

- 每个 mutation gesture 都提交类型化 Intent，并显示其目标 Project、confirmation、conflict 或 recovery state。
- 重连、reload 与 Project 切换会保留或重建状态，不会把乐观数据转换为权威。
- DSH conversation、Terminal、attachment、settings 与 tool presentation 通过 service 和 slot 复用。
- 小白无需打开 Git、model supply、budget 或同步 control 就能完成一次「工作」闭环。
- 组合后的 0.1.0 bundle 只在主要导航中增加「工作」与「项目」；「项目」内部区段保留所选 Project 与返回 address。
- Saki 页面通过 `main.surface` 激活；移除 Saki plugin 后，普通 Conversation fallback 与 sidebar 会恢复，且不残留 navigation state。
- 低保真 prototype 在无需同时显示多个 pane 的情况下完成 dogfood loop；高保真视觉继续单独复核。

## 风险

完整 Projection 的 scope 过大时可能过量读取，因此 Diff、log 与 event history 保持有界或分页。「项目」页面可能积累无关职责；每个内部目的地只承担一个任务，只有出现独立读者、导航生命周期、跨 Project scope、Consumer 或发布生命周期后才提升为顶层。单个 Saki UI package 也按同一规则判断拆分。两个通用 DSH slot 会增加上游维护，因此必须不包含 Saki 语义。把视觉决定与约定分开会推迟 polish，但能防止审美 prototype 掩盖缺失的 conflict、offline、intervention 与 recovery state。
