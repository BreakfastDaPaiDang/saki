# Agent Note：从 Saki 发布 tag 发布文档站

Status: implemented

[English](2026-08-21-documentation-site-tag-release.md) | 中文

## 问题

仓库与 GitHub Pages 站点均为公开状态，而 `master` 会随进行中的 Saki 工作持续推进。若每次分支合并都发布，文档会在 Saki 发布之前对外出现，普通开发也会消耗一次 Actions 部署。拉取请求 CI 已经构建生产站点，因此部署需要独立的发布节奏，且不能成为合并检查。

## 决策

`docs-pages.yml` 监听 `saki-v*` tag 推送与显式 `workflow_dispatch` 事件，不监听拉取请求或分支推送。因此，Saki 发布 tag 会自动发布对应文档；手动 dispatch 则用于恢复或经操作员批准的重新部署。两个作业都要求 `SAKI_DOCS_PAGES_ENABLED == 'true'`，所以未配置 Pages 的仓库保持不活动。

工作流不运行 `release:verify --family dsh`。私有 Saki 包拥有独立于可发布 DSH 家族的版本线，而 DSH 校验器会正确拒绝 `saki-v*` ref。tag 过滤器选择常规 Saki 发布事件；`github-pages` 环境及其仓库设置负责授权部署。手动运行只有在环境规则允许时才能部署所选 ref。

`DOCS_REPOSITORY` 标识 `BreakfastDaPaiDang/saki`，`DOCS_REPOSITORY_REF` 保持 `master`。因此，投影到未发布源码文件的链接、GitHub 导航项及两个语言版本的编辑链接都会指向 Saki 的公开源码树，而不是上游仓库，同时不依赖历史 tag 是否继续保留。已部署页面仍是 tag 对应的快照；只有其中的源码导航链接跟随持续维护的默认分支。

构建覆盖不依赖部署。必需的 ready 拉取请求 CI 通过 `check:ci:static` 构建生产站点；Saki 刻意不在每次 `master` 推送上运行 CI 工作流。[`ci-workflow.spec.ts`](../../../../scripts/ci-workflow.spec.ts)、[`saki-actions-workflow.spec.ts`](../../../../scripts/saki-actions-workflow.spec.ts) 与 [`project-doc-site.spec.ts`](../../../../scripts/project-doc-site.spec.ts) 固定 `saki-v*`／手动触发、Pages 启用开关、无凭据 checkout、Saki 仓库与 `master` 源码链接 ref、生成的源码／编辑 URL，以及 `github-pages` 环境。

## 曾考虑的替代方案

**只从 `dsh-v*` tag 手动 dispatch。** 否决：站点记录的是 Saki，而 Saki 私有包版本按设计独立于 DSH npm 发布家族。复用 DSH 发布校验会让每次 `saki-v*` 部署失败，或把包策略明确分开的两条发布线重新耦合。

**每次 `master` 推送都部署。** 否决：一次合并并不等于一次 Saki 发布；这种方案会让部署成为普通开发成本，还可能发布未完成工作的文档。

**让 `DOCS_REPOSITORY_REF` 跟随所部署的 tag。** tag 页面链接到同一份源码快照更加精确，但会让旧部署依赖历史 tag 持续存在。公开默认分支才是持久的源码导航目标。

**把 Pages 站点改为私有。** 否决：仓库与产品文档有意公开。访问控制会把站点隐藏在目标读者之外，却不能解决发布节奏问题。

## 后果

`saki-v*` tag 无需额外 dispatch 即可发布文档，必要时经授权的手动运行可以重新部署。普通合并与拉取请求永远不会部署站点。两次 Saki tag 之间的文档修复会出现在仓库和 CI 预览中，但只有操作员刻意 dispatch 后才会进入 Pages。环境配置具有实际运维意义，因为它负责授权手动 ref，并控制最终部署步骤。
