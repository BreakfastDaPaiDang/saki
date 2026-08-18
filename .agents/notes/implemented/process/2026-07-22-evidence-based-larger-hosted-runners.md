# Agent Note: Evidence-based larger hosted runners

Status: implemented

English | [中文](2026-07-22-evidence-based-larger-hosted-runners.zh.md)

## Problem

The shard-heavy CI topology met its latency targets by spreading primary Node work across 40 Linux jobs and Windows work across nine jobs. Most gates were shorter than checkout, runner setup, cache restore, and dependency installation, so repeated setup waves created both cost and latency variance. One hosted run finished its slowest Linux job in 49 seconds yet took 231 seconds for a Windows lint shard whose checkout, cache restore, and install alone consumed 158 seconds.

Larger runners make it possible to pay setup once and parallelize inside the repository scheduler, but the useful size cannot be selected from core counts alone. Critical-lane benchmarks did not scale monotonically, and a whole-repository aggregate exposed different bottlenecks from isolated typecheck or site builds.

## Decision

The benchmark data below remains the evidence for choosing a larger hosted runner when an operator explicitly dispatches a comparison. Saki does not provision the measured enterprise or self-hosted pools: ready pull requests use standard GitHub-hosted Linux plus Wine, and the complete native Windows inventory is manual on `windows-latest` under the [Saki Actions policy](2026-08-18-saki-actions-cost-policy.md). An advertised core count remains insufficient evidence for changing that allocation; a candidate must complete the same repository workload and report its observed processor and memory capacity.

The required primary path stays on the [portable standard-runner boundary](2026-07-23-portable-required-pull-request-ci.md), while the [serial reference](2026-07-21-serial-cross-platform-ci-reference.md) retains complete diagnostic definitions without an automatic `master` trigger. `suite=larger-runner-benchmark` compares isolated critical lanes across any provisioned sizes, and `suite=consolidated-runner-benchmark` compares whole aggregates. Both are explicit manual suites; the default manual selection is the portable `windows-native` diagnostic so a routine dispatch cannot queue a missing larger-runner label.

The former gate-level and coarse primary shard jobs are absent from the workflow. Their static, lint, coverage, snapshot, and scenario shard selectors are also absent from the repository, so an unused diagnostic path cannot preserve a second CI architecture.

Saki's required Linux primary work uses three independent standard-hosted jobs. Coverage runs alone with its own worker bound, and the static scheduler owns source and documentation gates that do not consume emitted output. The third job owns the single Linux build, then starts lint, Node 24 runtime compatibility, build-backed snapshots, documentation typechecking, and all artifact consumers against that tree. This [independent consumer build](2026-07-30-independent-ci-consumer-build.md) lets all three jobs request runners immediately without duplicating compilation or transferring a run-scoped artifact. Generated NodeNext consumer directories are excluded from Oxlint discovery because the artifact check removes them while these processes overlap. The pnpm store is restored without putting cache uploads on the pull-request critical path; Oxlint has no repository-managed result cache. Performance reports use each job's `startedAt` to `completedAt` interval; runner queue delay is capacity evidence, not repository execution time. The 32-core data below describes the historical measured enterprise topology and the explicit comparison suites, not Saki's required allocation.

The gate dependencies remain explicit. Coverage consumes source and does not wait for build. Documentation typechecking consumes the consumer lane's complete project-reference output. Snapshot replay and publication consumers wait for emitted output, while Node-version compatibility jobs exercise runtime-sensitive source loading without repeating the primary source-graph typecheck. PTY and subprocess suites keep their bounded inner concurrency rather than inheriting the runner's core count.

The artifact boundary remains explicit. `scripts/publint-all.ts` calls publint's supported API against an in-memory publication view formed from each manifest's declared files plus npm's mandatory metadata, avoiding one package-manager pack process per package. `scripts/verify-built-package-invariants.mjs` stages the declared `lib/` files below the real package and imports its compiled self-reference through plain Node and Cordis Loader normalization; a runtime chunk omitted from the publication contract still fails.

