# `@breakfastdapaidang/saki-github-app`

English | [中文](README.zh.md)

This private Saki package provides `ctx.sakiGitHub` through the Saki Product GitHub App. It authenticates with operation-scoped installation tokens and admits external responses into the provider-neutral facts, mutation results, and inspections defined by [`saki-github`](../github/README.md). Product Status meaning, durable GitHub Sync Checkpoints, mutation sagas, and Board projection remain Consumer responsibilities.

## Product App identity and permissions

`product-app-manifest.json` is the source manifest for the Product App permission ceiling. The installed App uses Organization Projects and Issues write access for Work Item creation and movement; pull-request write access remains reserved for the later PR slice. It has read access to Actions, Checks, Contents, Metadata, and commit statuses. Contents write, Workflows write, OAuth user authorization, and webhook delivery are absent.

Every operation resolves its configured private-key `CredentialRef` again and requires the exact `local-user-trust` Credential Protection Level. The key is used to sign App authentication only within that operation. Repository-bound operations request a short-lived installation token bound to the configured Repository database id, require selected-Repository mode and exactly that Repository id, and request only the permissions named by that operation. Reads and inspections use read grants; Project mutations use Organization Projects write plus Metadata read; Issue creation and state changes use Issues write plus Metadata read, while their inspections use Issues read plus Metadata read. Tokens, private keys, JWTs, authorization headers, SDK errors, response bodies, and pagination cursors never enter provider results or diagnostics.

The provider rejects a changed installation account, suspension, missing or excessive App grants, an overprivileged token response, an inaccessible configured Repository, an unsafe numeric id, a malformed response, or an expired token. A null exact GraphQL node produces the typed `not-found` failure instead of being treated as malformed. No operation requests Contents write or Workflows write.

## Reads and complete scans

The provider implements installation, Repository, Issue revision, complete Issue detail, branch safety, Project v2, exact `refs/tags/saki-v*`, recursive annotated-tag peel, Release-by-tag, Commit, and Commit-comparison reads. An existing branch uses GitHub's `protected` fact, which includes applicable branch protection and rulesets. A missing branch is checked through GitHub's effective-rules endpoint; active rules classify it as protected, while no active rule returns `legacy-protection-unknown` because the read-only token cannot exclude legacy protection. This path requests no Administration permission. Tag peeling is cycle-checked and depth-bounded. Release `target_commitish` is retained for display and is never treated as Commit evidence.

A `project-board` scan runs two complete passes over the Project fields, archived and non-archived Project items in ascending API position, nested item field values, and open Repository Issues. Each pass has its own before/after Project and Repository fence, mapping validation, pagination, and count checks. Each page is strictly parsed and must repeat the exact requested Project, Repository node/database-id pair, or Project item parent; ids and cursors must not repeat; configured Status ids must still identify one single-select field and every required option; and configured item, field-value, page, and response-byte limits fail closed instead of truncating. The provider returns the second candidate only when both passes have the same semantic fingerprint; a count-preserving Status change or any other semantic difference rejects the operation without a partial candidate.

Installation-token REST rate headers from Repository-access inspection and GraphQL rate facts travel with a successful scan. The App-JWT installation-identity read is not charged to that token budget and may omit primary-rate headers. After each successful GraphQL request, a background scan stops when reported remaining points reach or fall below the request's Consumer-resolved per-project `rateLimitReserve`; it does not sleep or retry internally. One queue serializes HTTP requests per installation and gives queued interactive calls priority over background pages. `maxConcurrentScans` separately bounds complete scans across installations. Disposal cancels queued and active work and waits for owned operations to settle.

## Atomic mutations and targeted inspection

Each provider dispatch invocation makes one Issue-creation, Project-membership, Status, API-position, or Issue-open-state mutation call without an internal retry. Each request carries a caller-persisted `operationId`, which GitHub receives as `clientMutationId`; dispatch and targeted inspection enter the installation queue as interactive work. Issue creation sends the complete validated title and deterministic marker-bearing body through GraphQL `createIssue` and returns only the created Issue id and number; its optional known-Issue hint is never sent. The other four dispatch operations validate GitHub's acknowledgement and return void. A transport failure or missing acknowledgement is returned to the Consumer, which must inspect before deciding whether another call is safe.

