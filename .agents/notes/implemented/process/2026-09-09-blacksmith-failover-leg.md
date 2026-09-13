# Agent Note: Blacksmith as a failover leg for CI pools

Status: implemented

English | [中文](2026-09-09-blacksmith-failover-leg.zh.md)

## Problem

The [archived upstream failover runbook](../../archived/process/2026-07-26-ci-failover-runbook.md) records routing of degraded enterprise-pool traffic onto the in-house `vm-backup` and `dsh-win-ci` pools, which are proven but bounded standbys. Blacksmith sells GitHub-hosted-style runners on demand, and its migration wizard proposed replacing the repository's `runs-on` labels wholesale, which would put credential-holding, benchmark, and spec-pinned jobs on third-party infrastructure as the default. The wholesale replacement is not acceptable as a default: it breaks the workflow contract specs, distorts benchmark and performance-budget measurements, and moves trust-boundary jobs without a decision record.

## Decision

`DSH_CI_FAILOVER_LINUX=blacksmith` retargets the Expected filenames job and the Sandbox bwrap leg onto `blacksmith-4vcpu-ubuntu-2404`. Other values retain each job’s GitHub-hosted default. This repository variable is an explicit outage or experiment choice: changing it does not modify source, and the alternate runner costs money only while selected.

The [Saki Actions policy](2026-08-18-saki-actions-cost-policy.md) owns the participating job set. Required pull-request jobs, manual native Windows validation, benchmark matrices, and release-shaped builders retain their existing runner selection. Saki does not run master CI or self-hosted standby jobs. Blacksmith routing has no Dependabot exclusion because these runners are ephemeral; restrictions for persistent self-hosted pools remain separate.

Credential-bearing jobs, npm and PyPI publication chains, Node Addon System releases, and Pages deployment stay on their existing runners. Landlock, Seatbelt, and Linux ARM64 paths also retain their required host images. This prevents an infrastructure failover from changing publication trust, host capabilities, or benchmark calibration.

## Alternatives considered

Adopting the migration wizard wholesale. Rejected because it breaks the workflow contract specs, changes benchmark semantics and performance-budget calibration, and moves credential-holding and trust-boundary jobs to third-party infrastructure as the default; the earlier wizard migration (closed PR #3053) was rejected for cost and the same review findings.

Keeping the in-house pools as the only failover target. Rejected as the sole option because they are a bounded standby; Blacksmith adds elastic capacity for the outage and experiment cases where the fleet itself is the degraded resource.

## Consequences

The blacksmith legs stay dormant until the value is set, so they are exercised only during an actual failover or an explicit experiment. The mirror trial ([PR #3841](https://github.com/deepseek-harness/deepseek-harness/pull/3841), closed) ran the participating set hardcoded onto the Blacksmith labels and confirmed that `blacksmith-4vcpu-ubuntu-2404`, `blacksmith-16vcpu-ubuntu-2404`, and `blacksmith-16vcpu-windows-2025` schedule and execute. Blacksmith registers its runners as self-hosted, so under the `blacksmith` value the `node-compat` legs run their toolcache-isolation and isolated-installation verification steps (gated on `runner.environment == 'self-hosted'`) rather than skipping them; all three legs passed on the trial image ([run 34322356689](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34322356689)). The same trial surfaced one environment finding that this change fixes: while expanding `**`, node 24.13's internal `fs.glob` lstat-probes `<matched>/<next segment>` for a symlinked file and throws ENOTDIR instead of skipping ([run 34319926270](https://github.com/deepseek-harness/deepseek-harness/actions/runs/34319926270)), failing `verify-md-wrap` inside `check:ci:static` on Blacksmith until [repo-files.ts](../../../../scripts/repo-files.ts) replaced `globSync` with a dirent walker; the fixed static lane is green on the same image. The trigger is the lstat-probe of a path beneath a matched symlink, not `**` over symlinked trees in general: the other `globSync` `**` call sites that scan symlink-bearing trees stayed green on the same run and needed no change. The upstream trial’s 8 and 32 vCPU labels (ubuntu-2404 and windows-2025) were not part of the trial and are inferred by naming symmetry from the verified 4 and 16 vCPU labels; confirm with a manual dispatch before first use. The Landlock, Seatbelt, and linux-arm64 exclusions still rest on the prose dispatch measurements of the earlier migration attempt (closed PR #3053), recorded here as a known gap; the trial could not exercise those legs by design. The Saki workflow tests pin the two participating selectors and keep the required CI topology under its own cost policy. Default cost posture is unchanged: nothing runs on Blacksmith unless the variable says so.
