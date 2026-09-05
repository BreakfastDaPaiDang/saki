# Agent Note: Required CI gate for web browser expected outputs

Status: implemented

English | [中文](2026-07-30-web-browser-snapshot-ci-gate.zh.md)

## Problem

The [keyless web browser e2e lane](2026-07-24-web-gui-browser-e2e-lane.md) runs only under the local `pnpm run test:web` command, and PR CI does not compare Web expectations under `snapshots/web/` or `apps/web/tests/expected/`. A PR that changes user-visible web output can therefore remain green when its expected outputs are not refreshed; when any later branch explicitly runs `DSH_SNAPSHOT=refresh`, it backfills the earlier change and produces a diff unrelated to that branch. Ordinary local runs already default to read-only replay, so the gap is mandatory enforcement at the PR level, not a ban on writes in refresh mode.

## Decision

For ready Linux pull requests, the `node 24 / snapshots and artifacts` job must run the full web browser replay/compare suite. When `DSH_WEB_SNAPSHOT_WORKERS` is configured, `scripts/run-gates.ts` registers `test:web:ci` as the `ci-consumers` gate and explicitly injects `DSH_SNAPSHOT=replay`; CI never runs in `record` or `refresh` mode, so when the committed goldens disagree with the currently assembled application, the tests fail directly instead of silently rewriting them on the runner and then passing.

The consumer job owns the [single Linux build](../process/2026-07-30-independent-ci-consumer-build.md), so `apps/web/dist` and the package `lib/` directories remain in its workspace for the browser suite. On hosted runners, CI installs Chromium and its system dependencies at the Playwright version in the lockfile. Ready pull requests restore an operating-system-and-lockfile-keyed browser cache when a compatible entry exists, with an operating-system prefix fallback across lockfile changes, but do not pay compression and upload on the required path. Saki has no automatic default-branch cache producer or self-hosted standby under the [Actions cost policy](../process/2026-08-18-saki-actions-cost-policy.md), so a cold browser installation remains a supported path.

Local `pnpm run test:web` continues to build first and then run the full browser suite serially; `test:web:built` is the serial entry point for existing build artifacts. Developers explicitly run `DSH_SNAPSHOT=refresh pnpm run test:web` only after confirming that user-visible output changed intentionally, review every expected-output diff, and then verify again in replay mode that no files are written.

CI's `scripts/run-web-snapshots.ts` first runs `hmr-live.e2e.ts` and `cordis-tool-round.e2e.ts` as separate serial Vitest invocations. The HMR scenario mutates built workspace state, while the Cordis scenario owns a lifecycle-sensitive approval and steering sequence whose turn grouping is made deterministic by waiting for the initial turn to settle before approval. After both pass, one six-worker Vitest pool runs every remaining file. Every child inherits stdio, and the enclosing gate streams that output through `run-gates`.

For ready pull requests, the gate runs only in the Linux consumer job: these scenarios target POSIX, and the other PR jobs do not provision Chromium. The `all checks passed` verdict already depends on the consumer job, so a browser compare failure blocks the merge without requiring a new branch-protection check name. Disabled serial reference definitions remain outside this required path.

Completed local replays measured the six-worker browser command at about 65–71 seconds. A twelve-worker comparison completed in about 50 seconds, so halving the browser worker budget adds about 15–20 seconds rather than doubling wall time. The gate scheduler starts browser snapshots as soon as `built-package-invariants` succeeds and runs independent gates concurrently, so it needs neither a dedicated job timeout nor a manual YAML ordering rule.

## Alternatives considered

**Continue requiring only local runs.** Rejected: execution depends on developer memory, which is precisely why stale goldens drift across PRs, and cannot guarantee that the PR introducing a behavior change carries its own expected-output diff.

**Run CI in `refresh` mode and then check the working tree.** Rejected: checking after writing turns the assertion mechanism into a generator; if the working-tree check is wired incorrectly, it can turn a regression into a passing expected-output update. Replay compares the existing goldens directly and has a smaller failure surface.

**Create a standalone browser job and rebuild the entire repository.** Rejected: it would duplicate dependency installation and the publishable build. The existing Linux consumer job already owns that build and is part of the unified required verdict.

**Run HMR and Cordis inside the parallel pool.** Rejected because HMR mutates shared built state and the Cordis approval continuation requires a serial preflight. Every other file shares one bounded pool; dedicated long-file processes add scheduling code and leave part of a reduced worker budget idle after those files complete.

**Replace real Chromium with jsdom snapshots.** Rejected: jsdom does not cover the browser, HTTP/SSE carriage, or the composition of real client plugin bundles. It remains useful for fast lower-layer feedback, but cannot replace the assembled browser chain.

## Consequences

Before merge, every ready, non-draft pull request proves that the current web assembly matches all committed browser expected outputs, turning a missed refresh from an “unrelated change in a later PR” into a failure in the pull request that introduced it. The cost is Chromium provisioning, two serial scenarios, and one bounded six-worker pool in the consumer job; the consumer-owned build and browser cache avoid duplicate builds and downloads on reruns. Parallel-file failures stream immediately, but a worker-budget change still requires a completed end-to-end measurement rather than an elapsed-time guess. The gate makes no claim of cross-platform browser consistency, and if a Playwright/Chromium upgrade changes the ARIA format, the upgrade pull request must explicitly refresh the expected outputs and review the churn.
