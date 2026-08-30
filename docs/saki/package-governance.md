# Saki package governance

English | [中文](package-governance.zh.md)

[ADR 0002](../adr/0002-plugin-first-single-repository.md) owns the decision to keep Saki-specific plugins in this repository. This reference defines how their private product packages coexist with the vendored DeepSeek Harness package tree; the [package-family Agent Note](../../.agents/notes/implemented/architecture/2026-08-18-saki-private-package-foundation.md) records why repository checks share one classifier and why composition includes only implemented product slices.

## Namespace and location

Published Harness packages keep the `@deepseek-ai/dsh-*` namespace and existing release rules. Saki product packages live exactly at `packages/saki/<pkg>`, use `@breakfastdapaidang/saki-<pkg>` with the same `<pkg>` suffix, set `private: true`, and omit npm `publishConfig` and repository metadata. Their package versions are valid SemVer values independent of the DSH workspace release version.

The shared classifier is used by workspace constraints, license checks, dependency graphs, and release tooling. A Saki name outside `packages/saki/`, a different namespace inside that group, or a directory leaf that differs from its package-name suffix fails the workspace gate. The current DSH release family and the legacy npm-baseline command explicitly exclude Saki; baseline packing uses only the exact DSH and vendor directories in its selected set. Publishing Saki requires a future, deliberate release-family decision.

## Shared repository standards

Private does not mean unchecked. Saki packages use the same ESM entry layout, Cordis peer plus dev dependency, package-owned invariant companion, MIT declaration, source-plane TypeScript mapping, project references, build output policy, README obligations, generated catalogs, and module graph as DSH packages. Bundle manifests and Cordis rows also pass the generic bundle and source-resolution gates.

The second namespace changes classification only. Existing `@deepseek-ai/dsh-*` checks, versions, payload rules, catalogs, examples, and publish membership retain their prior meaning.

## Current bundle and local entry

The current package family is listed in [`packages/saki`](../../packages/saki/README.md). `@breakfastdapaidang/saki-bundle` keeps an empty root config and owns the declared patch that composes local access, existing-directory inspection, first Project registration, structured Git reads and direct mutations, and one readiness row. The storage domain uses JSON by default and routes current `saki_control_plane@5`, `saki_host_execution@1`, and `saki_storage_generation@3` into the same manifest-selected SQLite generation; Session logs retain their separate JSONL persistence. `pnpm run saki` is a repository development entry; it does not read or replace a user's `start-dsh-with-clash.ps1` or other host-local startup wrapper.

The launcher emits the stable readiness record only after `boot()` completes the entry-activation audit. `SAKI_ONESHOT=1` then exits zero without consuming a bootstrap handoff; normal mode emits one clear-secret launcher-handoff JSON line and remains alive until `SIGINT` or `SIGTERM`. A readiness output or exit-callback failure disposes the application and enters the launcher's failure path. A keyless snapshot covers the source entry, and a plain-Node smoke covers the built executable when artifacts exist.

## Expansion rule

Add the next Saki package with the product slice that needs it, not from the planned topology alone. A package belongs under `packages/saki/` when it owns Saki product semantics or composition. A reusable Harness capability that can stand without Saki belongs in the applicable DSH group and remains subject to the DSH contribution and release policy.
