# Agent Note: Portable pull-request CI recovery boundary

Status: implemented

English | [中文](2026-07-23-portable-required-pull-request-ci.zh.md)

## Problem

Required pull-request jobs assigned to organization-owned runner labels remain queued when GitHub cannot allocate those pools. The workflow is valid and standard GitHub-hosted jobs can still pass, but `all checks passed` never starts and an otherwise healthy pull request cannot satisfy branch protection.

Billing health, a runner definition's `Ready` state, and a large autoscaling ceiling do not prove that a named pool can receive a job. Required correctness checks need a known portable path; Saki uses that path as its ordinary gate until a separately measured and provisioned alternative exists.

## Decision

[CI](../../../../.github/workflows/ci.yml) runs the required primary Node 24 jobs, plus the stable `all checks passed` aggregate, on standard GitHub-hosted Linux when Saki sets `SAKI_CI_RUNNERS=standard`. The inherited enterprise and self-hosted selectors remain available to upstream deployments but do not define Saki's active runner pool. The required Windows job runs Windows Node under Wine on standard `ubuntu-latest` for the blocking surfaces; the complete native Windows inventory is a manual `windows-native` suite on `windows-latest` and does not participate in the aggregate ([dual Windows decision](2026-08-08-native-windows-pull-request-ci.md)). Standard `ubuntu-latest` jobs retain Node 22.19, Node 26, the Python SDK unit suite, and the [release-shaped Linux x64 Python runtime validation](../../archived/testing/2026-08-12-required-python-runtime-pull-request-ci.md). These jobs keep the portable execution boundary observable without duplicating the native Windows inventory on every pull request.

The three Linux primary jobs, Node compatibility, Python SDK unit suite, Python runtime validation, and `windows node 24 / wine blocking` remain dependencies of `all checks passed`; the manual native Windows suite is deliberately absent. Branch protection uses `all checks passed`, while real-API e2e is manual-only under the [Saki Actions policy](2026-08-18-saki-actions-cost-policy.md). With `SAKI_CI_RUNNERS=standard`, the aggregate and primary Linux jobs do not depend on an enterprise or self-hosted pool.

The [larger-runner decision](2026-07-22-evidence-based-larger-hosted-runners.md) retains the inherited pool measurements, and the [serial cross-platform reference](2026-07-21-serial-cross-platform-ci-reference.md) retains the complete diagnostic definitions. Saki does not activate those topologies for ordinary pull requests; manual benchmark suites retain size comparisons without expanding the required matrix.

## Alternatives considered

**Make enterprise pools the ordinary Saki path.** Larger pools can give faster repository execution, but they add external provisioning and can leave every merge queued when a label is unavailable. Saki keeps standard capacity as the required path and preserves larger-runner comparison as a manual benchmark.

**Select an optional larger-runner size from advertised core count.** Benchmarks show non-monotonic scaling and setup variance, so exact complete-job measurements must justify any future allocation change.

**Skip or demote checks while capacity is unavailable.** This would make the status green by dropping evidence rather than by running the repository's required contracts.

**Use one worker policy on every host.** Outer gate concurrency and inner tool workers contend differently on Linux, Windows, and standard runners; measured host-specific bounds avoid turning additional cores into slower execution.

## Consequences

Ready, non-draft pull requests spend standard GitHub-hosted capacity on the Linux critical path, while the Wine job keeps the required Windows verdict on standard Linux allocation. The manual native suite uses standard Windows allocation without delaying or changing the aggregate. A live exact-head run distinguishes the commands branch protection consumes from the separate diagnostic contract; queue delay is reported separately from each job's `startedAt` to `completedAt` execution interval.

Standard compatibility and required Wine jobs remain merge evidence, while the manual native Windows suite remains diagnostic evidence. A runner pool definition's status alone is insufficient proof that it can receive work; Saki's ordinary gate stays on standard GitHub-hosted capacity.
