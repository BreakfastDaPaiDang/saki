# Agent Note: Saki 工程工作流

Status: implemented

[English](2026-08-15-saki-engineering-workflow.md) | 中文

## Problem

Saki 需要一个由仓库拥有的系统来处理工作流入、Agent 路由、交付状态、里程碑、发布和领域术语。工具本地任务列表无法协调多个用户，也无法在单个 Agent 会话之外保存项目状态。

## Decision

GitHub Issue 是 Saki 的 Work Item 存储。五个分诊标签按照 [`docs/agents/triage-labels.md`](../../../../docs/agents/triage-labels.md) 路由尚未认领的工作，而 Work Item Status 独立于路由和阻塞记录交付进度。

[`CONTEXT-MAP.md`](../../../../CONTEXT-MAP.md) 标识 Saki 的领域上下文。每个上下文拥有自己的词汇表，架构决策位于 [`docs/agents/domain.md`](../../../../docs/agents/domain.md) 所述的相应 ADR 路径下。Work Management 是第一个上下文，定义 Work Item、里程碑、发布、tag、commit 和已纳入的 DeepSeek Harness 基线之间的关系。

仓库变量 `SAKI_CI_RUNNERS=standard` 为必需的 Pull Request job 选择 GitHub 托管的 Linux 和 Windows runner。Saki 不依赖 DeepSeek 的私有 runner 标签；当有意配置兼容的自托管池时，继承的故障转移变量仍然可用。

## Alternatives considered

**把工作状态保留在 Agent 会话中。** 这样设置成本低，但无法共享分诊、持久记录归属或与仓库交付同步。

**使用 GitHub Projects 作为真源。** Projects 提供看板展示，但 Issue 保持稳定的工作记录，使 Saki 可以增加或替换看板视图，而无需迁移 Work Item。

**使用一个覆盖全仓库的词汇表。** 单个文件起步简单，但会混合无关的业务语言，并在 Saki 增加产品上下文后加剧合并争用。

## Consequences

人和 Agent 共享一套持久的 Work Item 生命周期和路由词汇。看板实现必须投影 GitHub Issue 状态，而不能拥有第二份副本；每个新领域上下文都必须通过上下文地图注册；标准 Saki CI 使用公共 GitHub 托管容量，而非不可用的上游 runner 池。
