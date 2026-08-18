# Saki package governance

English | [中文](package-governance.zh.md)

[ADR 0002](../adr/0002-plugin-first-single-repository.md) owns the decision to keep Saki-specific plugins in this repository. This reference defines how their private product packages coexist with the vendored DeepSeek Harness package tree; the [package-family Agent Note](../../.agents/notes/implemented/architecture/2026-08-18-saki-private-package-foundation.md) records why repository checks share one classifier and why the first slice contains only an empty bundle.

## Namespace and location

Published Harness packages keep the `@deepseek-ai/dsh-*` namespace and existing release rules. Saki product packages live exactly at `packages/saki/<pkg>`, use `@breakfastdapaidang/saki-<pkg>` with the same `<pkg>` suffix, set `private: true`, and omit npm `publishConfig` and repository metadata. Their package versions are valid SemVer values independent of the DSH workspace release version.

The shared classifier is used by workspace constraints, license checks, dependency graphs, and release tooling. A Saki name outside `packages/saki/`, a different namespace inside that group, or a directory leaf that differs from its package-name suffix fails the workspace gate. The current DSH release family and the legacy npm-baseline command explicitly exclude Saki; baseline packing uses only the exact DSH and vendor directories in its selected set. Publishing Saki requires a future, deliberate release-family decision.

## Shared repository standards

Private does not mean unchecked. Saki packages use the same ESM entry layout, Cordis peer plus dev dependency, package-owned invariant companion, MIT declaration, source-plane TypeScript mapping, project references, build output policy, README obligations, generated catalogs, and module graph as DSH packages. Bundle manifests and Cordis rows also pass the generic bundle and source-resolution gates.

The second namespace changes classification only. Existing `@deepseek-ai/dsh-*` checks, versions, payload rules, catalogs, examples, and publish membership retain their prior meaning.

## First bundle and local entry

`@breakfastdapaidang/saki-bundle` is the only initial Saki package. Its empty root plus declared patch mounts one readiness row, proving workspace discovery, source and artifact resolution, complete boot activation, deterministic output, and clean shutdown without credentials. `pnpm run saki` is a repository development entry; it does not read or replace a user's `start-dsh-with-clash.ps1` or other host-local startup wrapper.

The readiness row provides the stable record, and the launcher emits its one JSON line and exits zero only after `boot()` completes the entry-activation audit. A readiness output or exit-callback failure disposes the application and enters the launcher's failure path. A keyless snapshot covers the source entry, and a plain-Node smoke covers the built executable when artifacts exist.

## Expansion rule

Add the next Saki package with the product slice that needs it, not from the planned topology alone. A package belongs under `packages/saki/` when it owns Saki product semantics or composition. A reusable Harness capability that can stand without Saki belongs in the applicable DSH group and remains subject to the DSH contribution and release policy.
