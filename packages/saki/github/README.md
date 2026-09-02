# `@breakfastdapaidang/saki-github`

English | [中文](README.zh.md)

The private Saki GitHub Service Definition registers `ctx.sakiGitHub`. It owns provider-neutral external identities, raw platform facts, strict schemas, closed failures, scan rate observations, deterministic scan fingerprints, and the reusable Service Provider contract. Authentication and GitHub transport belong to Service Providers; Saki status mapping, durable checkpoints, polling, and Intent lifecycle belong to Consumers.

## Capability interface

`SakiGitHub.read(request, signal)` is keyed by the declaration-merge extensible `GitHubReadMap`. It defines reads for an App installation, Repository, Issue revision, complete bounded Issue detail, branch safety, Project v2, exact `refs/tags/saki-v*` reference, recursive annotated-tag peeling, Release by tag, exact Commit, and Commit comparison. Branch safety distinguishes an existing safe or protected branch from a missing branch covered by active rules; a missing branch with no active rules is `legacy-protection-unknown` because the fact cannot exclude legacy protection. A configured-upstream existence check is the exact Commit read; absence is the typed `not-found` failure.

`SakiGitHub.scan(request, signal)` is keyed by `GitHubScanMap`. Its `project-board` member accepts one installation profile, Project node id, Repository node/database-id pair, persisted Status field id, provider-neutral required Status option ids, caller-owned `interactive` or `background` priority, and a caller-resolved per-project `rateLimitReserve`. The Provider pages every field, option, item, nested value, and open-Issue connection internally. Cursors and partial results cannot cross the interface. A result is one validated `GitHubProjectBoardScanCandidate` with stable pre/post update fences, API order, raw item content, complete open Issues, rate observations, and a versioned fingerprint.

The required Status ids carry no Saki meanings such as Inbox or Ready. They let the Provider verify that the persisted field exists exactly once, is single-select, and contains every required external option exactly once without guessing by display name.

`SakiGitHub.dispatch(request, signal)` and `inspectMutation(request, signal)` are keyed by `GitHubMutationMap`. Its concrete members create a marker-bound Issue, add an Issue to a Project, set one Project item Status or API position, and set one Issue to open or closed. Every request carries a caller-persisted `operationId`; mutation dispatch and inspection are always interactive, so only scan requests carry a queue priority. One dispatch invocation makes one external call without an internal retry; Issue creation returns only the Issue id and number needed by later inspection, while the other dispatch results are void. Inspection returns only a targeted snapshot and its observation time so the Consumer can resolve acknowledged, lost-acknowledgement, or conflicting outcomes.

## Safe values and failures

GitHub App, installation, account, Repository, Project, field, option, item, Issue, Issue-create marker, pull request, tag-object, Release, Commit, and external-operation identities are branded. Database ids remain validated positive-decimal strings; a Provider converts an SDK number only after proving it is a safe integer. Raw facts retain platform ownership, visibility, Issue state, Project membership, Status option, archive state, API order, update observations, credential-free HTTPS URLs, safe request ids, and rate-limit timing. They exclude authorization headers, tokens, private keys, JWTs, raw errors, pagination cursors, and SDK objects.

Providers throw `GitHubProviderError`, whose `failure` is one closed arm: cancellation, unavailable authentication, permission mismatch, attributed Status mapping mismatch, not found, invalid external response, primary rate limit, secondary rate limit, transient transport, or permanent rejection. A mapping mismatch identifies the exact configured Status field or the nonempty set of missing required option ids; it carries no Saki Status meaning. Only safe request, retry, reset, resource, operation, permission, external-id, and HTTP-status observations are admitted. GraphQL field errors or partial data therefore become `invalid-external-response` unless response facts prove a typed rate-limit failure; no partial candidate exists.

Strict schemas reject unknown properties and cross-check scan ownership, unique field/item/Issue identities, per-Repository Issue-number identity, matching same-Issue facts across Project items and open Issues, contiguous API order, the selected Status field type, stable update fences, complete counts, open-Issue state, and the retained fingerprint. An Issue-detail read admits the complete Markdown body or rejects it; the body may be empty and is limited to 256 KiB after UTF-8 encoding. Issue-create requests require a well-formed single-line title of at most 1,024 UTF-8 bytes and a well-formed LF-normalized body of at most 60,000 UTF-8 bytes ending in exactly one persisted `<!-- saki-work-item:<markerId> -->` line. One installation observation admits at most 100,000 accessible Repository identities; one scan candidate admits at most 10,000 Project fields, 100,000 Project items, and 100,000 open Issues.

## Scan fingerprints and mutation recovery

`computeGitHubProjectBoardFingerprint()` produces fingerprint version `1`. It covers external source ids, Issue state and revisions, Project membership and Status, archive state, API order and neighboring items, and update fences. Field enumeration is canonicalized, while Project-item and open-Issue API order remain authoritative. Provider observation time, rate timing, labels, URLs, and pagination mechanics do not change semantic identity.

Targeted inspections retain only the facts needed by the corresponding mutation. Project membership inspection distinguishes absent, unique, and duplicate memberships and exposes only membership identity and archive state. Status and position inspections retain the exact Issue, Status, API order, and relevant neighbors; position also retains the requested predecessor observation, including an absent anchor, without echoing the request target. Issue-state inspection retains the exact open or closed Issue fact. Targeted observations never claim or advance a complete Board scan checkpoint.

Issue-create inspection uses the persisted exact hidden marker and classifies a unique actual Issue, complete absence, a pull-request match, a removed marker on a known Issue, a missing known Issue, identity conflict, multiple occurrences, or bounded/inconsistent traversal. A unique result carries the Issue fact; every non-success result carries only its classification state. Its optional known-Issue hint is inspection-only and does not alter the persisted `operationId`. A complete absence is evidence, not provider permission to create again; the Consumer owns the `effectPossible` decision.

## Service Provider contract

`tests/contract.ts` exports `runGitHubProviderContract()`. A Provider supplies a fresh deterministic harness; the suite verifies public installation reads, complete detached scans, per-invocation mutation results, targeted mutation inspections, Status node-id enforcement, pre-cancellation, closed failure data, scan rate observations, and stable semantic fingerprints. Provider-specific tests still own HTTP pagination, GraphQL partial-data rejection, authentication, SDK conversion, mutation response admission, and primary/secondary rate-limit parsing.

## Model Experience

### GitHub facts

#### What the model sees

Nothing. `ctx.sakiGitHub` provides detached Host-side facts to Saki Consumers and registers no tool, prompt section, or session event.

#### Token effect

Zero direct tokens on every operation.

#### KV Cache effect

Independent of model requests: this Service Definition does not assemble or change a request prefix.

## Known Limitations and Deferred Work

- **No product saga** — GitHub facts and mutation results do not choose mutation order, retry an unknown outcome, assign Saki Status, publish a GitHub Sync Checkpoint, or change durable control-plane state.
- **No pull-request creation** — the mutation map creates Issues only; pull requests and every Contents or Workflows write remain outside this capability.
- **No transport implementation** — this package defines and tests the Service Definition; each Service Provider owns its HTTP/SDK mechanism, authentication lifetime, pagination, and response admission.
