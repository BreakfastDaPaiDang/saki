# Agent Note: Saki package family 门禁与空 bundle

状态：已实现

[English](2026-08-18-saki-private-package-foundation.md) | 中文

## 问题

[ADR 0002](../../../../docs/adr/0002-plugin-first-single-repository.md)要求 Saki 特有 plugin 留在本仓库，同时不把产品语义写入 DSH core。工作区会发现每个 `packages/*/*` manifest，但仓库检查把这棵目录树视为可发布的 `@deepseek-ai/dsh-*` family。因此，第二个产品命名空间需要一套统一分类机制：保持 DSH 行为不变，阻止私有 Saki package 进入发布，并在不提前创建 [ADR 0006](../../../../docs/adr/0006-modular-control-plane-and-four-capability-seams.md)所列 package 拓扑的情况下提供可运行的首个切片。

## 决策

**集中执行产品 family 分类。** `classifyProductPackage` 只识别既有 DSH family 与 `@breakfastdapaidang/saki-*`；`privateSakiPackageViolations` 把 Saki 命名空间与 `packages/saki/<pkg>`、`private: true`、缺少 npm 发布元数据和 package 自有的有效 SemVer 绑定。manifest 校验把 SemVer 语法交给维护中的 `semver` parser。工作区约束、许可证检查、依赖图与发布工具消费同一个分类器，不再各自复制前缀规则。

**明确决定发布成员。** DSH `ReleaseFamily` 与旧 npm-baseline 命令即使扫描到 `packages/saki/*`，也会排除 Saki family。既有 DSH 发布语义继续由 [npm 发布序列](../process/2026-08-10-npm-release-sequences.md)拥有；发布 Saki 必须另行决定 release family，不能因宽泛 glob 而继承 DSH 成员身份。

**让工程检查保持 family-neutral。** 共享 package 规则、源码平面 mapping、project reference、许可证与 invariant 检查、生成 catalog、模块图和 bundle resolution 接受两个已分类产品 family。[package 治理参考](../../../../docs/saki/package-governance.md)拥有完整的当前 package 与发布规则。

**只证明第一个 composition root。** `@breakfastdapaidang/saki-bundle` 拥有空 Cordis root、一层 patch 和仓库本地启动器。它唯一的配置行等待 Loader 结算、输出一条稳定 readiness 记录，并请求由启动器拥有的正常退出。后续 package 随可独立验证的产品切片加入；规划中的名称不足以支持提前创建占位目录。

## 后果

`pnpm run saki` 证明全新检出可以在没有凭据的情况下解析并运行 Saki 源码，构建后的可执行文件证明 plain-Node 产物解析。该命令仍是仓库入口，与机器本地 Windows wrapper 和代理引导分离。生成的 package 文档使用无冲突的 `saki/<pkg>` 图节点，宽泛文件扫描也不能把私有 Saki manifest 变成 DSH 发布成员。

初始 bundle 不包含持久化、身份、GitHub、Agent、模型、服务器或 Web 行为。每个后续切片判断其职责是 DSH group 中的可复用 Harness 能力，还是 `packages/saki/` 下的 Saki 产品语义；已接受架构和规划中的 package 名称本身都不会创建 package。

## 已考虑的替代方案

- **在每个仓库脚本中重复命名空间检查**——会让 catalog、graph、constraint 与 release 对 package 的理解分别漂移。
- **只依赖 `private: true`**——它能阻止 npm 发布，却不能强制命名空间位置、graph identity、有效版本或排除仓库发布编排。
- **用本地正则校验 package 版本**——会重复 npm SemVer 规则，并在边缘输入上产生错误接受或拒绝。
- **提前创建完整规划中的 Saki 包拓扑**——会先于行为分配所有权，并让推测性边界看起来已经稳定。
- **把 Saki 启动行为加入 DSH CLI**——会把产品组合耦合到上游应用，而不是使用其 bundle 扩展点。
