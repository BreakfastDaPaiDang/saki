# Saki 包治理

[English](package-governance.md) | 中文

[ADR 0002](../adr/0002-plugin-first-single-repository.zh.md)记录将 Saki 特有插件留在本仓库的决定。本文档定义 Saki 私有产品包如何与 vendor 目录中的 DeepSeek Harness 包树共存；[包族 Agent Note](../../.agents/notes/implemented/architecture/2026-08-18-saki-private-package-foundation.zh.md)记录仓库检查为何共享一个分类器，以及组合配置为何只包含已经实现的产品切片。

## 命名空间与位置

可发布的 Harness 包继续使用 `@deepseek-ai/dsh-*` 命名空间和现有发布规则。Saki 产品包严格位于 `packages/saki/<pkg>`，使用后缀相同的 `@breakfastdapaidang/saki-<pkg>`，设置 `private: true`，并省略 npm `publishConfig` 与仓库元数据。其包版本使用有效 SemVer，独立于 DSH 工作区发布版本。

工作区约束、许可证检查、依赖图与发布工具共享同一个分类器。Saki 名称出现在 `packages/saki/` 之外、该组内使用其他命名空间，或者目录末级名称与包名后缀不同，都会使工作区门禁失败。当前 DSH 发布族与旧 npm-baseline 命令明确排除 Saki；基线打包只使用其已选择集合中的确切 DSH 与 vendor 目录。发布 Saki 必须经过未来单独、明确的发布族决策。

## 共享仓库标准

私有不等于免检。Saki 包与 DSH 包使用相同的 ESM 入口布局、Cordis 对等依赖（peer dependency）与开发依赖、包自有 invariant companion、MIT 声明、源码平面 TypeScript 映射、项目引用、构建输出策略、README 要求、生成 catalog 与模块图。组合包的 manifest（元数据清单）和 Cordis 配置行还必须通过通用组合包与源码解析门禁。

第二个命名空间只改变分类。现有 `@deepseek-ai/dsh-*` 检查、版本、发布内容规则、catalog、示例与发布成员关系保持原有含义。

## 当前组合包与本地入口

[`packages/saki`](../../packages/saki/README.zh.md)列出当前包族。`@breakfastdapaidang/saki-bundle` 保持空根配置，并拥有声明的 patch；该 patch 组合本地访问、已有目录检查、首次 Project 登记、结构化 Git 读取与直接 mutation，以及一条就绪配置项。存储域默认使用 JSON，并把当前 `saki_control_plane@5`、`saki_host_execution@1` 与 `saki_storage_generation@3` 路由到同一个 manifest-selected SQLite generation；Session 日志继续使用独立 JSONL 持久化。`pnpm run saki` 是仓库开发入口；它不会读取或替代用户的 `start-dsh-with-clash.ps1` 或其他宿主本地启动包装层。

启动器只在 `boot()` 完成配置项激活审计后输出稳定的就绪记录。`SAKI_ONESHOT=1` 随后以零退出且不消费 bootstrap 交接值；普通模式会另输出一行含明文 secret 的 launcher-handoff JSON，并持续运行至收到 `SIGINT` 或 `SIGTERM`。就绪输出或退出回调失败时，启动器会对应用执行 dispose（资源释放）并进入失败路径。无密钥快照覆盖源码入口；构建产物存在时，普通 Node 冒烟测试覆盖构建后的可执行文件。

## 扩展规则

下一个 Saki 包应随真正需要它的产品切片加入，而不能仅根据规划拓扑提前创建。拥有 Saki 产品语义或组合职责的包属于 `packages/saki/`。能够脱离 Saki 独立成立的通用 Harness 能力属于对应 DSH 组，并继续接受 DSH 贡献与发布策略。
