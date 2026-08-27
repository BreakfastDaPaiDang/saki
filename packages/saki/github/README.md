# `@breakfastdapaidang/saki-github`

English | [中文](README.zh.md)

The private Saki GitHub Service Definition registers `ctx.sakiGitHub`. It owns provider-neutral external identities, raw platform facts, strict schemas, closed failures, rate observations, deterministic scan fingerprints, and the reusable Service Provider contract. Authentication and GitHub transport belong to Service Providers; Saki status mapping, durable checkpoints, polling, and Intent lifecycle belong to Consumers.

## Capability interface

`SakiGitHub.read(request, signal)` is keyed by the declaration-merge extensible `GitHubReadMap`. B05 defines reads for an App installation, Repository, Issue, Project v2, exact `refs/tags/saki-v*` reference, recursive annotated-tag peeling, Release by tag, exact Commit, and Commit comparison. A configured-upstream existence check is the exact Commit read; absence is the typed `not-found` failure.

`SakiGitHub.scan(request, signal)` is keyed by `GitHubScanMap`. Its `project-board` member accepts one installation profile, Project node id, Repository node/database-id pair, persisted Status field id, provider-neutral required Status option ids, caller-owned `interactive` or `background` priority, and a caller-resolved per-project `rateLimitReserve`. The Provider pages every field, option, item, nested value, and open-Issue connection internally. Cursors and partial results cannot cross the interface. A result is one validated `GitHubProjectBoardScanCandidate` with stable pre/post update fences, API order, raw item content, complete open Issues, rate observations, and a versioned fingerprint.

The required Status ids carry no Saki meanings such as Inbox or Ready. They let the Provider verify that the persisted field exists exactly once, is single-select, and contains every required external option exactly once without guessing by display name.

## Safe values and failures

GitHub App, installation, account, Repository, Project, field, option, item, Issue, pull request, tag-object, Release, Commit, and external-operation identities are branded. Database ids remain validated positive-decimal strings; a Provider converts an SDK number only after proving it is a safe integer. Raw facts retain platform ownership, visibility, Issue state, Project membership, Status option, archive state, API order, update observations, credential-free HTTPS URLs, safe request ids, and rate-limit timing. They exclude authorization headers, tokens, private keys, JWTs, raw errors, pagination cursors, and SDK objects.

Providers throw `GitHubProviderError`, whose `failure` is one closed arm: cancellation, unavailable authentication, permission mismatch, attributed Status mapping mismatch, not found, invalid external response, primary rate limit, secondary rate limit, transient transport, or permanent rejection. A mapping mismatch identifies the exact configured Status field or the nonempty set of missing required option ids; it carries no Saki Status meaning. Only safe request, retry, reset, resource, operation, permission, external-id, and HTTP-status observations are admitted. GraphQL field errors or partial data therefore become `invalid-external-response` unless response facts prove a typed rate-limit failure; no partial candidate exists.

Strict schemas reject unknown properties and cross-check scan ownership, unique field/item/Issue identities, per-Repository Issue-number identity, matching same-Issue facts across Project items and open Issues, contiguous API order, the selected Status field type, stable update fences, complete counts, open-Issue state, and the retained fingerprint. One installation observation admits at most 100,000 accessible Repository identities; one scan candidate admits at most 10,000 Project fields, 100,000 Project items, and 100,000 open Issues.

## Fingerprints and future mutation recovery

`computeGitHubProjectBoardFingerprint()` produces fingerprint version `1`. It covers external source ids, Issue state and revisions, Project membership and Status, archive state, API order and neighboring items, and update fences. Field enumeration is canonicalized, while Project-item and open-Issue API order remain authoritative. Provider observation time, rate timing, labels, URLs, and pagination mechanics do not change semantic identity.

`GitHubMutationMap` is deliberately empty and declaration-merge extensible. This package exports only `GitHubMutationIdentity` and the provider-neutral `pending | observed | absent | unknown | error` inspection vocabulary needed by a later mutation Service Definition. It defines no `dispatch` or `inspectMutation` method, no concrete mutation or receipt, and no runtime “unsupported” placeholder.

## Service Provider contract

`tests/contract.ts` exports `runGitHubProviderContract()`. A Provider supplies a fresh deterministic harness; the suite verifies public installation reads, complete detached scans, Status node-id enforcement, pre-cancellation, closed failure data, rate observations, and stable semantic fingerprints. Provider-specific tests still own HTTP pagination, GraphQL partial-data rejection, authentication, SDK conversion, and primary/secondary rate-limit parsing.

## Model Experience

### GitHub facts

#### What the model sees

Nothing. `ctx.sakiGitHub` provides detached Host-side facts to Saki Consumers and registers no tool, prompt section, or session event.

#### Token effect

Zero direct tokens on every operation.

#### KV Cache effect

Independent of model requests: this Service Definition does not assemble or change a request prefix.

## Known Limitations and Deferred Work

- **Read and scan only** — mutation requests, receipts, dispatch, post-crash inspection methods, and idempotency policy belong to the later mutation slice.
- **No product projection** — raw GitHub facts do not assign Saki Status, create Inbox entries, publish a GitHub Sync Checkpoint, or change durable control-plane state.
- **No transport implementation** — this package defines and tests the Service Definition; each Service Provider owns its HTTP/SDK mechanism, authentication lifetime, pagination, and response admission.
