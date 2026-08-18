# `@breakfastdapaidang/saki-host-api`

English | [中文](README.zh.md)

The private dual-face Saki Host API adapts the control plane to the shared Connection carrier. The Host entry registers the Saki-owned `/saki` logical channel; the `./client` entry registers `ctx.sakiHostClient` in a browser context. `./wire` contains strict browser-safe schemas shared by both faces.

## Endpoints

| Endpoint | Request | Result |
| --- | --- | --- |
| `access/read` | `{}` | Closed Access Projection |
| `access/exchange` | `{ secret }` | Bootstrap exchange result; `Set-Cookie` stays outside JSON |
| `access/logout` | `{}` plus request-token header | Logout result; cookie expiry stays outside JSON |
| `control/query` | `{ type: 'project-index' }` | Authenticated empty Project-index Projection or denial |
| `control/submit` | `{}` plus request-token header | Stable `intent-unavailable` result after authentication |

All request schemas are strict. Browser fields that attempt to supply Principal, Grant, Actor, AuthenticationContext, or lifecycle authority are rejected as `bad-request`; the adapter never ignores them. Unknown endpoints and malformed bodies expose no parser details. Unexpected implementation failures return one stable internal error without exception text.

## Transport responsibilities

Connection owns route trust, bounded JSON framing, correlation, cancellation, disposal, and JSON Content-Type. The Host adapter reads Cookie, Origin, and `x-saki-request-token` only from Connection's trusted request metadata. It asks the control plane's Host-only resolver for an AuthenticationContext and consumes the opaque post-commit cookie handoff. Neither AuthenticationContext nor raw cookie material enters browser JSON.

The browser client uses same-origin credentials on every call. Only logout accepts a request token in B01; the successful-submit method does not exist while the Intent map is empty. Business denials remain typed successful RPC values, while carrier and schema failures use Connection's RPC error envelope.

## Model Experience

None, as the Host and browser adapters carry Saki access and Projection values without registering model-facing input.

#### KV Cache effect

None; the package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Loopback channel only** — `/saki` uses Connection's loopback authority; remote authentication and network exposure need a different deployment design.
- **B01 operation set only** — the client exposes Access and the empty Project-index query. Project registration introduces the first successful Control Intent.
- **No frontend composition** — this package supplies the client service and schemas, not routes or rendered UI.
