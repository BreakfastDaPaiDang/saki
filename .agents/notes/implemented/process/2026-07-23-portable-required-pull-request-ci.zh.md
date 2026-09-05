# Agent Note: 拉取请求 CI 的可移植恢复边界

Status: implemented

[English](2026-07-23-portable-required-pull-request-ci.md) | 中文

## 问题

分配到组织自有运行器标签的拉取请求必需作业，在 GitHub 无法为这些池分配运行器时会持续排队。工作流本身有效，GitHub 标准托管作业仍能通过，但 `all checks passed` 始终无法启动，原本健康的拉取请求因此无法满足分支保护要求。

账单状态正常、运行器定义处于 `Ready` 状态以及较高的自动扩缩容上限，都不能证明指定的运行器池可以接收作业。必需的正确性检查需要预先明确一条可移植路径；在出现经过单独测量与预配的替代方案前，Saki 将该路径作为日常门禁。

## 决策

[CI](../../../../.github/workflows/ci.yml) 在 Saki 设置 `SAKI_CI_RUNNERS=standard` 时，将必需的主 Node 24 作业与稳定的 `all checks passed` 聚合流程运行在 GitHub 标准托管 Linux 上。继承的企业级与自托管选择器仍可供上游部署使用，但不定义 Saki 当前使用的运行器池。必需的 Windows 作业在标准 `ubuntu-latest` 上通过 Wine 运行 Windows Node，覆盖阻断性检查范围；完整的原生 Windows 清单作为 `windows-native` 手动套件运行在 `windows-latest` 上，且不参与聚合流程（[双 Windows 决策](2026-08-08-native-windows-pull-request-ci.zh.md)）。标准 `ubuntu-latest` 作业保留 Node 22.19、Node 26、Python SDK 单元测试套件与[发布形态的 Linux x64 Python 运行时验证](../../archived/testing/2026-08-12-required-python-runtime-pull-request-ci.md)。这些作业让可移植执行边界保持可观测，而不必在每个拉取请求中重复原生 Windows 清单。

三项 Linux 主作业、Node 兼容性、Python SDK 单元测试套件、Python 运行时验证和 `windows node 24 / wine blocking` 继续作为 `all checks passed` 的依赖项；手动原生 Windows 套件被刻意排除。分支保护采用 `all checks passed`，真实 API e2e 则依据 [Saki Actions 策略](2026-08-18-saki-actions-cost-policy.zh.md)仅支持手动运行。设置 `SAKI_CI_RUNNERS=standard` 后，聚合流程与主 Linux 作业不依赖企业级或自托管运行器池。

[大型运行器决策](2026-07-22-evidence-based-larger-hosted-runners.zh.md)继续保留继承的运行器池测量结果，[跨平台串行参考流程](2026-07-21-serial-cross-platform-ci-reference.zh.md)继续保留完整的诊断定义。Saki 不会为普通 PR 启用这些拓扑；手动基准测试套件保留规格比较，同时不扩大必需矩阵。

## 曾考虑的替代方案

**把企业级运行器池设为 Saki 的日常路径。** 大型运行器池可以提高仓库执行速度，但会引入外部预配，并可能在标签不可用时让所有合并持续排队。Saki 将标准容量保留为必需路径，把大型运行器比较保留为手动基准测试。

**根据标称核心数选择可选的大型运行器规格。** 基准测试表明扩展效果不呈单调变化，设置耗时也存在波动，因此未来任何分配方式变更都必须由完整作业的精确测量结果证明。

**在容量不可用时跳过检查或降低其级别。** 这种方式通过丢弃证据而非执行仓库的必需约定来使状态变绿。

**在每台主机上使用同一工作线程策略。** 外层门禁并发与内层工具工作线程在 Linux、Windows 和标准运行器上的争用方式不同；按主机实测的上限可以避免新增核心反而拖慢执行。

## 后果

已就绪且非草稿的 PR 会将 GitHub 标准托管容量用于 Linux 关键路径，而 Wine 作业让必需的 Windows 判定继续使用标准 Linux 运行器容量。手动原生套件使用标准 Windows 运行器容量，不会延迟或改变聚合流程。一次针对确切分支头的实际运行会区分分支保护采用的命令与单独的诊断约定；排队延迟与每个作业从 `startedAt` 到 `completedAt` 的执行区间分开报告。

标准兼容性作业与必需的 Wine 作业继续提供合并证据，手动原生 Windows 套件继续提供诊断证据。仅改变运行器池定义的状态，不足以证明它可以接收作业；Saki 的日常门禁保持使用 GitHub 标准托管容量。
