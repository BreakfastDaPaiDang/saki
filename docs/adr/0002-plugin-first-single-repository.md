---
status: accepted
---

# Prefer DSH plugins inside one Saki repository

English | [中文](0002-plugin-first-single-repository.zh.md)

Saki-specific behavior uses DSH bundle, Service Definition, Provider, and Consumer extension points, while its packages remain in the Saki repository during the current product stage. Runtime module seams and Git repository boundaries are separate decisions: one repository permits atomic refactoring and compatibility updates while DSH interfaces evolve.

## Considered options

A repository per feature appears isolated but introduces version skew, cross-repository CI, and coordinated-release cost before the interfaces or audiences are independent. Implementing Saki semantics directly in DSH core would increase upstream conflicts and make the generic harness depend on one product.

## Consequences

Extract a plugin into its own repository only when it has a stable DSH-facing interface, independent users or maintainers, an independent release cadence, or a distinct deployment or security lifecycle. Generic capability improvements remain candidates for upstream contribution; Saki Project semantics remain Saki-owned.
