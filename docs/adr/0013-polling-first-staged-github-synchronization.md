---
status: accepted
---

# Use polling-first staged snapshots for GitHub synchronization

English | [中文](0013-polling-first-staged-github-synchronization.zh.md)

Version 0.1.0 synchronizes each configured GitHub Project and Repository through complete staged scans. Polling is the baseline delivery mechanism; a webhook may later request an earlier scan but never applies a Project change directly. Saki publishes a new Board projection only after every required page and mapping check succeeds, and it retains the last confirmed projection when a scan is incomplete.

## Why this decision

GitHub owns shared Work Item Status and manual order, so Saki cannot recover by treating its optimistic client state as authoritative. GraphQL cursors identify positions within one paginated traversal; they are not durable change-stream offsets and do not prove that records outside the traversed pages stayed unchanged. Webhook delivery also cannot supply that proof: GitHub does not automatically redeliver every failed webhook, and Projects v2 webhook coverage remains an unsuitable release dependency for the first local product.

A full scan is affordable for the single-operator release and gives one testable publication rule. It also leaves a direct upgrade path: webhooks can reduce latency by waking the same scanner, and later incremental reads can remain an optimization as long as periodic complete scans continue to repair missed observations.

GitHub mutations do not expose a general compare-and-set revision. Saki can detect most stale local actions with a targeted read before mutation and can confirm the resulting state afterward, but another actor may still change the same item between those calls. The design therefore promises visible conflict detection and convergence to confirmed GitHub state, not serializable transactions across Saki and GitHub.

## Synchronization protocol

### Checkpoint and publication

Each binding stores a GitHub Sync Checkpoint containing the Installation, GitHub Project, Repository, mapping revision, local scan generation, last successful complete-scan time, confirmed remote fingerprints, and rate-limit evidence from that successful scan. The current synchronization failure and retry schedule sit beside the checkpoint so a failed attempt cannot rewrite confirmed evidence. Page cursors exist only inside one in-progress scan and are discarded on completion or failure.

A Board scan validates the persisted node-id mapping, reads every configured Project item page in API order with its Status value, reads open Issues from the associated Repository for Inbox membership, and constructs a candidate snapshot. GitHub does not document the Project-level `updatedAt` value as a revision for every item or field-value change, so the Product App performs two consecutive complete passes and accepts the candidate only when their versioned semantic fingerprints match; each pass also requires stable pre/post object revisions and counts. The control plane atomically publishes the candidate and advances the checkpoint only after all pages and invariants succeed. Version 0.1.0 persists and delivers at most 10,000 Work Items in one complete Board; a larger stable candidate records a typed capacity failure with its fixed limit and observed count rather than publishing a truncated Board. A partial response, stability mismatch, capacity failure, mapping failure, permission failure, cancellation, or rate limit leaves the confirmed snapshot, scan generation and time, remote fingerprints, and checkpoint unchanged; it records separate current failure and retry evidence without advancing the confirmed scan.

A field-scoped synchronization configuration Intent uses the current synchronization revision and saves a changed configuration as pending. A patch that resolves to the current pending or active configuration returns `configuration-unchanged` without allocating a new revision. Saved and activating configurations remain non-authoritative and keep affected mutations unavailable until a complete scan validates the mapping and atomically activates the configuration with its first confirmed checkpoint.

The active Board polls by default every 30 seconds and background Projects every five minutes. Startup, manual refresh, a local mutation, reconnect, and a future webhook request an immediate scan. Both intervals and the background rate-limit reserve are validated per-Project synchronization configuration, not fixed protocol constants.

### Targeted delivery observations

The Board checkpoint remains independent from PR, CI, Milestone, tag, Release, Commit, and ancestry observations. Those facts use targeted reads with configurable polling only while an affected View is active or a related Intent, Run, delivery, or reconciliation remains pending. Each Projection carries its own last-confirmed observation, failure, staleness, and invalidation state; a failed refresh preserves prior confirmed facts and cannot advance the Board checkpoint.

Tag observation starts from `refs/tags/saki-v*` and recursively peels annotated tags until a Commit is reached. GitHub Release `target_commitish` is neither tag identity nor release-commit evidence. The Product App therefore needs Repository Contents read, but no Contents write or Workflows write.

