# Agent Note: Saki 包族门禁与仓库组合包

Status: implemented

[English](2026-08-18-saki-private-package-foundation.md) | 中文

## 问题

[ADR 0002](../../../../docs/adr/0002-plugin-first-single-repository.zh.md)要求 Saki 特有插件留在本仓库，同时不把产品语义写入 DSH 核心。工作区会发现每个 `packages/*/*` manifest（元数据清单），但仓库检查把这棵目录树视为可发布的 `@deepseek-ai/dsh-*` 包族。因此，第二个产品命名空间需要一套统一分类机制：保持 DSH 行为不变，阻止 Saki 私有包进入发布，并在不提前创建 [ADR 0006](../../../../docs/adr/0006-modular-control-plane-and-four-capability-seams.zh.md)所列包拓扑的情况下提供可运行的首个切片。

## 决策

**集中执行产品包族分类。** `classifyProductPackage` 只识别既有 DSH 包族与 `@breakfastdapaidang/saki-*`；`privateSakiPackageViolations` 把 Saki 命名空间与具有相同后缀的 `packages/saki/<pkg>`、`private: true`、缺少 npm 发布元数据及包自身的有效 SemVer 绑定。manifest 校验把 SemVer 语法交给维护中的 `semver` 解析器。工作区约束、许可证检查、依赖图与发布工具使用同一个分类器，不再各自复制前缀规则。

**明确决定发布成员。** DSH `ReleaseFamily`、DSH 版本 bump 命令与旧 npm-baseline 命令即使在发现范围中包含 `packages/saki/*`，也会排除 Saki 包族；发布选择和版本更新使用共享产品分类器，而不是宽泛目录 glob。基线打包只处理已发现发布集合中的确切 DSH 与 vendor 目录。既有 DSH 发布语义继续由 [npm 发布序列](../process/2026-08-10-npm-release-sequences.zh.md)负责；发布 Saki 必须另行决定发布族，不能因其工作区位置而继承 DSH 成员身份。

**让工程检查不依赖包族。** 共享包规则、源码平面映射、项目引用、许可证与不变式检查、生成目录、模块图和组合包解析均接受两个已分类产品包族。[包治理参考](../../../../docs/saki/package-governance.zh.md)负责完整的当前包与发布规则。

**让组合证据随产品切片落地。** `@breakfastdapaidang/saki-bundle` 拥有空 Cordis 基础配置、一层补丁与仓库本地启动器。该补丁只挂载已经实现的产品切片和稳定的就绪配置项。当前组合把 JSON 作为默认存储后端，把 Saki 控制面、Host Execution 与 Installation State Generation domain 路由到同一个 manifest-selected SQLite generation，并挂载 Session 持久化、Workspace、本地文件系统与子进程提供方、Local Host 执行提供方、仅在 Windows 启用的 DPAPI 凭据提供方与 Product GitHub App、回环 Host 传输、`saki-control-plane` 和 `saki-host-api`。启动器会在 boot 前准备选定的 Installation State Generation，只在 `boot()` 完成配置项激活审计后输出就绪记录，并在 Saki Host 生命周期内持续运行；报告失败会先对应用执行 dispose（资源释放），再进入启动器失败路径。后续包随可独立验证的产品切片加入；规划中的名称不足以支持提前创建占位目录。

## 后果

`pnpm run saki` 证明全新检出可以在没有凭据的情况下解析并运行 Saki 源码，构建后的可执行文件证明普通 Node 能解析产物。该命令仍是仓库入口，与机器本地 Windows 包装脚本和代理引导分离。生成的包文档使用无冲突的 `saki/<pkg>` 图节点，宽泛文件扫描也不能把 Saki 私有包的 manifest（元数据清单）变成 DSH 发布成员。

该组合包包含本地身份与访问、Installation State Generation 维护、已有目录检查与 Project 登记、带 confirmed Board 的 GitHub 同步，以及[可恢复 Work Item Create 与 Move](2026-08-16-saki-recoverable-github-work-item-mutations.zh.md)。在 Windows 上，Product GitHub App 通过 DPAPI 凭据提供方解析 private key。组合包仍不包含 agent（智能体）、模型或渲染后的 Web 行为。每个后续切片判断其职责是 DSH 组中的可复用 harness 能力，还是 `packages/saki/` 下的 Saki 产品语义；已接受架构和规划中的包名本身都不会创建包。

## 已考虑的替代方案

- **在每个仓库脚本中重复命名空间检查**——会让生成目录、依赖图、约束与发布逻辑对包的理解分别漂移。
- **只依赖 `private: true`**——它能阻止 npm 发布，却不能强制命名空间位置、依赖图标识和有效版本，也不能将包排除在仓库发布编排之外。
- **用本地正则校验包版本**——会重复 npm SemVer 规则，并在边缘输入上产生错误接受或拒绝。
- **提前创建完整规划中的 Saki 包拓扑**——会先于行为分配所有权，并让推测性边界看起来已经稳定。
- **把 Saki 启动行为加入 DSH CLI**——会把产品组合耦合到上游应用，而不是使用其组合包扩展点。
