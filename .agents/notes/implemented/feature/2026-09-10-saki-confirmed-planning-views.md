# Agent Note: Saki confirmed planning views

Status: implemented

English | [中文](2026-09-10-saki-confirmed-planning-views.zh.md)

## Problem

Project planning combines a complete GitHub Board with independently refreshed Issue bodies, execution records, and Release evidence. A browser that joins raw provider facts or replaces a complete Board during a failed scan can present an unconfirmed planning state. A move submitted again after response loss can also lose the exact remote revision the user saw.

## Decision

The [Web client](../../../../packages/saki/web-ui/README.md) has one planning controller outside React. It owns authenticated query caches, cancellable invalidation polling, and exact pending Intents; components receive plain snapshots and gesture callbacks. Complete Board results remain the baseline, server-confirmed targeted overlays carry newer exact Work Item facts, and optimistic placement changes only presentation. A drag captures the card's fingerprint at drag start; the keyboard dialog captures it at opening. Both submit the same MoveWorkItem operation and retain a selected predecessor's presented fingerprint. Status and position frontiers derive the expected Issue state from the captured source and confirmed Issue-state prefix, allowing explicit classification and ordering of already-closed Issues without reopening them. A predecessor's fingerprint protects its captured state before a new position effect.

Unacknowledged Intents are persisted before submission under their Principal and Project. Reload and Project switching retain their exact payloads; explicit recovery uses the current request token with the original Intent. A terminal confirmation or conflict clears that pending payload. Principal changes cancel protected reads and clear business caches. A transport failure retains confirmations and stops polling until refresh or a Connection reset resumes it. Cached invalidation reads do not cancel an in-flight user-requested remote refresh.

The [Host API](../../../../packages/saki/host-api/README.md) exposes an authenticated long-poll cursor containing no product facts. Scan admission, complete publication, failure, and Provider attachment changes invalidate the affected Board after their state is visible. Committed changes replace the cursor; heartbeat and Host restart cause the browser to re-read complete authorized Projections. The Host checks Browser Session authority before waiting and before returning, and disposal releases every timer and listener. This avoids a second transport while preserving the existing complete-read authority.

The control plane assembles Work Item detail from durable records and current complete or targeted-confirmed Board facts. Body failure is independent from execution and delivery evidence. Field discovery is a complete provider-neutral read that verifies Project ownership without requiring the old Status field to exist. Explicit mapping changes still activate only through a successful complete scan. Milestone lists page existing Saki delivery records and preserve their phase separately from Work Item Status.

Asynchronous provider reads compare the owning Consumer attachment after awaiting. Cordis can expose a Service through distinct traceable proxy objects on successive property reads, so Service wrapper identity cannot prove attachment continuity. Exact Project, Issue, configuration, and confirmed-fingerprint checks remain necessary alongside that lifecycle check.

This implements Project planning within the broader [projection-driven client proposal](../../proposed/architecture/2026-08-18-saki-projection-driven-web-client.md). [Shell registration](2026-08-27-saki-web-shell-registration.md), [recoverable Work Item mutations](../architecture/2026-08-16-saki-recoverable-github-work-item-mutations.md), and [complete GitHub synchronization](../architecture/2026-08-18-saki-polling-first-github-synchronization.md) retain their independent ownership and rationale. The Work submission page and general Project Settings remain separate workflows.

## Alternatives considered

**Reconstruct the Board or execution joins in React.** Components would duplicate backend mapping and authorization relationships, and independently arriving responses could look like one complete confirmation.

**Retry with the latest fingerprint after response loss.** A new fingerprint authorizes a different operation and hides a concurrent remote change. Exact Intent replay lets the existing durable saga inspect its own effect history.

**Require a valid Status mapping before discovering fields.** Deleting the configured field would make its repair UI inaccessible. Complete raw field discovery has no dependency on the obsolete field id.

**Add a separate WebSocket or publish change deltas.** The existing Connection request carrier supports bounded cancellation and same-origin authentication. An invalidation cursor needs no second event protocol or browser-side delta reconstruction.

## Consequences

The browser can retain useful confirmations during independent failures without promoting optimistic placement into authority. The cost is retained per-Project query state, complete re-reads after invalidation, and an explicit recovery gesture when transport delivery is unknown. Recent activity is bounded to 32 references; the Milestone list includes configured delivery records rather than discovering arbitrary GitHub Milestones. Provider read tests, planning object tests, Host authentication tests, and the real-bundle browser flow cover the corresponding ownership and failure cases.
