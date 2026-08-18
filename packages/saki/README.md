# saki/ — private product packages

English | [中文](README.zh.md)

Saki-specific product semantics live under `packages/saki/<pkg>` and use the `@breakfastdapaidang/saki-<pkg>` namespace. These packages remain private and follow the same TypeScript, Cordis, invariant, documentation, graph, catalog, and license gates as DSH packages. The [governance reference](../../docs/saki/package-governance.md) owns the namespace and release rules.

| Package | Role | ctx key |
| --- | --- | --- |
| [`control-plane/`](control-plane/README.md) | Installation foundation, local Access authority, and protected product Projection | `sakiControlPlane` |
| [`host-api/`](host-api/README.md) | Dual-face `/saki` Host and browser transport adapter | `sakiHostClient` on the browser face |
| [`bundle/`](bundle/README.md) | Saki composition root and repository-local Host launcher | mounts the control plane, transport, and `saki-readiness` |

Add a package only when a product slice has an independently testable role. Generic Harness capabilities stay in an existing DSH group; planned Saki packages are not placeholders to create in advance.
