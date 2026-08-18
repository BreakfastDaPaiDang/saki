# Agent Note: Saki 0.1.0 低保真 prototype 作为独立的 fixture 驱动应用

Status: implemented

[English](2026-08-19-saki-k0-lowfi-prototype-standalone-app.md) | 中文

## Problem

K0（issue #42）要求一个可点击、可键盘操作的低保真 prototype，在 K1–K6 拆分生产前端实现前证明两个新增顶层页面可行。已交付的 DSH Web 客户端只能在 dsh host 内启动（host 注入的 boot 数据、cordis plugin tree、构建后的 `lib/` bundle），而 Saki 需要的两个壳层 slot（`main.surface`、`sidebar.primary.action`）尚不存在——把 prototype 嵌入真实客户端会把 K1 的壳层工作拖进 K0。同时，prototype 必须忠实地演示前端约定（带 revision 的完整 Projection、携带 expected revision 的 typed Intent、作为 Projection 事实的 Action Offer、十种视图状态语义），而不是随意的 mockup。

## Decision

prototype 位于 `prototypes/saki-0.1.0-web/`，是一个带独立 npm lockfile 的 Vite + React + TypeScript 独立应用，在 pnpm workspace glob 之外，因此 knip/publint/constraints/coverage 等门控不适用于这个供拍板的过渡 artifact。它具有产品代表性但不是生产代码：CSS Modules 配合 DSH 暗色风格 token、中文产品文案，以及与 `packages/client/*` 相同的 props 下行组件纪律。

fixture 控制面（`src/fixtures/engine.ts`）恰好实现约定的三个控制面操作——`query` 返回带单调递增 revision 的完整 Projection，`submit` 为 typed Intent 返回稳定 receipt，`onChanged` 是提交后失效通知并总是触发完整重新查询。十一个命名、可切换的场景（`src/fixtures/scenarios.ts`）各自声明它模拟的 Projection、接受的 Intent 与演示的结果；唯一的脚本化覆盖（首次看板移动冲突）在触发后委托回默认处理器。组件从不 join 记录，也不根据 Work Item Status 推导按钮；My Work 渲染 Projection 的展示分组，每项最多一个 offer。

导航拥有 typed `SakiViewAddress`，序列化到 URL hash 并持久化到 localStorage，在没有 router 的情况下证明 reload 与 Project 切换的状态保留。验证用 Playwright + axe-core 对生产构建执行（`validation/validate.mjs`，48 项检查），交付物（场景索引、affordance→Projection/Intent 清单、未决问题、验证记录）是应用旁的四份 markdown。

## Alternatives considered

**把 prototype 作为 `packages/saki/web-ui` 嵌入真实 DSH 客户端并接 fixture transport。** 这属于 K1 范围：需要先新增两个壳层 slot 和可启动的 host，IA 评审会被壳层工程阻塞——这正是 K0 要避免的顺序。K1+ 的生产实现仍走这条路；prototype 的组件结构按可移植设计。

**做成 `apps/` 下的 workspace package。** 每个 workspace 成员都会继承 hygiene、typecheck、coverage 与 knip 注册面；一个注定被替换的评审 artifact 不应注册进这些门控。prototype 保持为一个目录，后续 PR 删除它时不需要改动门控。

**静态 HTML 或 Figma 式点击稿。** 约定对键盘等价、焦点返回、乐观冲突回滚与状态语义的要求都是行为性的；静态 artifact 无法真实地演示它们。

**先定 wire type 并与 prototype 共享。** K0 明确禁止把 fixture 字段固化为最终 API；prototype 在自己的 `src/contract/types.ts` 中镜像约定词汇，并把每个 fixture 标注为非权威。

## Consequences

IA 评审可以立即开始，并附带键盘、无障碍与受限 viewport 证据。fixture 引擎的 intent 处理器编码了约定的前置条件（expected revision、远端指纹、eligibility），因此若干生产 UI 决定（保留已确认值的乐观 overlay 回滚、dialog 打开时的焦点延后、My Work 上的 Attention Inbox 呈现）已经是经过测试的行为，而不是待定设计。

代价是重复：token、基础组件与模拟壳层镜像 DSH 而不是复用它，且 K1 落地真实 `main.surface` 路径后 prototype 必须删除或废弃。独立应用也处于仓库门控之外，它自身的 `npm run build` 与 `validate.mjs` 是唯一的质量围栏——对评审 artifact 可接受，对交付物不可接受。
