# Agent Note: Saki Web shell registration (K1a)

Status: implemented

English | [中文](2026-08-27-saki-web-shell-registration.zh.md)

## Problem

Saki 0.1.0 needs its real bundle to serve a browser product: after the local bootstrap, an operator registers the first Development Project from an existing directory and lands on its Development Workspace, with reload and Host restart returning to the same place. The [projection-driven Web client proposal](../../proposed/architecture/2026-08-18-saki-projection-driven-web-client.md) and the [frontend contract](../../../../docs/saki/architecture/0.1.0-frontend-contract.md) own the product framing: two Saki pages join the DSH shell without replacing it. The open question was the mechanism — which shell increments carry Saki pages, how the private bundle composes the client stack, and how the browser survives mount ordering, reload, and restart.

## Decision

Two generic, product-agnostic shell increments carry the Saki pages. `packages/client/ui-layout` declares `main.surface`, a root-scoped chain slot rendered in the center column with the shipped `conversation` entry as its fallback; the fallback stays mounted so conversation state survives a takeover. The election currency is a plain string token: `ctx.layout.requestSurface(key)` writes the layout store, a request fired before the frame mounts is buffered on the `LayoutController` and flushed when the panel actions attach, and `null` hands the column back to the fallback. `packages/client/ui-sidebar` declares `sidebar.primary.action`, a root-scoped list slot rendered directly under New Session whose entries receive the column's wide state. Removing every takeover registration restores the ordinary conversation fallback and sidebar with no residual state; no DSH package imports a Saki type.

The Saki bundle composes the browser stack in `cordis.patch.yml`: the Typert registry/loader, API gateway, and commands that the DSH client services inject; the client module system (`modules`, `api-remotes`, `client-runtime`); the shell roster (theme, locale, layout, renderer, sidebar, settings, conversation, workspace, official brand); the `saki-web-ui` plugin; and a `saki-web-runtime` glue plugin that serves the built `@deepseek-ai/dsh-web-frontend` dist through the webserver fallback seat via `dsh-host-frontend-static`. The dynamic client/host runner chain is deliberately absent: dynamic plugin packages are not 0.1.0 surface area.

`@breakfastdapaidang/saki-web-ui` is one client plugin, as the proposal requires. It owns a navigation store (surface, selected and last Project id) persisted under the `saki.navigation` localStorage key; selecting a conversation session clears the Saki surface, and the nav-to-surface effect publishes the token through `requestSurface`. The Access gate renders inside the elected Saki surface and exchanges the launcher-printed bootstrap secret; registration uses a typed directory path, not a browse dialog, because registration requires the canonical path plus server-side evidence confirmation, and picker integration is a later polish slice. The workspace view renders confirmed projections and distinguishes loading, refreshing, stale, not-found, denied, unavailable, and offline states. The control plane's durable Browser Session survives a Host restart, so a cookie-bearing browser returns to the persisted address without a new exchange, while a cookie-less browser must complete the session-required exchange with the restart's fresh secret.

Out of scope here by decision: binding detection, rebind, retirement, and history migration ([#26](https://github.com/BreakfastDaPaiDang/saki/issues/26)); Project Settings, automation policy, and budgets (K7); the agent stack behind the Conversation fallback's `/api` (a later slice — the fallback renders, but session creation is unavailable and the console shows `/api` reconnect noise).

## Alternatives considered

**Reuse `shell.overlay` or a synthetic Session for Saki pages.** The proposal already rejected this: overlay chrome and Session-scoped state belong to other owners, and page navigation would inherit the wrong lifecycle.

**Elect surfaces by component identity.** Letting a registration render itself when active couples the shell to entry identity. A plain string token keeps the shell free of product types and makes the fallback rule one comparison.

**Fail a pre-mount `requestSurface`.** The plugin apply order is legitimate assembly, so a strict face would force ordering knowledge onto every feature plugin. Buffering one request preserves the caller's intent without a queueing contract.

**Spawn the dynamic plugin runners.** The dynamic loader chain is unresolved infrastructure, and the proposal keeps Saki on the published plugin path; static composition ships the same pages without it.

**Native directory picker for registration.** The picker notes ([2026-07-27](./2026-07-27-native-workspace-directory-picker.md)) cover workspace selection, but registration must confirm the canonical path against Host inspection; typed input keeps that contract explicit and testable, and the picker can be added later without changing the Intent.

## Consequences

The bundle boots to a working browser product with `node packages/saki/bundle/lib/bin.js`; `pnpm run saki` serves the same surface from source. The product-level proof is `packages/saki/bundle/tests/web-registration.e2e.ts`: it boots the built bundle on a random port with a fresh Installation, drives Chromium through bootstrap, two registrations, a repeat registration that must settle, reload address restore, a restart that the durable session survives, and a cookie-less re-authentication, with every interaction bounded so a server stall fails the step. The e2e exists because an earlier manual pass mistook a stale process squatting the fixed debug port for a server hang; the harness rules (random ports, fresh homes, bounded waits, forced teardown) keep that class of false evidence out.

The shell increments are additive and generic, so future DSH features can take the same slots without Saki knowledge. The Conversation fallback renders without its agent stack until a later slice composes `/api`; the reconnect noise is confined to the console and documented in the bundle README. The 工作 page ships as an honest unavailable placeholder until its projection seam lands.
