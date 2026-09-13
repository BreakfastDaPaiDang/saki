# Agent Note: Cancel superseded CI validation

Status: implemented

English | [中文](2026-09-09-cancel-superseded-ci.zh.md)

## Problem

Validation of an obsolete revision consumes runner capacity without establishing the newest revision’s status. Release-owned runtime builds also use the reusable validation builder, but cancellation there can interrupt an intentional publication transaction.

## Decision

[CI](../../../../.github/workflows/ci.yml), manual [real-API e2e](../../../../.github/workflows/e2e.yml), and credential-free [dsh](../../../../.github/workflows/release.yml) and [vendor](../../../../.github/workflows/release-vendor.yml) pack validations use `cancel-in-progress: true` with `${{ github.workflow }}-${{ github.ref }}`. Different refs and workflows do not cancel each other. Event type is not part of the group, so repeated manual validation on one ref replaces obsolete work.

The [reusable Python runtime builder](../../../../.github/workflows/build-exe-for-python-sdk.yml) uses `${{ !inputs.release }}`. Its `build-single-exe-${{ github.workflow }}-${{ github.ref }}` group remains distinct from its caller’s group. The caller workflow name isolates ordinary CI from release-owned builds, which are exempt from cancellation. Publication, deployment, and metadata workflows retain their own policies.

The [Saki Actions policy](2026-08-18-saki-actions-cost-policy.md) owns workflow triggers and required-check behavior. Saki has no master-push CI or scheduled real-API e2e. Its PR aggregate retains `always() && github.event_name == 'pull_request'` and rejects failed, cancelled, or skipped dependencies, including draft runs. Wine retains unconditional resource cleanup.

## Alternatives considered

**Preserve every validation run.** Historical completion provides more per-revision evidence, but obsolete validation competes with the newest run. Pack validations do not publish packages and can safely be superseded.

**Cancel release-owned runtime builds.** Rejected because their outputs belong to a publication transaction, whose caller owns completion.

**Protect work with job-level concurrency.** A job-level group cannot exempt a job from cancellation of its entire workflow.

## Consequences

The policy does not guarantee that every intermediate revision or repeated manual validation completes. Different refs can still compete for shared host capacity. Cancellation is a request handled by GitHub Actions and its runners; cleanup can take time, and cancellation has no fixed latency guarantee.

## Verification

[Workflow regressions](../../../../scripts/ci-workflow.spec.ts) pin CI cancellation and manual benchmark budgets. [Release rehearsal regressions](../../../../scripts/tests/ci-release-selfhosted.spec.ts) preserve pack cancellation and publication isolation. [Saki workflow regressions](../../../../scripts/saki-actions-workflow.spec.ts) pin triggers and aggregate behavior. These configuration checks do not reproduce GitHub scheduling or runner shutdown.
