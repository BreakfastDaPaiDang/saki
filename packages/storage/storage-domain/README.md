# @deepseek-ai/dsh-storage-domain

English | [中文](README.zh.md)

Domain data form for the DeepSeek Harness storage hub: exposes the injectable `ctx.storageDomain` service and the matching `ctx.storage.domain` projection after every configured backend is registered. A domain is declared once with `defineDomain` (zod record schemas, `z.infer`-derived types), opened through `DomainFacility.open`, and served from authoritative in-memory state — reads are synchronous, writes serialize on one per-domain chain, reach durability on the routed backend first, then update memory and emit `domain/changed`. A backend report that publication or durability is uncertain poisons the live domain without changing memory or emitting an event: the original caller receives the backend error, every queued or later read/write rejects with `write-outcome-uncertain`, and `close()` still drains and releases the handle. Recovery closes that handle, discards and recreates the affected backend (or restarts), and only then reopens from the medium. The opening consumer owns the handle's lifecycle and releases it with `Domain.close()` (idempotent; typically its own `ctx.effect` disposer); on plugin unmount, the facility attempts every remaining domain close to settlement before reporting failures and always removes its storage form. For maintenance, `defineDomainMigrations` declares a complete adjacent forward chain, while `DomainFacility.migrate` validates a closed retained source and create-only materializes a different missing target; `materialize` provides the same validation and publication path for fresh current-version state.

`DomainSpec.version` must be a non-negative safe integer; negative zero is invalid.

Design rationale, open semantics, and the storage/domain layer split live in the [Agent Note](../../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md).

## Configuration

| key | meaning |
| --- | --- |
| `backend` | Default backend name for every domain (required; no universally correct medium exists). |
| `routes` | Per-domain overrides: domain name → backend name. |

## Cold migration

Migration is explicit and opt-in. Ordinary `open` retains its exact-version behavior and never discovers or rewrites an older unit. `defineDomainMigrations` is the only plan constructor: it verifies the continuous chain and captures frozen copies of the schema declaration containers, so a forged or later-mutated declaration cannot change an admitted plan. A migration reserves the domain name and both backend unit names, rejects an existing target before reading the source, validates the retained source schema and every adjacent step output, then reads the target back through the same reservation. Readback must equal the intended validated snapshot as raw JSON data (object member order is irrelevant) and independently pass the current schema; a valid but changed value is still `migration-target-invalid` with `committed: true`. The source is not changed; no live domain is opened and no `domain/changed` event is emitted. Caller cancellation applies until target publication. An uncertain materialization is classified by readback: an exact returned target reports `migration-target-durability-uncertain` with `committed: true`, confirmed absence reports `migration-target-not-committed`, and a rejected readback reports `migration-target-outcome-unknown`. A durable materialization whose readback rejects has a known commit but an unverifiable target, so it reports `migration-target-invalid` with `committed: true`; a successfully returned snapshot that is schema-invalid or divergent reports the same failure. None of these outcomes triggers blind retry or target deletion.

## Model Experience

### Durable domain state

#### What the model sees

Nothing. The package registers no tools, injects no prompts, and appends no session events; it stores non-session data (workspace records, future session sidecars) behind `ctx.storageDomain` and emits only the in-process `domain/changed` event, which reaches a model only if a Consumer package renders it through its own documented surface.

#### Token effect

Zero. No text from this package enters any model request.

#### KV Cache effect

Independent: domain reads and writes never touch request prefixes, so nothing here can invalidate provider cache reuse.

## Known Limitations and Deferred Work

- **Single-process change visibility** — `domain/changed` is an in-process event; a second host process or a reconnecting GUI observes no changes until the cross-process revision pattern deferred in the Agent Note lands.
- **No cross-table transactions, secondary indexes, or multi-segment keys** — each write touches one record; triggers and rework points for these extensions are tabled in the Agent Note's deferred-work list.
