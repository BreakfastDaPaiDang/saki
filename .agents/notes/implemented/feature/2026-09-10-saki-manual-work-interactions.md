# Agent Note: Saki manual Work interactions

Status: implemented

English | [中文](2026-09-10-saki-manual-work-interactions.zh.md)

## Problem

A requirement can create a GitHub Issue before its browser receives the result. An operator can also leave the Work page while an Agent asks a durable question. Reconstructing these gestures from current form fields or component lifetime can duplicate an Issue, change an expected revision, or lose the route back to execution evidence.

## Decision

The [Web client](../../../../packages/saki/web-ui/README.md) owns Work interactions outside React and shares the planning controller's Access identity. My Work groups and recommended actions come from the backend. Creation candidates come from the authorized Project index and each Project's Board, including its mutation availability and exact Project, synchronization, and mapping revisions. A failed Project read retains its own confirmation without suppressing other Projects. Explicit refresh and completed creation request Board scans; invalidation reads stay cached to avoid creating a scan feedback loop.

Requirement drafts, answer text, and exact submitted Intents persist under the authenticated Principal. The client saves an Intent before sending it. A lost response preserves its id and complete payload; explicit recovery replays that payload with current request authority. It does not allocate another Issue-creation Intent. Partial creation shows the known Work Item and honors the backend's recovery action. Reconciliation results remain inspectable and cannot be dismissed. Dismissing successful creation clears its submitted draft. Principal or request-authority replacement cancels old reads and requests, clears confirmed caches, and prevents late responses from changing the new identity's view.

A manual Give-to-Agent offer includes a strict browser-safe launch summary: Agent Profile id and version, exact provider/model route, Resource Binding id and revision, display label, and inherited change count. Confirmation retains the offered Project revision and Issue fingerprint. An Intervention answer retains its offered request revision and inert text. Submission revalidates through the existing [manual dispatch](2026-08-18-saki-manual-give-to-agent-dispatch.md) and [durable answer](2026-08-18-saki-durable-intervention-answer.md) owners. No browser gesture bypasses those owners or inserts model input directly.

Work Item detail accepts answered and resolved Intervention history alongside open questions; My Work retains only actionable Intervention states. Created Inbox Issues open in the Project Board. Ready suggestions appear in My Work; changing Status starts no Agent. A card opens the existing Work Item view, whose Session action restores the inherited Conversation. The Work and Project interaction stores retain their respective inputs and addresses across navigation and browser reload. The Saki bundle mounts the Chat target, Tool rendering, and their resource and details-sidebar dependencies to render persisted Session messages.

This implements the manual Work part of the [projection-driven client proposal](../../proposed/architecture/2026-08-18-saki-projection-driven-web-client.md). That proposal retains automatic claiming, budget suspension, completion, Settings, and broader integration work. [Confirmed planning views](2026-09-10-saki-confirmed-planning-views.md), [recoverable Work Item mutations](../architecture/2026-08-16-saki-recoverable-github-work-item-mutations.md), manual dispatch, and durable answers retain their independent ownership and rationale.

## Alternatives considered

**Rebuild a request from the latest form or offer after response loss.** A new id or revised payload authorizes a different operation. The durable backend can reconcile only the original request's effects.

**Join execution state or derive eligibility in React.** Backend records, Grants, and operation conditions can change independently. Complete My Work results and one offered action preserve their existing authority.

**Treat Ready as permission to execute.** Status is planning state. Manual execution requires an explicit confirmation, and automatic dispatch belongs to its own policy and budget workflow.

## Consequences

Operators can create requirements, plan them, authorize a Run, answer its question, and inspect its Session through the composed product. Backend and browser tests cover launch-summary validation, identity replacement, independent read failures, exact replay, native dialog gestures, and delayed acknowledgement. The real-bundle browser case owns a temporary Git repository and isolated Installation, substitutes only external GitHub and LLM Providers, and checks one Issue creation through the manual flow. Automatic claiming, budget suspension, automatic Done, production model supply, and generalized recovery remain separate work.
