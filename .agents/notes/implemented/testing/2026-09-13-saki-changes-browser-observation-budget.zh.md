# Agent Note: Changes 浏览器预算覆盖完整的源码模式 Git 观察

Status: implemented

[English](2026-09-13-saki-changes-browser-observation-budget.md) | 中文

## 问题

[Changes 浏览器 CI 失败](https://github.com/BreakfastDaPaiDang/saki/actions/runs/34733414845/job/103660353373)在等待首个未暂存 Diff 时超过 90 秒，页面仍显示读取中。该等待覆盖完整的 Host query，包括多轮仓库观察与补丁验证。它并非测量单条 Git 命令，也不约束产品延迟保证。

夹具启动源码 Host。其 Linux 与 Windows 路径通过[子进程 runner 选择器](../../../../packages/subprocess/subprocess-local/src/runner-launch.ts)为每条托管命令启动 TypeScript runner。针对同一份七行 Diff 的原生 Windows 探针执行了 384 条 Git 命令，在 162 秒内完成；之前的状态查询执行了 82 条命令，用时 34 秒。探针校验了返回的 typed Diff 与每条命令的结束记录。这些时间描述源码夹具，不代表打包 Host 的实测延迟。

[四 worker Linux 记录](https://github.com/BreakfastDaPaiDang/saki/actions/runs/34735097494/job/103664990490)暴露了更早的捕获失败：35 条命令各耗时约 0.8 秒，下一条命令在捕获开始 30 秒后被取消。Planning 也拒绝了其 selection，Work 则耗尽 HTTP 等待时间。consumer job 已按 Saki 标准 runner 策略限制其他测试池，但新增浏览器检查沿用了 e2e 配置的四 worker 默认值。

## 决策

consumer job 为 Saki 标准 runner 将 `DSH_E2E_MAX_WORKERS` 设为二，在其他环境保留四。workflow 测试拒绝缺失的 Saki worker 限制。浏览器用例保持并行执行，并采用与其他 consumer 测试池相同的 worker 预算。

[Changes 浏览器用例](../../../../packages/saki/bundle/tests/web-changes.e2e.ts)为每个完整操作提供十分钟、为整个场景提供一小时，以覆盖源码模式进程启动；原生 Windows 场景用时 23 分钟完成。原有 Git 命令、inventory 与 baseline 限制仍由 execution provider 所有；Windows 夹具保留其显式 capture budget overlay。浏览器等待相同的可见状态，并检查真实 index、Commit 数量、精确 replay、已有文件和刷新后的布局。CI 调用使用 `--retry=0`。

每次独立的 Changes 记录保留阶段时间戳、截图及命令启动和结束耗时。夹具仅包装自身的 subprocess service，以原 receiver 委派原调用，并通过 context effect 恢复方法。计时记录不包含命令参数或环境变量值。consumer job 在运行成功或失败后均保留目录，具体见 [bundle 诊断说明](../../../../packages/saki/bundle/README.zh.md#changes-browser-diagnostics)。

## 考虑过的方案

- 重试浏览器用例：重试无法解释哪个操作超出预算，还会重复真实仓库写入。
- 绕过托管 runner，或在源码夹具中选择构建产物：这会移除对受支持源码启动路径的覆盖。
- 移除重复仓库观察：这些读取确立了 [Git 操作安全与恢复保证](../architecture/2026-08-28-saki-recoverable-structured-git-operations.zh.md)。
- 串行执行浏览器套件：夹具各自分配独立仓库，改变并行度并不能消除每条源码模式命令的启动成本。

## 后果

源码模式浏览器验证可能耗时数分钟，并保留有限的外层期限来限制挂起。命令计时可区分累计启动成本与命令未结束，但不测量托管进程范围的完全退出，也不能证明打包后的性能。产品限制、仓库安全检查与写入断言仍分别由各自的组件所有。
