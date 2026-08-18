# Agent Note: Saki projection-driven Web client

Status: proposed

English | [中文](2026-08-18-saki-projection-driven-web-client.zh.md)

## Problem

Saki must present local Git, GitHub authority, Agent execution, model supply, automatic budgets, and recovery states in one Web product. If browser components join backend records, infer permissions, or treat push frames and optimistic gestures as authority, reconnect and failure paths will disagree with the control plane. Defining final visual layout before these states are proven would also mix product correctness with aesthetic preference.

## Proposal

`packages/saki/web-ui` remains one DSH client plugin for version 0.1.0 and follows the shipped client Cordis, slot, immutable-snapshot, and React-projection architecture. It consumes complete Saki Projections and submits Control Intents through `saki-host-api`; no component calls GitHub, Git, filesystem, credentials, or providers directly. `onChanged` and Host frames invalidate read models, while reconnect rebuilds them.

Typed `SakiViewAddress` values preserve Project and object context without using Host paths. The client distinguishes confirmed, refreshing, optimistic, stale, conflict, unavailable, repair, reconciliation, intervention, and empty states. Intent overlays retain the confirmed baseline and remain until a Projection confirms the external result. Project switching preserves drafts, pending work, and uncommitted state under their owning addresses.

Saki preserves the shipped DSH AppFrame, sidebar, Conversation and Settings implementations. DSH adds a generic root-scoped `main.surface` chain slot whose fallback renders Conversation and a `sidebar.primary.action` list slot below New Session. The Saki plugin uses those two interfaces for its pages and primary entries; DSH packages import no Saki types. Existing session-header, conversation-view and settings-section slots carry smaller additions.

Version 0.1.0 adds exactly two top-level Saki pages. Work presents Principal-scoped work across authorized Projects in a beginner-operable form and hides technical evidence until requested. Project provides Board, Milestones, Changes, Sessions & Runs, Trace and Project Settings as internal destinations for one selected Development Project. Conversation and Settings remain inherited DSH surfaces. Both Saki pages consume the same Projections and submit the same Intents as their detailed views. The [frontend contract](../../../../docs/saki/architecture/0.1.0-frontend-contract.md) and [Web UI integration baseline](../../../../docs/saki/architecture/0.1.0-web-ui-baseline.md) define required projections, flows, preserved DSH surfaces, small shell changes, accessibility semantics and product-level verification. They deliberately leave layout, visual hierarchy, density, color, type, motion and branding open for prototype review.

The supersession audit found no Saki-specific frontend note. This proposal extends rather than replaces the implemented [GUI layering and RPC](../../implemented/architecture/2026-07-19-gui-layering-and-rpc-protocol.md) and [Web client architecture](../../implemented/architecture/2026-07-19-gui-web-client-architecture.md) decisions. The proposed [dynamic client packages](2026-08-08-cordis-web-dynamic-packages.md) remains independent infrastructure; Saki uses the published plugin path without making its release depend on unresolved loader work.

## Alternatives considered

**Let components call provider APIs.** This bypasses Actor derivation, Grants, policy, recovery, and the typed Host transport.

**Mirror backend entities in one global browser store.** Browser joins would duplicate ownership and make partial refreshes appear authoritative.

**Apply push deltas as durable truth.** Notifications can be missed and are defined as invalidation hints; complete Projections remain the baseline.

**Split every Saki view into a package immediately.** One release and Consumer do not justify multiple package lifecycles; internal domains retain future split points.

**Replace the DSH root or sidebar from the Saki plugin.** This would duplicate navigation, settings, responsive layout and upstream UI maintenance. Two generic additive slots expose the needed variation with a smaller interface.

**Render Saki pages through `shell.overlay`, Settings, or a synthetic Session.** These locations carry transient chrome, deployment configuration, or Session-scoped state. Using them for Project pages would give navigation and lifecycle state to the wrong owner.

**Make one cockpit the product home.** It forces beginner work, project planning, execution evidence, Git review and Host operations into the same reading task. Separate pages preserve the relationships without requiring simultaneous visibility.

**Promote every internal destination to global navigation.** Board, Changes, Runs and Trace share one selected Project and lifecycle. Separate global pages would broaden navigation before their audiences or release lifecycles diverge and would make Project switching harder to reason about.

**Lock high-fidelity design in the architecture document.** Visual preference needs prototype comparison, while state and failure semantics need durable contracts.

## Acceptance criteria

- Every mutating gesture submits a typed Intent and displays its target Project, confirmation, conflict, or recovery state.
- Reconnect, reload, and Project switching preserve or rebuild state without converting optimistic data into authority.
- DSH conversation, Terminal, attachments, settings, and tool presentation are reused through services and slots.
- A beginner can complete a Work cycle without opening Git, model-supply, budget or synchronization controls.
- The composed version 0.1.0 bundle adds only Work and Project to primary navigation; Project sections preserve their selected Project and return addresses.
- Saki pages activate through `main.surface`, and removing the Saki plugin restores the ordinary Conversation fallback and sidebar without residual navigation state.
- Low-fidelity prototypes complete the dogfood loop without requiring simultaneous panes; high-fidelity visuals remain separately reviewable.

## Risks

Complete Projections may overfetch if their scopes are too broad, so Diff, logs, and event history stay bounded or paged. The Project page may accumulate unrelated responsibilities; each internal destination keeps one task and is promoted only after an independent audience, navigation lifecycle, cross-Project scope, Consumer, or release lifecycle appears. One Saki UI package may grow under the same rule. The two generic DSH slots add upstream maintenance and must stay free of Saki semantics. Separating visual decisions from the contract delays polish, but prevents aesthetic prototypes from concealing missing conflict, offline, intervention, and recovery states.