Within the measured enterprise topology, Windows shared one 32-core setup across the blocking build and production site plus observational built-artifact contracts, while Linux owned the duplicate lint, coverage, and snapshot inventories. Saki retains those measurements but uses the [dual Windows validation](2026-08-08-native-windows-pull-request-ci.md) as a required Wine job plus an explicit standard-hosted native suite.

An exact-head all-size benchmark ran the complete unsharded primary Node aggregate on every Linux pool before the eager-build correction:

| Complete Linux primary | 4 cores | 8 cores | 16 cores | 32 cores | 64 cores | 96 cores |
|---|---:|---:|---:|---:|---:|---:|
| Active time | 243 s | 144 s | 103 s | 87 s | 62 s | 65 s |

The 96-core trace spent 39.14 seconds in repository gates. Typecheck occupied 25.71 seconds, then a scheduler dependency delayed the 2.13-second build and 11.29-second snapshot replay until it finished. The same run already proved build and typecheck independently, and the former CPU lane ran them concurrently. Removing that dependency makes lint at 33.30 seconds the measured critical gate while preserving dependencies only for consumers of build output. The 64-core trace exposed the same idle chain: typecheck, build, and snapshot consumed 44.85 seconds in sequence while its independent lint and documentation builds finished in 36.83 and 36.15 seconds. More cores therefore become useful only after the repository scheduler can feed them.

The same benchmark measured the required Windows build surfaces across every provisioned size:

| Windows blocking builds | 4 cores | 8 cores | 16 cores | 32 cores | 64 cores | 96 cores |
|---|---:|---:|---:|---:|---:|---:|
| Active time | 152 s | 104 s | 104 s | 92 s | 103 s | 110 s |

Repository work gains little above 16 Windows cores, but the 32-core pool can start the complete outer inventory together. A retargeted production validation completed the full one-box Windows inventory in 173 seconds, including coverage and snapshot replay, so Windows remains consolidated.

The larger client package graph makes cache mechanics and scheduler pressure part of the measured workload. In one exact-head candidate run, Linux spent 39 seconds in repository gates but 69 seconds in the complete job, while Windows spent 117 seconds in repository gates and 228 seconds in the complete job. The Windows pnpm cache downloaded its 154 MB archive in about two seconds but spent 27 seconds extracting it, followed by a 23-second install and a 14-second post-job save. A cacheless all-size trace completed the same 32-core Windows install in 27 seconds. A future larger-runner rollout therefore needs complete-job measurements rather than gate-only timing.

Host setup remains part of any comparison. A standard Node 26 job once spent 36 of its 67 seconds in `Set up job`, while `actions/setup-node` spent 46.56 seconds printing cached Windows environment details after finding Node in the hosted toolcache. A Linux candidate also spent 18 seconds registering a 50 KB Bubblewrap package because the hosted image scanned 202,507 package-database files. [`scripts/prepare-ci-bubblewrap.sh`](../../../../scripts/prepare-ci-bubblewrap.sh) instead verifies and extracts the pinned payload into the ephemeral runner directory, runs a functional confinement probe, and overlaps that preparation with dependency installation.

Inner and outer worker limits are separate controls. An exact-head 32-worker ESLint experiment slowed lint to 52.28 seconds and coverage to 42.71 seconds, where an adapter idle-timeout test failed. A later 8-gate trace reduced coverage to 35.17 seconds but delayed the production-site build until the aggregate reached 41.06 seconds. Core count therefore does not justify copying an equally large worker limit.

The process-bound coverage project contains exactly five suite files. Thirty-two forks crashed Node 24's CJS lexer twice, and a later 16-fork run reproduced the worker loss and invalid coverage result. The single Vitest invocation therefore uses threads for the broad inventory and reserves forks for suites that exercise process-global state, `process` APIs, or timing-sensitive process I/O. That narrow fork inventory includes the local bash process-plumbing suite and the pi-ai adapter suite because aggregate contention changed timing observations in both. These failures make deterministic coverage, not advertised cores, the upper bound on worker selection.

