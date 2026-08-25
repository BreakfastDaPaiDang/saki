# @deepseek-ai/dsh-storage

English | [中文](README.zh.md)

Storage hub (`ctx.storage`) for non-session data: a named backend registry plus mounted data-form facilities. The hub performs no IO itself — backends own media, and data forms own semantics. The [storage family overview](../README.md) maps those packages; the [domain KV storage Agent Note](../../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md) records the design rationale.

## Shape

- `ctx.storage.backend` — name → backend table. Multiple backends stay mounted side by side (`json`, `sqlite`); which backend serves a consumer is that consumer's configuration (the domain layer's route table), never a hub-global choice. `register()` returns the disposer; duplicate names and unknown lookups fail loud.
- `ctx.storage.mount(form, facility)` / `ctx.storage.form(form)` — data-form mounting. `StorageForms` is merge-extensible; the domain layer merges `domain` and is reached as `ctx.storage.domain`.
- A backend owns one medium and exposes the data-shape facets it supports. `kv` is the current facet; `src/backend.ts` owns its exact contract. A unit version must be a non-negative safe integer; negative zero is invalid. Stored values are exact JSON data: encoding must not omit or coerce `undefined`, non-finite numbers, negative zero, sparse arrays, cycles, accessors, or exotic objects. Text-backed values use the shared strict parser, which also rejects comments, trailing commas, duplicate object members, and numeric tokens that JavaScript would round, underflow, or overflow. Write inputs are borrowed only through admission, and `loadAll()` returns a fully detached value graph, so later caller mutation cannot change in-memory or durable state. Backend close synchronously stops new opens and live-unit methods before draining admitted work. A backend may also expose `kv.closed` for non-mutating inspection and reads plus create-only materialization of units with no live handle. Each cold operation runs inside a callback-scoped name reservation: ordinary opens and competing reservations fail immediately. `ClosedUnitReservations` is the shared name-ownership and settlement tracker; a backend rejects reservation attempts after close and rejects live/open conflicts before calling `reserve()`, then stops admission before awaiting `settlements()` during close. Once the scope observes callback settlement it ends lease admission, so escaped leases and commit tokens reject with `closed`; reservation release and backend close wait for every lease method admitted earlier to drain, including methods the callback did not await.
- A resolved write is durable. `durability-uncertain` carries `published: true` when the requested value is visible but its durability could not be confirmed; `commit-outcome-unknown` carries `publicationPossible: true` when publication itself cannot be decided. Callers must stop serving from that live unit, close it, discard and recreate the affected backend (or restart), and only then reopen from the medium. Create-only cold materialization returns a lease-scoped `durable` or `uncertain` result instead of collapsing those outcomes into a pre-publication rejection.

## Model Experience

### Backend and form registrations

#### What the model sees

Nothing. `ctx.storage` is a host-side registration table; the hub registers no tools, injects no prompts, and writes no session events.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of live requests: the hub never touches a request prefix, so it cannot invalidate provider cache reuse.

## Known Limitations and Deferred Work

- **`kv` is the only data shape** — backends currently have one facet to implement.
- **Forms resolve lazily** — reading `ctx.storage.domain` before the domain plugin mounts throws `form-not-mounted`; assemblies order plugins accordingly (misconfiguration fails loud rather than silently deferring).
