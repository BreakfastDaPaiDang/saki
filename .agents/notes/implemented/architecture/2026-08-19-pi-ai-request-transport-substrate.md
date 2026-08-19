# Agent Note: Pi-ai request transport substrate

Status: implemented

English | [中文](2026-08-19-pi-ai-request-transport-substrate.zh.md)

## Problem

The generic pi-ai adapter originally accepted deployment profiles and per-request API keys only. It could not bind an application-owned pi-ai `CredentialStore` to immutable model collections, and it had no request-scoped extension point for model-hidden transport headers or response observation. The agent loop supplied a Session id but not the durable turn number needed to distinguish multiple turns in one Session.

These omissions block a specialized Codex integration, but the substrate and the carrier are separate obligations. The Codex carrier in the current pi-ai dependency overwrites a caller `User-Agent` and does not expose all required request identity on the final wire. Adapter extension points alone cannot make that carrier production-ready.

## Decision

**Expose model-hidden turn identity.** `GenerateOptions.turn` is an optional Session-local number. The agent loop stamps its current durable turn on every request it builds, so all steps within one turn share the value and the next turn advances it. Auxiliary calls outside a conversation turn may omit it. The value adds no model-visible input and is reconstructable from existing durable turn boundaries.

**Bind credentials at immutable collection construction.** `PiAiAdapterOptions.credentials` accepts pi-ai's public `CredentialStore`. Every profile snapshot passes that exact value to `createModels({ credentials })`; omission keeps pi-ai's default. The shipped configurable-provider plugin omits the store and continues to resolve API keys through the Harness credential seam. A specialized adapter owner supplies any login, persistence, refresh, and protection lifecycle; `LlmRuntime` gains no credential API.

**Keep transport preparation narrow and explicitly asynchronous.** Each stream call captures provider, model, optional Session id, and optional turn before its first asynchronous wait. `prepareTransportRequest` receives only that captured identity and may return dynamic headers plus a response observer directly or through a Promise. The adapter awaits preparation once, immediately copies its headers, and forwards the observer result for pi-ai to await before body consumption. Preparation rejection prevents dispatch, observer rejection follows pi-ai's provider-error stream, and caller mutation cannot change the captured identity or prepared headers. The hook receives no messages, system prompt, credential, mutable provider object, or cancellation authority.

**Reserve request-owned headers at profile resolution.** Static profiles that name `session-id`, `thread-id`, `x-client-request-id`, `x-codex-turn-state`, or `user-agent` fail load-time serviceability validation case-insensitively without exposing the value. Dynamic headers merge after resolved authentication and deployment headers, and Harness attribution merges last.

**Defer carrier adoption to an official release.** This repository carries no package-manager patch, vendored carrier, or copied Responses transport for this decision. A specialized Codex consumer remains blocked until a published upstream pi-ai release preserves application attribution and supplies the required final-wire identity. Adoption then requires an exact-wire fixture against that released artifact.

## Alternatives considered

- **Store transport state by Session alone** — conflicts with the official per-turn model-client lifecycle and can send a prior turn's state in a later turn.
- **Expose mutable pi-ai providers to callers** — lets request-specific code mutate shared provider behavior and breaks the adapter's immutable snapshot ownership.
- **Add credential storage to `LlmRuntime`** — moves a provider-library capability into the provider-neutral service even though only the pi-ai collection consumes it.
- **Patch or copy the Codex carrier in this change** — a root package-manager patch would not reach independently installed package consumers, while copying the transport would duplicate authentication, streaming, retries, request serialization, and upstream fixes.

## Consequences

Core LLM requests now have enough model-hidden identity for a provider-specific owner to key ephemeral state by Session and turn without adding a Session event. The generic pi-ai adapter can consume an application-owned credential store and observe final request/response metadata while remaining unaware of account profiles, authorization tasks, sticky-state maps, or product schemas.

The extension point does not claim a production Codex route. The future consumer and carrier adoption remain a separate change gated on an official upstream release and final-wire evidence. Static deployment profiles that previously relied on one of the five request-owned names now fail loudly and must move that value into a request preparation owner.

## Testing

Focused tests prove that every immutable profile snapshot receives the injected store, request identity survives caller mutation across credential waits, asynchronous preparation and response observation are each awaited once with rejection propagation, generic provider paths apply final header ownership, and case-variant static collisions fail profile resolution without exposing their values. Agent-loop coverage proves that steps in one turn share the stamped number and the next durable turn advances it. No Codex exact-wire fixture is part of this substrate decision.