Complete serial Linux and macOS references remain disabled definitions, and complete native Windows is an explicit manual suite. Pull requests use the standard-hosted required path, while larger-runner sizes run only by manual dispatch. Saki does not run a self-hosted standby topology; the [archived failover runbook](../../archived/process/2026-07-26-ci-failover-runbook.md) preserves the removed upstream mechanism without establishing current runner availability.

## Alternatives considered

**Keep the three coarse primary Linux lanes.** The core, CPU, and production-site jobs met the latency targets, but they paid three setup waves and left primary Node work sharded after larger runners were available. The all-size trace showed that one unnecessary dependency, not a lack of host capacity, kept the single-box aggregate above one minute.

**Keep the former gate-level shard topology as a manual reference.** A dormant second topology kept hundreds of workflow lines, selector modules, and scenario-partition behavior alive. The all-size and serial suites provide timing and completeness controls without preserving production code that no required job exercises.

**Return to package-manager packing in each publication validator.** Rejected because it repeats a package-manager subprocess for every package. The manifest-derived publication view and staged compiled self-reference preserve the published-file contract with one in-process inventory.

**Build before coverage or typecheck on every Node version.** Rejected because coverage is source-only and compiler analysis is not runtime-specific. Build-backed consumers still wait for emitted output, and compatibility jobs exercise the runtime-sensitive paths on every advertised Node line.

**Use the 64-core pool for the complete primary aggregate.** Its sampled active time was three seconds lower than the 96-core result because hosted setup was nine seconds faster, but its repository gates were 5.72 seconds slower. The benchmark suite retains both pools because a sustained image or pricing change can reverse the comparison.

**Keep build behind typecheck.** This orders independent compiler invocations and turns snapshot replay into a three-stage critical chain. Build output has its own success dependency, so only snapshot and publication consumers wait for it.

**Publish the static job's build to post-build consumers.** A run-scoped artifact preserves one exact build, but the workflow can only consume it by waiting for the entire static job and then requesting another runner. The [independent consumer build](2026-07-30-independent-ci-consumer-build.md) assigns the single Linux build to its actual consumers instead.

**Make larger or self-hosted pools the required Saki path.** The measurements show lower active time for several larger Linux sizes, but Saki has no such pool and its current budget values predictable allocation over that latency gain. Standard GitHub-hosted capacity therefore owns the merge gate; the benchmark suites preserve a measured route to revisit the decision.

**Keep required and observational Windows checks in separate jobs.** The split preserves status semantics at the workflow level but pays setup twice. `run-gates` preserves the same required versus non-blocking distinction inside one process.

**Install Bubblewrap through the system package manager.** This uses the host's package database and can dominate the job even when the payload is tiny. Pinned extraction plus a confinement probe preserves the runtime contract without mutating the hosted image.

## Consequences

The required topology retains no shard selectors. Every ready, non-draft pull request consumes standard GitHub-hosted Linux minutes; native Windows and larger-runner benchmarks add capacity only when explicitly dispatched.

GitHub rounds each larger-runner execution up to a whole minute, so complete-job measurement exposes both billed time and workflow complexity. Splitting Linux repeats setup twice, but the consumer lane owns the only built tree and coverage, static gates, and post-build consumers enter runner allocation independently; consolidating Windows avoids repeating its slower setup.

Performance targets are observations, not cancellation deadlines or correctness requirements. Manual all-size and serial suites remain available when image, dependency, scheduler, or pricing changes need remeasurement.

Missing or renamed larger-runner labels can only stall an explicitly dispatched benchmark. The required aggregate stays on standard labels, so optional runner inventory cannot block ordinary merges.
