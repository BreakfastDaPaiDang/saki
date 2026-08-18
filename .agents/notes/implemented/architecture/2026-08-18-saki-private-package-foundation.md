# Agent Note: Saki package-family enforcement and empty bundle

Status: implemented

English | [中文](2026-08-18-saki-private-package-foundation.zh.md)

## Problem

[ADR 0002](../../../../docs/adr/0002-plugin-first-single-repository.md) keeps Saki-specific plugins in this repository without moving product semantics into DSH core. The workspace discovers every `packages/*/*` manifest, but repository checks treated that tree as the publishable `@deepseek-ai/dsh-*` family. A second product namespace therefore needs one classification mechanism that preserves DSH behavior, prevents private Saki packages from entering a release, and supports a runnable first slice without pre-creating the package topology described by [ADR 0006](../../../../docs/adr/0006-modular-control-plane-and-four-capability-seams.md).

## Decision

**Centralize product-family classification.** `classifyProductPackage` recognizes only the existing DSH family and `@breakfastdapaidang/saki-*`; `privateSakiPackageViolations` couples the Saki namespace to `packages/saki/<pkg>` with the same `<pkg>` suffix, `private: true`, absent npm publication metadata, and a package-local valid SemVer. Manifest validation delegates SemVer syntax to the maintained `semver` parser. Workspace constraints, license checks, dependency graphs, and release tools consume this classifier instead of duplicating prefix rules.

**Make release membership explicit.** The DSH `ReleaseFamily` and legacy npm-baseline command exclude the Saki family even though their discovery scans include `packages/saki/*`; baseline packing consumes only the exact DSH and vendor directories in the discovered publication set. Existing DSH publication semantics remain owned by the [npm release sequences](../process/2026-08-10-npm-release-sequences.md); publishing Saki requires a separate release-family decision rather than inheriting DSH membership from a broad glob.

**Keep engineering checks family-neutral.** The shared package rules, source-plane mappings, project references, license and invariant checks, generated catalogs, module graph, and bundle resolution accept both classified product families. The [package governance reference](../../../../docs/saki/package-governance.md) owns the complete current package and publication rules.

**Prove only the first composition root.** `@breakfastdapaidang/saki-bundle` owns an empty Cordis root, one patch layer, and the repository-local launcher. Its sole row provides a stable readiness record. The launcher emits that record and requests clean exit only after `boot()` completes its entry-activation audit; a reporting failure disposes the application and enters the launcher's failure path. Later packages arrive with independently testable product slices; planned names do not justify placeholder directories.

## Consequences

`pnpm run saki` proves that a clean checkout can resolve and run Saki source without credentials, while the built executable proves plain-Node artifact resolution. The command remains a repository entry separate from machine-local Windows wrappers and proxy bootstrap. Generated package documentation uses collision-free `saki/<pkg>` graph keys, and broad filesystem scans cannot make a private Saki manifest a DSH release member.

The initial bundle has no persistence, identity, GitHub, Agent, model, server, or Web behavior. Each later slice decides whether it owns reusable Harness capability in a DSH group or Saki product semantics under `packages/saki/`; neither the accepted architecture nor a planned package name creates a package by itself.

## Alternatives considered

- **Repeat namespace tests in every repository script** — lets catalog, graph, constraint, and release interpretations drift independently.
- **Rely on `private: true` alone** — prevents npm publication but does not enforce namespace location, graph identity, valid versioning, or exclusion from repository release orchestration.
- **Validate package versions with a local regular expression** — duplicates npm SemVer rules and accepts or rejects edge cases incorrectly.
- **Pre-create the full planned Saki package topology** — assigns ownership before behavior and makes speculative boundaries look stable.
- **Add Saki startup behavior to the DSH CLI** — couples product composition to the upstream application instead of using its bundle extension point.
