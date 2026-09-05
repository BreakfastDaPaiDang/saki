---
description: "Find the private packages that assemble Saki, from local project operations and GitHub synchronization to Agent Runs and operator interventions."
kind: "package-group"
---

# saki/ — private product packages

English | [中文](README.zh.md)

## Summary

Find the private packages that assemble Saki, from local project operations and GitHub synchronization to Agent Runs and operator interventions.

The [Saki subsystem](../../docs/subsystems/saki.md) describes the services and their ownership.

## Table of Contents

- [Use this package](#use-this-package)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

## Packages

Saki-specific product semantics live under `packages/saki/<pkg>` and use the `@breakfastdapaidang/saki-<pkg>` namespace. These packages remain private and follow the same TypeScript, Cordis, invariant, documentation, graph, catalog, and license gates as DSH packages. The [governance reference](../../docs/saki/package-governance.md) owns the namespace and release rules.

| Package | Role | ctx key |
| --- | --- | --- |
| [`execution/`](execution/README.md) | Host-neutral read-only project-selection inspection Service Definition | `sakiHostExecution` |
| [`execution-local/`](execution-local/README.md) | Local filesystem, Git, subprocess, storage, and Workspace-index Service Provider for Host inspection and structured operations | provides `sakiHostExecution` |
| [`github/`](github/README.md) | Provider-neutral GitHub reads, complete Project-board scans, atomic mutations, targeted inspections, and Provider contract | `sakiGitHub` |
| [`github-app/`](github-app/README.md) | Saki Product GitHub App Service Provider with operation-scoped tokens, bounded complete scans, mutations, and targeted inspections | provides `sakiGitHub` |
| [`control-plane/`](control-plane/README.md) | Installation provisioning, local Access authority, durable Project registration, atomic GitHub Board publication, recoverable Work Item mutations, and protected product Projections | `sakiControlPlane` |
| [`host-api/`](host-api/README.md) | Dual-face `/saki` Host and browser transport adapter | `sakiHostClient` on the browser face |
| [`installation-maintenance/`](installation-maintenance/README.md) | Installation-wide lease, manifest-selected state generations, verified Recovery Backups, and offline forward upgrades | — |
| [`bundle/`](bundle/README.md) | Saki composition root and repository-local Host launcher | mounts the control plane, transport, and `saki-readiness` |

Add a package only when a product slice has an independently testable role. Generic Harness capabilities stay in an existing DSH group; planned Saki packages are not placeholders to create in advance.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
