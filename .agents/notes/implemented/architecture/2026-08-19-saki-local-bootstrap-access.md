# Agent Note: Saki local bootstrap access over Connection

Status: implemented

English | [中文](2026-08-19-saki-local-bootstrap-access.zh.md)

## Problem

Saki needs a first authenticated Host Operator before Development Projects or GitHub identity exist. That access must survive a normal process restart, enforce current Principal and Grant authority, and leave no raw reusable authenticator in durable records. The browser also needs strict typed operations without turning Typert Remote into an authentication framework or placing a second HTTP carrier beside Connection.

## Decision

**Keep local access inside one deep control-plane module.** `@breakfastdapaidang/saki-control-plane` owns the Saki Installation, independently identified Saki Host, Installation State Generation, human Principal, Host Operator Grant, and Installation Access. Its public `SakiAccess` interface owns bootstrap and logout; its `SakiControlPlaneModule` interface owns protected Projection queries, Control Intent submission, and invalidation. Storage tables and the authentication resolver remain outside browser entrypoints.

**Use one versioned Installation Access aggregate for security lifecycle updates.** Distinct branded, revisioned Bootstrap Challenge and Browser Session entries live inside one singleton record. One expected-revision storage-domain update validates an `issued` challenge, records terminal `consumed`, and inserts exactly one `active` session before `Set-Cookie` becomes available. Concurrent exchange and replay return the same generic unavailable result. A lost response leaves the commit intact. Server-clock expiry, logout, Principal retirement, and Installation generation replacement produce monotonic terminal states; cleanup only deletes terminal entries after the configured retention interval. A normal restart preserves still-valid issued challenges and active sessions.

**Authenticate a Principal, then re-evaluate authority.** A Browser Session binds a Principal and Installation generation but carries no Grant. Every protected query and submission resolves the current session again, checks the current Principal lifecycle, and reads the current Grant state and scope. Grant revocation immediately denies later protected work without deleting the session. B01 publishes only the empty Project-index Projection; its merge-extensible `SakiIntentMap` has no members, and `control/submit` always returns a stable unavailable receipt after authentication. Project registration owns the first successful Intent.

**Carry authentication through one Saki-owned Connection channel.** `@breakfastdapaidang/saki-host-api` registers `/saki` and owns strict schemas for `access/read`, `access/exchange`, `access/logout`, `control/query`, and `control/submit`. It reads Cookie, Origin, and the request-token header from trusted Connection metadata, uses the Host-only authentication resolver, and emits the opaque post-commit cookie header outside JSON. The browser face uses same-origin credentials. Connection gained generic request metadata, response headers, and client call options; Typert only adapts mechanically to that generic reply type and owns no Saki authentication rule.

**Limit each clear authenticator to one named carrier.** The bootstrap secret exists only in the launcher handoff and exact exchange body. The raw session credential exists only in `Set-Cookie`, Cookie, and the browser's HttpOnly jar. Authenticated Access contains a request token derived from that raw cookie by a versioned, domain-separated HMAC; mutations require the exact configured Origin and a constant-time token comparison. Durable Installation Access contains only domain-separated bootstrap and cookie digests plus non-secret derivation metadata. Business results, Projections, errors, fixtures, events, and snapshots contain no raw secret or cookie credential.

## Consequences

`pnpm run saki` starts a long-lived loopback Host with SQLite persistence and emits a one-shot launcher handoff only when a fresh Bootstrap Challenge is created. If the process stops before exchange, the original unexpired handoff remains valid after restart; Saki does not revoke the durable challenge merely to print a replacement. Once bootstrap commits, the HttpOnly cookie authenticates the same Principal after restart without persisting either the cookie or request token.

The API deliberately serves one local Host Operator. GitHub OAuth, multiple users, remote Saki Hosts, non-loopback deployment, session recovery UI, and successful product mutation remain separate decisions. Source and built-bundle snapshots drive the real `/saki` HTTP transport, exchange the bootstrap secret without recording it, restart against the same SQLite database, and query the empty Project index with the original cookie.

## Alternatives considered

- **Put authentication into Typert Remote** — couples one product's cookie and Grant semantics to the generic generated RPC registry and still needs an HTTP metadata escape hatch.
- **Add a raw Saki HTTP route beside Connection** — duplicates route trust, JSON limits, correlation, cancellation, and disposal while creating two competing Host carriers.
- **Persist a browser bearer, local password verifier, or independent request-forgery secret** — adds reusable secret storage and recovery lifecycle even though the presented high-entropy cookie can authenticate the session and derive its request token.
- **Store challenges and sessions as independent records** — cannot express consume-and-create with the storage domain's one-record compare-and-set guarantee.
- **Cache Grant authority in the Browser Session** — lets an old session retain permissions after Grant revocation or narrowing.
- **Invent a no-op B01 Control Intent** — makes a successful mutation protocol look settled before any real product action exists.
