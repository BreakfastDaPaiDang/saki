# `@breakfastdapaidang/saki-control-plane`

English | [中文](README.zh.md)

The private Saki control-plane module owns the local Installation foundation, Installation Access, and the first protected Projection. It registers `ctx.sakiControlPlane`; callers use the narrow `SakiAccess` and `SakiControlPlaneModule` interfaces rather than storage tables. The Host-only `./host` entry resolves transport credentials into a trusted in-process `SakiAuthenticationContext`, while the browser-safe `./fixtures` entry publishes redacted B01 states.

## Durable records

The `saki_control_plane` storage domain has two singleton records. `foundation` keeps independently branded Saki Installation, Saki Host, Installation State Generation, human Principal, and Host Operator Grant identities. `installation_access` is one versioned aggregate containing revisioned Bootstrap Challenge and Browser Session entries. Every successful bootstrap exchange uses one expected-revision record update to consume the matching challenge and insert exactly one session.

Only domain-separated bootstrap and cookie digests are durable. Raw bootstrap secrets, raw cookie credentials, derived request tokens, and independent request-forgery secrets are absent from storage. Terminal challenge and session entries remain monotonic and are removed only after `terminalRetentionMs`.

## Access and control operations

`SakiAccess` reads the closed Access Projection, exchanges the launcher secret, and logs out the current session. Bootstrap and logout can modify only Installation Access. The main module exposes stable Installation and Host identities, a protected empty Project-index query, an empty B01 Intent map with a stable unavailable receipt, and post-commit Projection invalidation.

Every protected operation resolves the active Browser Session again and checks the current Installation generation, Principal lifecycle, and Grant. Grant revocation blocks later queries without deleting the session; generation replacement or Principal retirement invalidates the bound session. A normal restart preserves an unexpired issued challenge and active session. The launcher therefore emits a clear bootstrap handoff only when it created a new challenge; an earlier unexpired handoff remains the credential for an interrupted bootstrap.

## Browser-session security

The bootstrap exchange requires the exact configured Origin. A successful commit permits one `HttpOnly; SameSite=Strict; Path=/saki` cookie header through an opaque, one-shot Host handoff; HTTPS origins also add `Secure`. Authentication hashes the presented raw cookie and compares its digest in constant time. It then derives the request token from that raw cookie with a versioned, domain-separated HMAC. Every later mutation requires the exact Origin and a constant-time request-token match.

| Config | Default | Purpose |
| --- | --- | --- |
| `origin` | required | Exact HTTP(S) browser origin, without a path |
| `challengeTtlMs` | 15 minutes | Bootstrap Challenge lifetime |
| `sessionTtlMs` | 12 hours | Browser Session lifetime |
| `terminalRetentionMs` | 7 days | Minimum retention before terminal-record cleanup |
| `cookieName` | `saki_session` | Host-only cookie extraction name |

## Model Experience

None, as the module owns local access and product Projections but registers no model-facing input.

#### KV Cache effect

None; the module neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **One local Host Operator only** — GitHub login, organization membership, multiple users, remote Hosts, and non-loopback deployment are outside B01.
- **No successful Control Intent** — `SakiIntentMap` is empty and submission returns `intent-unavailable`; project registration owns the first Intent.
- **No credential recovery UI** — an unexpired challenge survives a process restart, so the original launcher handoff remains necessary until it expires and a later start issues a replacement.