GitHub owns Milestone scope, title, due date, and open or closed state. One versioned Saki Milestone Delivery record owns Planned, In Progress, Ready to Release, or Canceled metadata plus optional immutable Release Evidence. Phase updates and finalization use expected revision. Finalization verifies that the exact official Upstream Baseline exists in the configured upstream repository and is an ancestor of the peeled Release Commit, then atomically embeds the tag, Release, Commit, baseline, prior metadata revision, PR, CI, Actor, and Intent mapping in that record. Released derives only from matching embedded evidence. External closure or a concurrent GitHub change that lacks a classified result enters repair, conflict, or reconciliation without publishing a partial phase or evidence mapping.

### Optimistic mutations

Every Board mutation carries the last confirmed remote fingerprint for the affected Issue and Project item. The fingerprint covers Project membership, Status option, Issue open state, and the ordering neighbors relevant to the requested move.

Before mutation, the GitHub adapter performs a targeted read. If the confirmed remote state already equals the desired state, the Intent succeeds idempotently. If it equals the expected fingerprint, Saki submits the mutation and reads the target again before committing the new observation. Any other state is a conflict: Saki does not overwrite it, replaces the optimistic display with the latest confirmed GitHub state, and offers retry as a new Intent. A missing or timed-out mutation response triggers inspection before retry; silence never proves failure.

The confirmation read can observe a later concurrent change and therefore remains authoritative even when it differs from the requested target. Saki records the requested mutation and confirmed result so the discrepancy is explainable.

### Mapping repair and rate limits

Persisted Project, field, option, item, Repository, and Issue node ids are authoritative mapping references. Name matching may suggest a replacement but never repairs a missing or recreated field automatically. An invalid mapping makes affected Board mutations unavailable until an attributed repair Intent selects or creates the replacement mapping and a complete scan succeeds.

One serialized API queue serves each GitHub App installation token. Targeted mutation reads, mutations, confirmation reads, login, and manual refresh outrank background scans. Background work pauses before a configurable reserve is exhausted. The adapter observes GraphQL cost and reset facts, REST rate-limit headers, `Retry-After`, and secondary-limit responses; REST reads use conditional requests where supported. Backoff is bounded and persisted when it affects recovery rather than implemented as an unobservable process sleep.

## Considered options

**Require webhooks for version 0.1.0.** Webhooks improve latency but add public ingress, secret rotation, delivery recovery, and incomplete-delivery handling to a local release. They cannot replace reconciliation scans, so they become an optional wake-up source later.

**Persist GraphQL page cursors as synchronization offsets.** A page cursor resumes pagination within a result connection but does not identify all changes since an earlier scan. Treating it as a change cursor could publish a mixture of old and new pages and miss removals.

**Apply each fetched page directly to the Board.** A later page, permission error, or mapping change would expose a partial remote world as confirmed state. Staging costs temporary memory but preserves one atomic projection revision.

**Let last writer win without a targeted read.** This would silently overwrite changes made in GitHub while the local client was stale and violate GitHub's authority. The read-confirm-read protocol makes conflicts visible even though it cannot create a cross-system transaction.

**Repair mappings by option name.** A renamed or recreated field can reuse a human-readable name while having different identity or meaning. Suggestions are useful, but an attributed repair decision must select the new node ids.

**Use Release `target_commitish` or store release evidence separately.** `target_commitish` may name a branch and does not prove the tag target. A separate evidence record would add an avoidable cross-record commit and recovery state, so immutable evidence is embedded by expected-revision update in Milestone Delivery after exact tag peeling and ancestry validation.

## Consequences

Board freshness is bounded by configured polling intervals rather than real-time delivery. The UI always distinguishes the last confirmed snapshot, an optimistic overlay, scan age, and the current synchronization failure. Automatic mode cannot claim or complete work from a Project whose required mapping is invalid or whose confirmed state is too stale for its policy.

The GitHub Service Definition exposes complete scans, targeted reads, mutations, confirmation, and rate-limit facts; the Saki control plane owns Board mapping, staged publication, Milestone Delivery, release finalization, conflict rules, and checkpoint persistence. Tests cover multi-page scans, stability mismatches between complete passes, removal, incomplete pages, mapping recreation, remote edits during an optimistic move, lost mutation replies, secondary limits, process restart, webhook wake-up without direct state application, annotated-tag peeling, upstream ancestry, external Milestone closure, and atomic Release Evidence embedding.

The external protocol references are GitHub's [GraphQL pagination](https://docs.github.com/en/graphql/guides/using-pagination-in-the-graphql-api), [GraphQL rate limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api), [REST API best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api), and [failed webhook delivery behavior](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries).
