# Agent Note: 取消被取代的 CI 验证

Status: implemented

[English](2026-09-09-cancel-superseded-ci.md) | 中文

## 问题

验证已被取代的修订会消耗运行器容量，却不能确定最新修订的状态。发布所属的运行时构建也使用可复用验证构建器，但取消这些构建会中断有意发起的发布事务。

## 决策

[CI](../../../../.github/workflows/ci.yml)、手动[真实 API e2e](../../../../.github/workflows/e2e.yml)，以及无凭据的 [dsh](../../../../.github/workflows/release.yml) 和 [vendor](../../../../.github/workflows/release-vendor.yml) 打包验证，在 `${{ github.workflow }}-${{ github.ref }}` 组中使用 `cancel-in-progress: true`。不同引用和工作流不会相互取消。事件类型不参与分组，因此同一引用上重复的手动验证会替换过时的工作。

[可复用 Python 运行时构建器](../../../../.github/workflows/build-exe-for-python-sdk.yml)使用 `${{ !inputs.release }}`。其 `build-single-exe-${{ github.workflow }}-${{ github.ref }}` 组与调用方的组保持区分。调用方工作流名称将普通 CI 与发布所属的构建隔离，后者获得取消豁免。发布、部署和元数据工作流保留各自的策略。

[Saki Actions 策略](2026-08-18-saki-actions-cost-policy.zh.md)拥有工作流触发条件和必需检查行为。Saki 没有 master 推送 CI 或定时真实 API e2e。其 PR 聚合保留 `always() && github.event_name == 'pull_request'`，拒绝失败、取消或跳过的依赖，包括草稿运行。Wine 保留无条件资源清理。

## 曾考虑的替代方案

**保留每次验证运行。** 完成历史运行能提供更多按修订划分的证据，但过时验证会与最新运行竞争。打包验证不发布包，可以安全地被取代。

**取消发布所属的运行时构建。** 否决，因为这些产物属于发布事务，由调用方负责完成。

**使用作业级并发保护工作。** 作业级分组无法让作业免于整个工作流的取消。

## 后果

该策略不保证每个中间修订或重复手动验证都能完成。不同引用仍会竞争共享主机容量。取消是由 GitHub Actions 及其运行器处理的请求；清理可能耗时，取消没有固定延迟保证。

## 验证

[工作流回归测试](../../../../scripts/ci-workflow.spec.ts)固定 CI 取消与手动基准预算。[发布演练回归测试](../../../../scripts/tests/ci-release-selfhosted.spec.ts)保留打包取消和发布隔离。[Saki 工作流回归测试](../../../../scripts/saki-actions-workflow.spec.ts)固定触发条件与聚合行为。这些配置检查不重现 GitHub 调度或运行器停止过程。
