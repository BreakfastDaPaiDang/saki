# Agent Note: Blacksmith 作为 CI 池的故障切换支路

Status: implemented

[English](2026-09-09-blacksmith-failover-leg.md) | 中文

## 问题

[归档的上游故障切换手册](../../archived/process/2026-07-26-ci-failover-runbook.md)记录了把降级的企业池流量路由到自有的 `vm-backup` 与 `dsh-win-ci` 池——它们是经过验证但容量有界的备用池。Blacksmith 按需出售类似 GitHub 托管的运行器，其迁移向导提议整体替换仓库的 `runs-on` 标签，这会把持有凭据、基准与 spec 钉死的作业默认放到第三方基础设施上。整体替换不适合作为默认：它会打破 workflow 契约 spec、扭曲基准与性能预算测量，并在没有决策记录的情况下搬动信任边界作业。

## 决策

`DSH_CI_FAILOVER_LINUX=blacksmith` 将 Expected filenames 作业和 Sandbox bwrap 分支切换到 `blacksmith-4vcpu-ubuntu-2404`。其他值保留各作业默认的 GitHub 托管运行器。这个仓库变量是显式的故障或实验选择：修改它不改变源码，替代运行器只在选中时产生费用。

[Saki Actions 策略](2026-08-18-saki-actions-cost-policy.zh.md)拥有参与切换的作业集合。必需的 pull-request 作业、手动原生 Windows 验证、基准矩阵和发布形态的构建器保留既有运行器选择。Saki 不运行 master CI 或自托管备用作业。Blacksmith 路由不排除 Dependabot，因为这些运行器是临时的；持久自托管池的限制仍独立适用。

持有凭据的作业、npm 与 PyPI 发布链、Node Addon System 发布和 Pages 部署继续使用既有运行器。Landlock、Seatbelt 和 Linux ARM64 路径也保留所需宿主镜像。这防止基础设施故障切换改变发布信任、宿主能力或基准校准。

## 备选方案

整体采纳迁移向导。否决，因为它打破 workflow 契约 spec、改变基准语义与性能预算校准，并默认把持有凭据与信任边界的作业搬到第三方基础设施；更早的向导迁移（已关闭的 PR #3053）因成本与同样的 review 结论被否决。

只把自有池作为唯一故障切换目标。作为唯一选项被否决，因为它是容量有界的备用；Blacksmith 为「故障对象正是自有池本身」的故障与实验场景提供弹性容量。

## 后果

blacksmith 各腿在有人设置该值前保持休眠，因此只在真实故障切换或明确实验期间被使用。镜像试运行（[PR #3841](https://github.com/deepseek-harness/deepseek-harness/pull/3841)，已关闭）把参与集硬编码到 Blacksmith 标签上跑过，确认 `blacksmith-4vcpu-ubuntu-2404`、`blacksmith-16vcpu-ubuntu-2404` 与 `blacksmith-16vcpu-windows-2025` 可调度可执行。Blacksmith 将其运行器注册为 self-hosted，因此在 `blacksmith` 取值下 `node-compat` 各腿会真实执行 toolcache 隔离与隔离安装校验步骤（以 `runner.environment == 'self-hosted'` 为条件），而非全部跳过；三条腿都在试运行镜像上通过（[run 34322356689](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34322356689)）。同一试运行还暴露了一个由本改动修复的环境发现：在 `**` 展开中遇到 symlink 文件时，node 24.13 的内部 `fs.glob` 会 lstat-probe `<matched>/<下一段>` 并抛 ENOTDIR 而非跳过（[run 34319926270](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34319926270)），使 `check:ci:static` 内的 `verify-md-wrap` 在 Blacksmith 上失败，直到 [repo-files.ts](../../../../scripts/repo-files.ts) 用 dirent walker 替换 `globSync`；修复后的 static 通道在同一镜像上转绿。触发条件是 probe 已匹配 symlink 之下的路径，而非笼统的「`**` 扫过含 symlink 的树」：同一 run 中其它扫描含 symlink 树的 `globSync` `**` 调用点保持绿色，无需改动。上游试运行中的 8 与 32 vCPU 标签（ubuntu-2404 与 windows-2025）不在试运行范围内，是按已实测的 4/16 vCPU 标签命名对称推定的；首次使用前请用一次手动 dispatch 确认。Landlock、Seatbelt 与 linux-arm64 的排除仍基于更早迁移尝试（已关闭的 PR #3053）的散文式 dispatch 实测，此处记录为已知缺口；试运行按设计无法触发这几条腿。Saki workflow 测试固定这两个参与切换的 selector，并使必需 CI 拓扑继续遵守自身成本策略。默认成本姿态不变：除非变量指明，否则没有任何东西跑在 Blacksmith 上。
