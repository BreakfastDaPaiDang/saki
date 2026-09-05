# Agent Note: Saki Actions cost and trigger policy

Status: implemented

English | [中文](2026-08-18-saki-actions-cost-policy.zh.md)

## Problem

Saki inherits workflows designed for an upstream repository with private runner pools and a larger automation budget. Running the same heavyweight work on a pull request and again after merge spends hosted minutes without adding a merge decision. The inherited master path also queued self-hosted standby jobs on pools Saki does not operate, and documentation deployment failed before its build because GitHub Pages is disabled.

The repository still needs one trustworthy merge gate. Deferring all validation until a release would save minutes by discovering integration failures only after code reaches `master`.

## Decision

[CI](../../../../.github/workflows/ci.yml) is a ready-pull-request merge gate plus an explicit manual-suite host. It listens for `opened`, `synchronize`, `reopened`, `ready_for_review`, and `converted_to_draft`, but required jobs allocate runners only when the pull request is not a draft. The stable `all checks passed` result retains the complete keyless dependency set. A newer run on the same ref cancels stale work, including a draft conversion that replaces an in-flight ready run with an all-skipped run, and a push to `master` starts no CI run.

The Wine-hosted Windows job remains required. The complete native Windows inventory runs only through the `windows-native` manual suite on `windows-latest`; it is the default manual-suite selection so an ordinary dispatch cannot queue an unavailable larger-runner pool. The unavailable self-hosted standby jobs and the master-only Wine cache job are absent.

[DSH release packing](../../../../.github/workflows/release.yml) runs for `dsh-v*` tags or manual dispatch, and [vendor release packing](../../../../.github/workflows/release-vendor.yml) runs for `vendor-*-v*` tags or manual dispatch. Publication remains manual even when a tag starts packing. [Sandbox](../../../../.github/workflows/sandbox.yml) runs for `saki-v*` or `dsh-v*` tags and manual dispatch; [documentation deployment](../../../../.github/workflows/docs-pages.yml) runs for `saki-v*` tags or manual dispatch. Documentation jobs also require `SAKI_DOCS_PAGES_ENABLED == 'true'`, so a repository with Pages disabled records a skipped job instead of a false deployment failure.

[Landlock validation](../../../../.github/workflows/landlock-run.yml) remains path-scoped for ready pull requests and is also manually dispatchable; it does not repeat after merge. The secret-bearing [DeepSeek real-API suite](../../../../.github/workflows/e2e.yml) is manual-only and fails loudly when its secret is absent. It must never use `pull_request_target`; the [archived automatic-trigger analysis](../../archived/testing/2026-06-19-real-api-e2e-ci.md) preserves that threat model. The keyless pull-request gate therefore owns routine correctness, while credentials, release artifacts, and diagnostic platform matrices require an explicit cost-bearing event.

This Saki-specific policy supersedes only the trigger cadence, runner allocation, and cache-producer claims in the inherited [documentation projection](2026-07-13-documentation-site-projection.md), [serial reference](2026-07-21-serial-cross-platform-ci-reference.md), [larger-runner measurements](2026-07-22-evidence-based-larger-hosted-runners.md), [local hooks](2026-07-22-fast-local-git-hooks.md), [portable pull-request CI](2026-07-23-portable-required-pull-request-ci.md), [archived CI failover](../../archived/process/2026-07-26-ci-failover-runbook.md), [pnpm caching](2026-07-26-pnpm-action-setup-for-symmetric-ci-caching.md), [native Windows](2026-08-08-native-windows-pull-request-ci.md), [npm release](2026-08-10-npm-release-sequences.md), [Landlock release](2026-08-06-in-repository-landlock-release.md), [property-based testing](../testing/2026-06-11-property-based-testing.md), [browser GUI lane](../testing/2026-07-24-web-gui-browser-e2e-lane.md), [browser snapshot CI](../testing/2026-07-30-web-browser-snapshot-ci-gate.md), [archived real-API automation](../../archived/testing/2026-06-19-real-api-e2e-ci.md), and [Python runtime](../../archived/testing/2026-08-12-required-python-runtime-pull-request-ci.md) decisions. Their test contracts, release mechanics, measurements, and security analysis remain applicable where the workflows still use them.

## Verification

[`scripts/saki-actions-workflow.spec.ts`](../../../../scripts/saki-actions-workflow.spec.ts) parses the workflow files and rejects a master CI trigger, draft runner allocation, Saki-inapplicable standby jobs, an automatic native Windows job, release workflows outside their tag families, missing Pages protection, a Landlock master trigger, or an automatic real-API trigger. [`scripts/ci-workflow.spec.ts`](../../../../scripts/ci-workflow.spec.ts) continues to pin the required merge aggregate and manual native Windows command.

## Alternatives considered

**Run every workflow only on version tags.** This minimizes hosted minutes but removes pre-merge evidence from `all checks passed`, so ordinary integration failures reach `master` before detection.

**Keep the inherited trigger set and raise the billing budget.** More credit does not make duplicate post-merge work informative, provision missing self-hosted pools, or enable GitHub Pages.

**Provision the inherited private runners.** Saki does not need a second runner topology for its current scale. Standard hosted capacity plus bounded manual diagnostics has lower operational cost.

**Keep real-API e2e on trusted pull requests.** It provides earlier provider evidence but spends credentials and hosted minutes on every ready change. Manual dispatch preserves the real test for provider work without making it routine merge cost.

## Consequences

Every ready pull request still pays for the complete keyless merge gate, and pushes to that ready branch rerun it. Draft iteration is free of heavyweight jobs, marking a draft ready starts the gate, and merging does not repeat it.

Release packing defects, real-provider drift, native Windows-only failures, and real-kernel Sandbox failures can remain undiscovered until their tag or manual run. The release operator must run the relevant manual suite before a high-risk release when the version tag is not an adequate checkpoint. Enabling documentation deployment requires both GitHub Pages configuration and the `SAKI_DOCS_PAGES_ENABLED` repository variable.

Upstream synchronization can reintroduce expensive triggers without changing product code. The focused workflow specification is therefore part of the Saki overlay and must remain green when upstream workflow files are reconciled.
