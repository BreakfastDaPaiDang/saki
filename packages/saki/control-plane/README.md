# `@breakfastdapaidang/saki-control-plane`

English | [中文](README.zh.md)

The private Saki control-plane module owns local Installation provisioning, Installation Access, the Development Project Registry, and recoverable Project-registration Intents. It registers `ctx.sakiControlPlane`; callers use the narrow `SakiAccess` and `SakiControlPlaneModule` interfaces rather than storage tables. The Host-only `./host` entry resolves transport credentials into a trusted in-process `SakiAuthenticationContext`, while the browser-safe `./fixtures` entry publishes redacted access, inspection, registration, Project-index, and Development-Workspace states.

## Durable records

The versioned `control_state` provisioning owner records only stable child references and a `provisioning` or `ready` phase. Independently revisioned `installations`, `hosts`, `principals`, and `grants` tables retain entity lifecycle and history under branded ids. Every entity id uses its kind-specific prefix plus canonical UUID text; Installation State Generation ids use `installation-generation-`, while the separate storage identity prefix `storage-generation-*` is rejected. Principal kind is the closed `human | automation` discriminant. Provisioning creates one human Host Operator and validates that referenced kind on every startup; unrelated automation Principals are valid records, but provisioning creates no automation Grant. The Installation selects its current Installation State Generation and Local Host without overwriting historical entities. Startup first validates every retained provisioning, access, Project, Binding, and Intent record without writes or external effects; only a wholly valid inventory may be reconciled or resumed.

`installation_access` is one versioned aggregate containing revisioned Bootstrap Challenge and Browser Session entries. Their ids append `:challenge:<ordinal>` or `:session:<ordinal>` to the owning Access id with a canonical decimal ordinal. Monotonic challenge and session ordinals produce deterministic entry ids; each verifier digest is bound to its entry id. Every successful exchange uses one expected-revision update to consume the selected challenge, revoke other issued challenges, and insert exactly one session. The aggregate retains an immutable initial-bootstrap completion summary even after detailed terminal entries are removed, and cleanup never lowers either ordinal high-water mark.

`development_project_registry` is one revisioned aggregate containing Projects, Resource Bindings, owning-Host-scoped canonical worktree and per-worktree Git-directory indexes, and committed Intent mappings. `registration_intents` retains the immutable browser confirmation, accepted Actor attribution, complete registration inspection, phase-specific Workspace evidence, and deterministic receipt identity. Registration serializes by Intent id, persists `prepared` before dispatch, records a possible Workspace effect before the Registry compare-and-set, and recognizes a mapping that committed before its Intent phase advanced. A replay with the same payload converges on the same receipt; changed payload or duplicate path identity on the same Host conflicts without reusing that receipt. Equal canonical path text on different Hosts does not identify the same resource.

Each accepted inspection carries browser-safe Git facts plus an inherited-change baseline whose plaintext paths and file contents are replaced by exact digests and bounded metadata. Capture time and elapsed duration remain evidence but do not destabilize baseline identity. Before every Workspace list, create, or recovery action, the control plane passes the retained canonical worktree path as an untrusted locator to a fresh Host inspection and compares the required Git, canonical-path, Git administrative-directory object, and Workspace evidence. Replacing a clone or Git administration at the same path therefore moves the Binding to `repair-required`; a retained Projection or trusted path observation never authorizes a later effect by itself.

Only domain-separated bootstrap and cookie digests are durable. Raw bootstrap secrets, raw cookie credentials, derived request tokens, and independent request-forgery secrets are absent from storage. Terminal challenge and session entries remain monotonic and are removed only after `terminalRetentionMs`.

## Access and control operations

`SakiAccess` reads the closed Access Projection, exchanges the launcher secret, and logs out the current session. Bootstrap and logout can modify only Installation Access. The main module exposes stable Installation and Host identities; read-only project-selection inspection, Project-index, and Development-Workspace queries; the durable `register-development-project` Intent; and post-commit Projection invalidation. Intent-only phase writes do not invalidate Project views; a committed Registry update invalidates the index and detail views once. One failing invalidation listener emits only a fixed credential-free diagnostic and does not prevent later listeners from running; each registration remains disposable.

Every protected operation resolves the active Browser Session again and checks the current Installation generation, Principal lifecycle, and current Grant action and scope. A retained registration Actor must reference the owning Installation's known initial or current generation. Actor revisions retained with an accepted Intent are immutable attribution rather than an authorization snapshot: benign Principal or Grant revision changes do not block recovery, while retirement, generation replacement, scope narrowing, or revocation blocks any not-yet-started effect. Once Workspace dispatch may have completed, recovery may adopt its exact durable Workspace identity without starting another effect.

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

- **One local Host Operator only** — GitHub login, organization membership, multiple users, remote Hosts, and non-loopback deployment are not implemented.
- **Registration only** — Resource Binding rebind, retirement, Execution Leases, successor Sessions, automatic repository mutation, and manual takeover are not implemented. An expected-revision CAS loser leaves any created or adopted DSH Workspace available for reuse without a Saki Project or Resource Binding; the control plane does not delete a Workspace that the registration may not exclusively own.
- **Launcher recovery only** — Local access recovery requires a newly started privileged launcher; there is no browser-only credential recovery flow.
