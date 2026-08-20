# Agent Note: Saki 0.1.0 低保真 prototype 作为独立的 fixture 驱动应用

Status: implemented

[English](2026-08-19-saki-k0-lowfi-prototype-standalone-app.md) | 中文

## Problem

K0（issue #42）要求一个可点击、可键盘操作的低保真 prototype，在 K1–K7 拆分生产前端实现前证明两个新增顶层页面可行。已交付的 DSH Web 客户端只能在 dsh host 内启动（host 注入的 boot 数据、cordis plugin tree、构建后的 `lib/` bundle），而 Saki 需要的两个壳层 slot（`main.surface`、`sidebar.primary.action`）尚不存在——把 prototype 嵌入真实客户端会把 K1 的壳层工作拖进 K0。同时，prototype 必须忠实地演示前端约定（带 revision 的完整 Projection、携带 expected revision 的 typed Intent、作为 Projection 事实的 Action Offer、文字优先的视图状态语义），而不是随意的 mockup。

## Decision

prototype 位于 `prototypes/saki-0.1.0-web/`，是一个带独立 npm lockfile 的 Vite + React + TypeScript 独立应用。它在 pnpm workspace glob 之外，因此 package 级门控（knip、publint、workspace constraints、按文件 coverage）不适用；仓库级暂存门控仍然适用——README 维护双语配对，暂存源码通过 lint 与空白检查，本 note 通过 note 格式与翻译配对门控。它具有产品代表性但不是生产代码：CSS Modules 配合 DSH 暗色风格 token、中文产品文案，以及与 `packages/client/*` 相同的 props 下行组件纪律。

fixture 控制面（`src/fixtures/engine.ts`）以真实协议行为实现约定的三个控制面操作：`query` 返回带单调递增 revision 的完整 Projection；`submit` 用调用方的 expected revision 校验目标 Projection（过时即 conflict 且 handler 不执行），签发一个从 pending 到终态保持不变的稳定 receipt id，对相同的在途 Intent 去重，并在 pending 期间禁止重复提交；`onChanged` 使 key 失效并总是触发完整重查。十二个命名场景（`src/fixtures/scenarios.ts`）各自声明它模拟的 Projection、接受的 Intent 与演示的结果——包括 CreateWorkItem 部分完成、acknowledgement 丢失后的对账与安全重试、看板指纹冲突与乐观 overlay 回滚，以及项目设置中同步配置的 `saved → revalidating → scanning → checkpointed → activated` 激活链。各 Project 的 fixture 完全分离；handler 从 Intent 解析所属 Project，绝不硬编码。

导航拥有覆盖 Work Item、Work Session、Agent Run、Milestone、file 与 Board filter 状态的 typed `SakiViewAddress`，序列化到 URL hash 并持久化到 localStorage；Settings 对话框记录来源 address 并返回。验证是对生产构建执行的 Playwright + axe-core 检查清单（`validation/validate.mjs`），交付物（场景索引、affordance→Projection/Intent 清单、未决问题、验证记录）是应用旁的 markdown 文件。

prototype 为 K1–K7 把门：K1（壳层、认证、Project 登记/rebind）、K2（My Work 与生产 CreateWorkItem）、K3（Board、Work Item、Milestone/Release、mapping repair）、K4（Changes、Agent Run、Trace、PR/CI 交付）、K5（Model Supply、Context、Generation Job）、K7（Project Settings 作为唯一可编辑 owner），然后 K6（恢复、窄屏、键盘、无障碍收口）。它们都不从 prototype fixture 提前接线；各自等待自己的后端 Projection/Intent fixture。

## Alternatives considered

**把 prototype 作为 `packages/saki/web-ui` 嵌入真实 DSH 客户端并接 fixture transport。** 这属于 K1 范围：需要先新增两个壳层 slot 和可启动的 host，IA 评审会被壳层工程阻塞——这正是 K0 要避免的顺序。K1+ 的生产实现仍走这条路；prototype 的组件结构按可移植设计。

**做成 `apps/` 下的 workspace package。** 每个 workspace 成员都会继承 hygiene、typecheck、coverage 与 knip 注册面；一个注定被替换的评审 artifact 不应注册进这些门控。prototype 保持为一个目录，后续 PR 删除它时不需要改动 package 门控；它仍遵守适用于任何入库文件的仓库级暂存门控。

**静态 HTML 或 Figma 式点击稿。** 约定对键盘等价、焦点返回、乐观冲突回滚与状态语义的要求都是行为性的；静态 artifact 无法真实地演示它们。

**先定 wire type 并与 prototype 共享。** K0 明确禁止把 fixture 字段固化为最终 API；prototype 在自己的 `src/contract/types.ts` 中镜像约定词汇，并把每个 fixture 标注为非权威。

## Consequences

IA 评审附带键盘、无障碍与受限 viewport 证据进行。fixture 引擎强制约定的前置条件（expected revision、远端指纹、eligibility），因此若干生产 UI 决定（从已确认快照派生、向目标列插入的乐观 overlay；dialog 打开时的焦点延后；My Work 上按原因分组的 Attention；Project Settings 的 field-scoped 编辑与同步激活链）已经是经过测试的行为，而不是待定设计。

代价是重复：token、基础组件与模拟壳层镜像 DSH 而不是复用它，且 K1 落地真实 `main.surface` 路径后 prototype 必须删除或废弃——包括仅属 prototype 的场景工具条，生产不继承。独立应用的质量围栏只有自身的 `npm run build` 与 `validation/validate.mjs` 加上仓库级暂存门控——对评审 artifact 可接受，对交付物不可接受。
