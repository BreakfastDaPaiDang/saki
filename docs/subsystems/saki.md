# Saki control plane

English | [中文](saki.zh.md)

The Saki control plane owns product state independently from agent conversations. Its first release surface establishes one stable local Installation, one enrolled Host, one human Principal with a current Host Operator Grant, and one versioned Installation Access aggregate. The [Saki backend architecture](../saki/architecture/0.1.0-backend.md) defines the wider control-plane and execution-plane split; this page is the reference for the implemented Cordis service.

## Installation access

[`saki-control-plane`](../../packages/saki/control-plane/README.md) persists digest-only Bootstrap Challenge and Browser Session entries in SQLite through `storageDomain`. A bootstrap exchange consumes one issued challenge and creates one active session in the same compare-and-set update. The browser cookie authenticates the Principal; every protected operation still reads the current Installation generation, Principal lifecycle, and Grant authority. Raw bootstrap and cookie credentials remain in their exact launcher or HTTP carrier locations, while the authenticated Access Projection carries only the derived request-forgery token required for later mutations.

## Host transport

[`saki-host-api`](../../packages/saki/host-api/README.md) owns strict endpoint schemas on the logical `/saki` [Connection](../../packages/client/connection/README.md) channel. The Host adapter extracts cookies and request headers outside JSON, constructs the non-wire `SakiAuthenticationContext`, and returns `Set-Cookie` outside the RPC result. B01 exposes the empty Project-index Projection and rejects every Control Intent with the stable `intent-unavailable` result; the first successful Intent belongs to B03.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxsakicontrolplane--sakicontrolplanemodule"></a>

### `ctx.sakiControlPlane` — `SakiControlPlaneModule`

Public deep-module operations used by Host and future automation Consumers.

```ts cordis-catalog
/**
 * Read trusted local Installation and Host identities.
 * @returns stable independent identities.
 */
identity(): SakiInstallationIdentity

/**
 * Query one protected Projection after revalidating current authority.
 * @param authentication - trusted server-derived AuthenticationContext.
 * @param query - closed B01 Projection query.
 * @param signal - caller cancellation.
 * @returns authorized Projection or safe denial.
 */
query( authentication: SakiAuthenticationContext, query: SakiQuery, signal: AbortSignal, ): Promise<SakiQueryResult>

/**
 * Reject the empty B01 Intent map after revalidating current authority.
 * @param authentication - trusted server-derived AuthenticationContext.
 * @param intent - absent only while the merge-extensible Intent map is empty.
 * @param signal - caller cancellation.
 * @returns stable unavailable receipt.
 */
submit( authentication: SakiAuthenticationContext, intent: SakiIntentInput, signal: AbortSignal, ): Promise<SakiIntentReceipt>

/**
 * Subscribe to contained post-commit Projection invalidations.
 * @param listener - listener that re-queries affected Projection keys.
 * @returns disposer removing the listener.
 */
onChanged(listener: (keys: readonly SakiProjectionKey[]) => void): SakiChangedDisposer
```

Source: [`packages/saki/control-plane/src/service.ts:120`](../../packages/saki/control-plane/src/service.ts)
<!-- END GENERATED cordis-surface -->
