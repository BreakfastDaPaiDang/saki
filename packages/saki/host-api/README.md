# `@breakfastdapaidang/saki-host-api`

English | [中文](README.zh.md)

The private dual-face Saki Host API adapts the control plane to the shared Connection carrier. The Host entry registers the Saki-owned `/saki` logical channel; the `./client` entry registers `ctx.sakiHostClient` in a browser context. `./wire` contains strict browser-safe schemas shared by both faces.

## Endpoints

| Endpoint | Request | Result |
| --- | --- | --- |
| `access/read` | `{}` | Closed Access Projection |
| `access/exchange` | `{ secret }` | Bootstrap exchange result; `Set-Cookie` stays outside JSON |
| `access/logout` | `{}` plus request-token header | Logout result; cookie expiry stays outside JSON |
| `control/query` | `{ type: 'inspect-project-selection', hostId, directoryLocator }` | Authorized Projection containing a safe selection or bounded selection rejection, or outer denied/unavailable |
| `control/query` | `{ type: 'project-index' }` | Revisioned Project-index Projection or denial |
| `control/query` | `{ type: 'development-workspace', projectId, expectedRegistryRevision }` | One Development Workspace Projection or typed rejection |
| `control/query` | `{ type: 'project-settings', projectId }` | Current safe GitHub synchronization configuration, activation state, and complete-scan evidence, or typed rejection |
| `control/query` | `{ type: 'board', projectId, refresh: 'cached' \| 'interactive' }` | Current complete Board generation and synchronization evidence, or typed rejection |
| `control/submit` | Complete `register-development-project` Intent plus request-token header | `SakiIntentReceipt`: confirmed receipt or typed denied, unavailable, conflict, failure, or reconciliation-required result |
| `control/submit` | Field-scoped `configure-github-synchronization` Intent plus request-token header | Saved receipt or typed denied, unavailable, conflict, or failure result |

All request schemas are strict. Query and Intent result schemas correlate each request kind with its exact Projection, receipt phases, and failure reasons. Repeating a synchronization configuration that is identical to the current pending or active value returns the typed `configuration-unchanged` conflict without allocating a revision. A Board result contains either one atomic confirmed generation with its matching checkpoint or an explicit unconfigured/awaiting state; it never carries a partial provider page and admits at most 10,000 Work Items. An oversized scan exposes a typed capacity failure with the fixed resource and limit plus the observed count. The Board schema recomputes each Work Item id from the Repository and Issue identities and cross-checks GitHub item order, current configuration revision, mapping, failure, scan, freshness, checkpoint, and the exact effective-mutation reason set. The Host adapter validates control-plane results before serialization, so unexpected authority fields, canonical paths, credential material, raw provider details, and mismatched Projection kinds fail with the fixed opaque error. `/saki` rejects a non-empty URL query before operation dispatch or body decoding. The adapter never ignores browser fields that attempt to supply Principal, Grant, Actor, AuthenticationContext, or lifecycle authority. Route-trust failures, malformed envelopes, method mismatches, invalid operation payloads, returned RPC errors, and unexpected implementation failures all use one fixed opaque internal error without parser, request, or exception details. Every pre-handler, handler, success, denial, and error reply carries `Cache-Control: no-store`; cookie headers remain outside JSON.

## Transport responsibilities

Connection owns route trust, bounded JSON framing, correlation, cancellation, disposal, and JSON Content-Type. The `/saki` registration requires `Cache-Control: no-store` and the fixed opaque error on the Connection channel, so those policies also cover failures before the Host adapter runs. The Host adapter reads Cookie, Origin, and `x-saki-request-token` only from Connection's trusted request metadata. It asks the control plane's Host-only resolver for an AuthenticationContext and consumes the opaque post-commit cookie handoff. Neither AuthenticationContext nor raw cookie material enters browser JSON.

The browser client uses same-origin credentials on every call. Logout and every Intent submission require the current request token. It exposes exact methods for selection inspection, Project-index, Development-Workspace, Project Settings, Board lookup, first registration, and field-scoped GitHub synchronization configuration; each method parses only its corresponding result schema. `queryBoard(projectId, 'cached')` is a pure durable read. The `interactive` policy durably schedules a high-priority complete scan and returns the current durable Projection without exposing an in-progress page. Business denials remain typed successful RPC values, while cancellation, carrier failures, and schema mismatches reject through the fixed opaque Connection RPC error envelope.

## Model Experience

None, as the Host and browser adapters carry Saki access and Projection values without registering model-facing input.

#### KV Cache effect

None; the package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Loopback channel only** — `/saki` uses Connection's loopback authority; remote authentication and network exposure need a different deployment design.
- **Read-only Board** — Board and Project Settings expose complete-scan checkpoints, mapping health, freshness, safe failure, scheduling state, and effective mutation unavailability. Rebind, retire, and remote GitHub mutations are outside this package's current operation set.
- **No frontend composition** — this package supplies the client service and schemas, not routes or rendered UI.
