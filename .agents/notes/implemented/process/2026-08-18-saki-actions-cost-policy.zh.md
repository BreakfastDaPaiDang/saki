# Agent Note: Saki Actions 成本与触发策略

Status: implemented

[English](2026-08-18-saki-actions-cost-policy.md) | 中文

## 问题

Saki 继承的工作流面向拥有私有运行器池与更高自动化预算的上游仓库。在 PR（Pull Request）上运行重量级工作，并在合并后再次运行，只会消耗托管分钟数，不会增加新的合并裁决。继承的 `master` 路径还会把自托管热备作业排到 Saki 并未运营的池中；文档部署则会因为 GitHub Pages 未启用而在构建前失败。

仓库仍然需要一个可信的合并门禁。如果把全部验证推迟到发布阶段，虽然能节省分钟数，却只能在代码进入 `master` 后发现集成故障。

## 决策

[CI](../../../../.github/workflows/ci.yml) 既是面向已就绪 PR 的合并门禁，也是显式手动套件的宿主。它监听 `opened`、`synchronize`、`reopened`、`ready_for_review` 与 `converted_to_draft`，但必需作业只在 PR 不是草稿时分配运行器。稳定的 `all checks passed` 结果继续依赖完整的无密钥检查集合。同一 ref 上的新运行会取消陈旧工作，包括用一个全部跳过的运行取代正在执行的已就绪运行的草稿转换；推送到 `master` 不会启动 CI 运行。

由 Wine 承载的 Windows 作业仍是必需项。完整的原生 Windows 清单只能通过 `windows-native` 手动套件在 `windows-latest` 上运行；它是手动套件的默认选项，因此普通 dispatch 不会排队等待不可用的大型运行器池。不可用的自托管热备作业与仅供 master 使用的 Wine 缓存作业均不存在。

[DSH 发布打包](../../../../.github/workflows/release.yml)由 `dsh-v*` tag 或手动 dispatch 触发，[vendor 发布打包](../../../../.github/workflows/release-vendor.yml)由 `vendor-*-v*` tag 或手动 dispatch 触发。即使 tag 启动了打包，发布仍然只能手动进行。[Sandbox](../../../../.github/workflows/sandbox.yml)由 `saki-v*` 或 `dsh-v*` tag 以及手动 dispatch 触发；[文档部署](../../../../.github/workflows/docs-pages.yml)由 `saki-v*` tag 或手动 dispatch 触发。文档作业还要求 `SAKI_DOCS_PAGES_ENABLED == 'true'`，因此未启用 Pages 的仓库会记录一个跳过的作业，而不是错误的部署失败。

[Landlock 验证](../../../../.github/workflows/landlock-run.yml)继续针对已就绪 PR 按路径触发，也支持手动 dispatch；合并后不会重复运行。携带 secret 的 [DeepSeek 真实 API 套件](../../../../.github/workflows/e2e.yml)只能手动运行，并在 secret 缺失时明确失败。它禁止使用 `pull_request_target`；[已归档的自动触发分析](../../archived/testing/2026-06-19-real-api-e2e-ci.md)保留了该威胁模型。因此，无密钥 PR 门禁负责日常正确性，凭据、发布产物与诊断性平台矩阵则需要显式承担成本的事件。

这项 Saki 专属策略仅取代继承的[文档投影](2026-07-13-documentation-site-projection.zh.md)、[串行参考流程](2026-07-21-serial-cross-platform-ci-reference.zh.md)、[大型运行器测量](2026-07-22-evidence-based-larger-hosted-runners.zh.md)、[本地钩子](2026-07-22-fast-local-git-hooks.zh.md)、[可移植 PR CI](2026-07-23-portable-required-pull-request-ci.zh.md)、[已归档的 CI 故障切换](../../archived/process/2026-07-26-ci-failover-runbook.md)、[pnpm 缓存](2026-07-26-pnpm-action-setup-for-symmetric-ci-caching.zh.md)、[原生 Windows](2026-08-08-native-windows-pull-request-ci.zh.md)、[npm 发布](2026-08-10-npm-release-sequences.zh.md)、[Landlock 发布](2026-08-06-in-repository-landlock-release.zh.md)、[基于属性的测试](../testing/2026-06-11-property-based-testing.zh.md)、[浏览器 GUI 车道](../testing/2026-07-24-web-gui-browser-e2e-lane.zh.md)、[浏览器快照 CI](../testing/2026-07-30-web-browser-snapshot-ci-gate.zh.md)、[已归档的真实 API 自动化](../../archived/testing/2026-06-19-real-api-e2e-ci.md)与[Python 运行时](../../archived/testing/2026-08-12-required-python-runtime-pull-request-ci.md)决策中的触发频率、运行器分配和缓存生产方结论。工作流仍在使用的测试约定、发布机制、测量结果与安全分析继续适用。

## 验证

[`scripts/saki-actions-workflow.spec.ts`](../../../../scripts/saki-actions-workflow.spec.ts)解析工作流文件，并拒绝 master CI 触发器、为草稿分配运行器、不适用于 Saki 的热备作业、自动运行的原生 Windows 作业、脱离各自 tag 族的发布工作流、缺少 Pages 保护、Landlock master 触发器或自动真实 API 触发器。[`scripts/ci-workflow.spec.ts`](../../../../scripts/ci-workflow.spec.ts)继续固定必需合并聚合流程与手动原生 Windows 命令。

## 考虑过的替代方案

**让所有工作流只在版本 tag 上运行。** 这会最大程度减少托管分钟数，但也会移除 `all checks passed` 的合并前证据，使普通集成故障在被发现前进入 `master`。

**保留继承的触发器集合并提高计费预算。** 更多额度既不会让合并后重复工作产生信息，也不会配置缺失的自托管池或启用 GitHub Pages。

**配置继承的私有运行器。** Saki 当前规模不需要第二套运行器拓扑。标准托管容量配合有界的手动诊断，运维成本更低。

**在可信 PR 上保留真实 API e2e。** 这能更早提供模型提供方证据，却会让每个已就绪变更消耗凭据与托管分钟数。手动 dispatch 保留了模型提供方工作所需的真实测试，同时不会使其成为日常合并成本。

## 后果

每个已就绪 PR 仍会为完整的无密钥合并门禁付出成本，继续向该已就绪分支推送也会重新运行门禁。草稿迭代不会运行重量级作业；将草稿标为就绪会启动门禁；合并不会重复门禁。

发布打包缺陷、真实模型提供方漂移、仅原生 Windows 可见的故障，以及真实内核 Sandbox 故障，都可能到对应 tag 或手动运行时才被发现。如果版本 tag 不足以作为检查点，发布操作者必须在高风险发布前运行相关手动套件。启用文档部署既需要配置 GitHub Pages，也需要设置 `SAKI_DOCS_PAGES_ENABLED` 仓库变量。

上游同步可能在不改动产品代码的情况下重新引入昂贵触发器。因此，这项聚焦工作流规格属于 Saki overlay，并且在协调上游工作流文件时必须保持通过。
