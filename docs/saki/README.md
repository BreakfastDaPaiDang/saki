# Saki

English | [中文](README.zh.md)

This directory owns product and operational documentation specific to Saki. General DeepSeek Harness architecture and user documentation remain in their existing upstream locations.

## Product

- [Product requirements](product-requirements.md) define long-term positioning, domain abstractions, principles, and stage boundaries.
- [Version 0.1.0 implementation specification](versions/0.1.0.md) defines the first usable Stage 1 slice and its release criteria.
- [Domain contexts](../agents/domain.md) define canonical language, and [ADRs](../adr/0004-control-and-execution-planes.md) preserve accepted architectural decisions.

## Operations

- [Host launcher](host-launcher.md) defines the checked-in Windows launch entry point and proxy behavior.
- [Upstream synchronization](upstream-sync.md) defines how Saki tracks DeepSeek Harness without inheriting unsuitable workflows.
