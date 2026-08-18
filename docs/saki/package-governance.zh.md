# Saki 包治理

[English](package-governance.md) | 中文

[ADR 0002](../adr/0002-plugin-first-single-repository.md)拥有让 Saki 特有 plugin 留在本仓库的决定。本文档定义其私有产品 package 如何与 vendored DeepSeek Harness package tree 共存；[package family Agent Note](../../.agents/notes/implemented/architecture/2026-08-18-saki-private-package-foundation.md)记录仓库检查为何共享一个分类器，以及首个切片为何只包含空 bundle。

## 命名空间与位置

可发布的 Harness 包继续使用 `@deepseek-ai/dsh-*` 命名空间和现有发布规则。Saki 产品包严格位于 `packages/saki/<pkg>`，使用 `@breakfastdapaidang/saki-<pkg>`，设置 `private: true`，并省略 npm `publishConfig` 与 repository 元数据。其包版本使用有效 SemVer，独立于 DSH 工作区发布版本。

工作区约束、许可证检查、依赖图与发布工具共享同一个分类器。Saki 名称出现在 `packages/saki/` 之外，或者该组内的包使用其他名称，都会使工作区门禁失败。当前 DSH 发布族与旧 npm-baseline 命令明确排除 Saki；发布 Saki 必须经过未来单独、明确的发布族决策。

## 共享仓库标准

私有不等于免检。Saki 包与 DSH 包使用相同的 ESM 入口布局、Cordis peer 加 dev dependency、包自有 invariant companion、MIT 声明、源码平面 TypeScript 映射、项目引用、构建输出策略、README 要求、生成 catalog 与模块图。Bundle manifest 和 Cordis 配置行还必须通过通用 bundle 与源码解析门禁。

第二个命名空间只改变分类。现有 `@deepseek-ai/dsh-*` 检查、版本、payload 规则、catalog、示例与发布成员关系保持原有含义。

## 首个 bundle 与本地入口

`@breakfastdapaidang/saki-bundle` 是初始阶段唯一的 Saki 包。它用空根配置与声明的 patch 挂载一条 readiness 行，在不使用凭据的情况下证明工作区发现、源码与产物解析、Loader 结算、确定性输出和正常关停。`pnpm run saki` 是仓库开发入口；它不会读取或替代用户的 `start-dsh-with-clash.ps1` 或其他宿主本地启动包装层。

Readiness 进程只在 Loader 结算后输出一行 JSON，随后以零退出。无密钥 snapshot 覆盖源码入口；构建产物存在时，plain-Node smoke 覆盖构建后的可执行文件。

## 扩展规则

下一个 Saki 包应随真正需要它的产品切片加入，而不能仅根据规划拓扑提前创建。拥有 Saki 产品语义或组合职责的包属于 `packages/saki/`。能够脱离 Saki 独立成立的通用 Harness 能力属于对应 DSH 组，并继续接受 DSH 贡献与发布策略。
