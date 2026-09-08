---
description: "Saki Web client plugin: the 工作/项目 top-level entries over the DSH shell's additive slots, the Access gate, Project selector, registration dialog, and Development Workspace view."
kind: "package-reference"
---

# `@breakfastdapaidang/saki-web-ui`

English | [中文](README.zh.md)

## Summary

The Saki Web client plugin. It registers the two top-level Saki entries — 「工作」 and 「项目」 — into the DSH shell's additive `sidebar.primary.action` list slot, and one takeover entry into the `main.surface` chain slot whose fallback stays the shipped Conversation. The plugin owns the small navigation store (active surface, selected and last Project) persisted across reloads, and drives `ctx.sakiHostClient` for access, Project index, selection inspection, registration, and Development Workspace reads. It never calls GitHub, Git, the filesystem, or credentials directly, and never infers buttons from raw status.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Mount this plugin in a composition that also carries the shell roster and the `/saki` Host API; the two sidebar entries then open the Saki pages.

- `sidebar.primary.action`: entries `saki-work` and `saki-project` render the two primary destinations under New Session, rail-aware through the owner `wide` flag.
- `main.surface`: one chain entry elects on the generic shell surface token (`saki:work` / `saki:project`); with no election the Conversation fallback renders, and it stays mounted under a takeover so in-progress conversation state survives.
- The navigation store publishes the surface token through `ctx.layout.requestSurface`. Only the sidebar entries move the surface: a Session becoming current leaves an elected Saki page in place — the shell's startup Workspace auto-connect must not evict it — and the Conversation fallback renders exactly while no Saki surface is elected.

<a id="model-experience"></a>
## Model Experience

None, as the plugin registers no model-facing input and makes no provider request.

#### KV Cache effect

None; the plugin reads typed Projections only.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **No My Work Projection yet** — the 「工作」 page renders an explicit unavailable state pointing at 「项目」; the real page arrives with the K2 slice.
- **Session clicks do not hand the center column back** — Saki surfaces own the surface in this slice: a Session becoming current (including the shell's startup Workspace auto-connect) never evicts an elected page, and a gesture-level hand-back to the Conversation needs a conversation-side election mechanism that does not exist yet.
- **No client push channel** — the client re-queries on navigation, refresh, and after Intents; `onChanged` is host-side only in this slice.
- **Directory selection is a validated path input** — the browse dialog is not composed in this slice; the backend re-inspects any submitted path before registration.
- **Repair and rebind are read-only here** — binding `missing` / `repair-required` states render with history readable and no repair action; they belong to the Resource Binding slice (#26).

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No runtime invariant companion is published because the package only renders Saki Projections through the shell's additive slots and submits Intents through `saki-host-api`; it emits no cordis events and owns no cross-plugin mutable state, and its slot registrations prove disposal through the HMR-safety spec.

</details>
