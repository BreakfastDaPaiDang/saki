# Saki

English | [中文](README.zh.md)

This directory owns product and operational documentation specific to Saki. General DeepSeek Harness architecture and user documentation remain in their existing upstream locations.

## Product

- [Product requirements](product-requirements.md) define long-term positioning, domain abstractions, principles, and stage boundaries.
- [Version 0.1.0 implementation specification](versions/0.1.0.md) defines the first usable Stage 1 slice and its release criteria.
- [Version 0.1.0 backend architecture](architecture/0.1.0-backend.md) defines its Modules, capability seams, persistent ownership, and failure semantics.
- [Version 0.1.0 frontend contract](architecture/0.1.0-frontend-contract.md) defines client state, navigation, Projection consumption, Intent interaction, and verification without fixing a visual direction.
- [Version 0.1.0 Web UI integration baseline](architecture/0.1.0-web-ui-baseline.md) records the preserved DSH surfaces, separate Saki pages, beginner surface, and small shell additions.
- [Domain contexts](../agents/domain.md) define canonical language, and [ADRs](../adr/0004-control-and-execution-planes.md) preserve accepted architectural decisions.

## Operations

- [Maintenance](maintenance.md) defines dependency review, work ownership, and resumable Agent checkpoints.
- [Host launcher](host-launcher.md) defines the checked-in Windows launch entry point and proxy behavior.
- [Upstream synchronization](upstream-sync.md) defines how Saki tracks DeepSeek Harness without inheriting unsuitable workflows.
- [Development skill pack](development-skill-pack.md) defines repository discovery, compatibility preflight, pinned provenance, and the reviewed update procedure.
