# `@breakfastdapaidang/saki-control-plane`

English | [中文](README.zh.md)

The private Saki control-plane module owns local Installation provisioning, Installation Access, and the first protected Projection. It registers `ctx.sakiControlPlane`; callers use the narrow `SakiAccess` and `SakiControlPlaneModule` interfaces rather than storage tables. The Host-only `./host` entry resolves transport credentials into a trusted in-process `SakiAuthenticationContext`, while the browser-safe `./fixtures` entry publishes redacted B01 states.

## Durable records

The versioned `control_state` provisioning owner records only stable child references and a `provisioning` or `ready` phase. Independently revisioned `installations`, `hosts`, `principals`, and `grants` tables retain entity lifecycle and history under branded ids. Every entity id uses its kind-specific prefix plus canonical UUID text; Installation State Generation ids use `installation-generation-`, while the separate storage identity prefix `storage-generation-*` is rejected. Principal kind is the closed `human | automation` discriminant. B01 provisions one human Host Operator and validates that referenced kind on every startup; unrelated automation Principals are valid records, but B01 creates no automation Grant. The Installation selects its current Installation State Generation and Local Host without overwriting historical entities. First startup records all references once, creates or validates children in a fixed order, and marks the owner ready only after every child is durable; restart resumes any interrupted step.

`installation_access` is one versioned aggregate containing revisioned Bootstrap Challenge and Browser Session entries. Their ids append `:challenge:<ordinal>` or `:session:<ordinal>` to the owning Access id with a canonical decimal ordinal. Monotonic challenge and session ordinals produce deterministic entry ids; each verifier digest is bound to its entry id. Every successful exchange uses one expected-revision update to consume the selected challenge, revoke other issued challenges, and insert exactly one session. The aggregate retains an immutable initial-bootstrap completion summary even after detailed terminal entries are removed, and cleanup never lowers either ordinal high-water mark.

Only domain-separated bootstrap and cookie digests are durable. Raw bootstrap secrets, raw cookie credentials, derived request tokens, and independent request-forgery secrets are absent from storage. Terminal challenge and session entries remain monotonic and are removed only after `terminalRetentionMs`.

## Access and control operations

`SakiAccess` reads the closed Access Projection, exchanges the launcher secret, and logs out the current session. Bootstrap and logout can modify only Installation Access. The main module exposes stable Installation and Host identities, a protected empty Project-index query, an empty B01 Intent map with a stable unavailable receipt, and post-commit Projection invalidation. One failing invalidation listener emits only a fixed credential-free diagnostic and does not prevent later listeners from running; each registration remains disposable.

Every protected operation resolves the active Browser Session again and checks the current Installation generation, Principal lifecycle, and current Grant revision and scope. Grant revocation blocks later queries without deleting the session; generation replacement or Principal retirement invalidates the bound session.

Every privileged launcher startup issues a fresh challenge. Its purpose is `initial-bootstrap` until the first exchange completes and `local-reauthentication` thereafter. Older unexpired issued challenges remain usable until one exchange atomically consumes its selected challenge and revokes the rest. Initial completion never reopens; after cookie expiry, logout, or a lost `Set-Cookie` response, the operator signs in with a fresh challenge from a later launcher startup. Existing valid sessions remain active when local reauthentication creates another session, and logout revokes only the presented session.

## Browser-session security

The bootstrap exchange requires the exact configured loopback Origin. Configuration accepts only a canonical HTTP(S) origin whose hostname passes Connection's shared loopback classifier. A successful commit permits one `HttpOnly; SameSite=Strict; Path=/saki` cookie header through an opaque, one-shot Host handoff; HTTPS origins also add `Secure`. Authentication hashes the presented raw cookie and compares its digest in constant time. It then derives the request token from that raw cookie with a versioned, domain-separated HMAC. Every later mutation requires the exact Origin and a constant-time request-token match.

| Config | Default | Purpose |
| --- | --- | --- |
| `origin` | required | Exact loopback HTTP(S) browser origin, without a path |
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
- **Launcher recovery only** — B01 restores local access through a newly started privileged launcher; it does not provide a browser-only credential recovery flow.