Each mutation has a read-only inspection path that returns only `{ snapshot, observedAt }`. Issue-create inspection first proves the Repository node, database, and owner identities, then traverses `GET /repos/{owner}/{repo}/issues` with `state=all`, fixed created-order pagination, raw Markdown media, and authoritative `Link rel="next"` termination. It scans every admitted page before classifying exact marker occurrences, distinguishes REST pull-request entries through the `pull_request` field, and classifies page/item bounds, malformed pagination, or duplicate entries as incomplete. Membership inspection traverses the complete Project item connection and reports absent, unique, or duplicate Issue membership. Status and position inspections retain the exact Issue, membership, field option, archive state, API order, and relevant neighbors while rejecting inconsistent target revisions. Issue-state inspection reads the exact Repository and Issue and admits only a repository-bound open or closed fact. These targeted inspections do not produce a Board scan candidate or advance a GitHub Sync Checkpoint.

## Configuration

| Field | Default | Accepted range | Effect |
| --- | ---: | ---: | --- |
| `pageSize` | 50 | 1–100 | Items requested from one GitHub connection page. |
| `maxPages` | 1,000 | 1–10,000 | Pages traversed for one connection. |
| `maxItems` | 20,000 | 1–100,000 | Project items, open scan Issues, or REST Issue-create inspection entries admitted per collection; it does not limit installation Repositories or Project fields. |
| `maxFieldValues` | 100,000 | 1–1,000,000 | Item field values admitted across one complete scan. |
| `maxResponseBytes` | 16 MiB | 1–`Number.MAX_SAFE_INTEGER` bytes | Bytes admitted from one HTTP response. |
| `requestTimeoutMs` | 30,000 | 1–2,147,483,647 ms | Wall-clock time admitted for one GitHub request. |
| `tagPeelDepth` | 32 | 1–100 | Annotated-tag objects admitted by one recursive peel. |
| `maxConcurrentScans` | 2 | 1–1,000 | Complete Project scans active across installations. |

Installation observations admit at most 100,000 accessible Repository identities, and complete scan candidates admit at most 10,000 Project fields. These Service-level limits match the provider-neutral fact schemas and are not controlled by `maxItems`.

All listed fields are validated Cordis plugin config. Their defaults are deployment choices owned here. The per-project `rateLimitReserve` instead belongs to the Consumer and is required explicitly on every scan request; neither layer applies a hidden fallback inside `scan()`.

## Failures

Failures use the closed `GitHubProviderError` data from `saki-github`: cancellation, unavailable authentication, permission mismatch, attributed Status mapping mismatch, absence, invalid external response, primary or secondary rate limit, transient transport, or permanent rejection. Only sanitized operation, resource, permission, external id, HTTP status, request id, retry delay, and reset time may cross the Service Provider interface. The provider never performs an unreported retry or publishes a partial result.

## Model Experience

### Product App facts

#### What the model sees

Nothing. The Host-side `ctx.sakiGitHub` Service Provider registers no tool, prompt section, session event, or model request content.

#### Token effect

Zero direct tokens on every operation.

#### KV Cache effect

Independent of model requests: Product App authentication and GitHub response admission do not assemble or change a request prefix.

## Known Limitations and Deferred Work

- **No pull-request creation** — marker-bearing Issue creation is supported, but pull-request creation and every Contents or Workflows write remain absent.
- **Polling is Consumer-owned** — this Service Provider schedules pages and complete-scan concurrency but does not choose when a Project refreshes or persist a GitHub Sync Checkpoint.
- **No webhook endpoint** — version 0.1.0 uses polling; a later webhook may wake the same complete scanner but cannot apply Board state directly.
- **Operator smoke requires an installation** — keyless tests exercise the real Octokit authentication and transport boundary with controlled responses. A live read requires the Product App to be installed and its private key configured through a local-user-trust credential provider.
