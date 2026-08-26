# `@breakfastdapaidang/saki-web-ui`

English | [中文](README.zh.md)

The Saki Web client plugin. It registers the two top-level Saki entries — 「工作」 and 「项目」 — into the DSH shell's additive `sidebar.primary.action` list slot, and one takeover entry into the `main.surface` chain slot whose fallback stays the shipped Conversation. The plugin owns the small navigation store (active surface, selected and last Project) persisted across reloads, and drives `ctx.sakiHostClient` for access, Project index, selection inspection, registration, and Development Workspace reads. It never calls GitHub, Git, the filesystem, or credentials directly, and never infers buttons from raw status.

## Composition

- `sidebar.primary.action`: entries `saki-work` and `saki-project` render the two primary destinations under New Session, rail-aware through the owner `wide` flag.
- `main.surface`: one chain entry elects on the generic shell surface token (`saki:work` / `saki:project`); with no election the Conversation fallback renders, and it stays mounted under a takeover so in-progress conversation state survives.
- The navigation store publishes the surface token through `ctx.layout.requestSurface`; a Session becoming current clears the Saki surface, handing the center column back to the Conversation.

## Model Experience

None, as the plugin registers no model-facing input and makes no provider request.

#### KV Cache effect

None; the plugin reads typed Projections only.

## Known Limitations and Deferred Work

- **No My Work Projection yet** — the 「工作」 page renders an explicit unavailable state pointing at 「项目」; the real page arrives with the K2 slice.
- **No client push channel** — the client re-queries on navigation, refresh, and after Intents; `onChanged` is host-side only in this slice.
- **Directory selection is a validated path input** — the browse dialog is not composed in this slice; the backend re-inspects any submitted path before registration.
- **Repair and rebind are read-only here** — binding `missing` / `repair-required` states render with history readable and no repair action; they belong to the Resource Binding slice (#26).
