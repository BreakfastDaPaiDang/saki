# Agent Note: Saki Branch Delivery and Milestone Release Evidence

Status: implemented

English | [中文](2026-08-18-saki-branch-delivery-and-milestone-release-evidence.zh.md)

## Problem

A reviewed local Commit is not yet a delivered Work Item. The branch may not have reached GitHub, the pull request may identify another head, CI may be incomplete or stale, and an Agent Run or GitHub review may report success without an authorized person accepting the result. Mutable branch, pull-request, and check state must not become completion evidence merely because each fact was true at a different time.

Push and GitHub mutations also cross durable boundaries that cannot share a transaction. A process can stop after the remote ref or pull request changed but before Saki records the result. Blind retry can overwrite concurrent remote work or create a duplicate pull request, while treating a missing acknowledgement as failure can leave the Work Item disconnected from an effect that did occur.

Milestone release evidence has a wider consistency problem. GitHub owns Milestone scope and metadata, while Saki owns the release phase and the evidence used to derive Released. A partial scope read, caller-selected exclusion, mutable tag target, unrelated GitHub Release, stale CI result, or unverified upstream baseline could otherwise publish a release claim that never described one complete world.

## Decision

### Branch Delivery

The Saki control plane keeps at most one current Branch Delivery aggregate for each Development Project and Work Item pair. The aggregate has a stable identity and expected revision and binds the current exact local Commit, canonical GitHub head ref, base ref, Push Host Operation, pull-request identity, targeted delivery observations, and any human acceptance to the exact Project, Repository, Work Item, Resource Binding, and GitHub mapping revisions that admitted them.

Before acceptance, a newly selected head, Push, pull request, or refreshed evidence updates that same aggregate only through its expected revision. The prior Control Intents, Host Operations, and external observations remain historical evidence rather than competing current deliveries. Acceptance seals the aggregate: later branch, Commit, PR, or CI changes cannot rewrite what the human accepted and require separately attributed product work.

Push reuses the Host Operation and recovery mechanism established by the [recoverable structured Git decision](../architecture/2026-08-28-saki-recoverable-structured-git-operations.md) while remaining a separate delivery operation under the existing `BindingWriteAdmission`. Its immutable request binds one exact local Commit to one canonical GitHub Repository and `refs/heads/*` target. Before the effect, the Local Host records the exact remote object id or proven branch absence, proves fast-forward ancestry or that absence, and uses only exact `--force-with-lease=<ref>:<expected>` remote compare-and-set.

The Local Host isolates repository-controlled configuration, hooks, transport overrides, prompts, and recursive submodule behavior. It invokes one trusted Host-configured system Git credential helper without returning or persisting credential bytes. If those restrictions cannot be established, production Push is unavailable. Once the operation records that an effect is possible, acknowledgement loss is resolved through exact remote-ref inspection; absent, old, changed, contradictory, or unavailable evidence never authorizes a blind second Push.

Pull-request creation uses one stable hidden delivery marker plus exact Repository, head ref, base ref, and head-Commit identity through the existing [recoverable GitHub mutation protocol](../architecture/2026-08-16-saki-recoverable-github-work-item-mutations.md). Association with an existing pull request is a separate local Control Intent admitted only after a complete targeted read. The Branch Delivery retains the actual branch, Commit, URL, pull-request identity, and Product App identity separately from the Saki Actor, Host Git credential identity, and Commit author.

### Targeted delivery observations

The [polling-first GitHub synchronization decision](../architecture/2026-08-18-saki-polling-first-github-synchronization.md) continues to own the complete Board scan and GitHub Sync Checkpoint. Pull request, complete pull-request review, CI, Milestone, tag, Release, Commit, and ancestry facts use targeted reads that never advance that checkpoint. An interactive View requests one targeted pass. One configurable provider-scoped loop polls only durable pending Branch and Milestone Delivery work, starts immediately, waits its full interval after each completed pass, isolates failures between aggregates and between records, and aborts and drains on Provider detachment.

Each targeted source retains its last confirmed observation separately from current failure, staleness, and invalidation. A failed refresh preserves the confirmed fact without presenting it as current. Pull-request reviews remain raw display observations with no transition, acceptance, or release authority; their failure does not replace the exact ref, pull-request, CI, and human-Intent requirements. The browser projection derives its closed CI summary only from that retained exact-Commit fact and exposes current source health independently. CI success requires a complete, fully paginated result for the exact Branch Delivery Commit; missing, incomplete, pending, failed, canceled, stale, contradictory, or permission-limited evidence fails closed.

Confirmed Push and pull-request evidence creates or exactly replays the existing recoverable `MoveWorkItem` child transition to In review. A targeted read may refresh or invalidate Delivery evidence, but it does not silently change GitHub Project Status or settle human acceptance.

### Human acceptance

Acceptance is a distinct Control Intent from a current human Principal with a current scoped Grant, the expected Branch Delivery revision, and the exact Work Item remote fingerprint under the stored mapping revision, following the [Principal, Grant, and Actor attribution decision](../../../../docs/adr/0008-principals-grants-and-actor-attribution.md). At the mutation boundary, the control plane rereads the exact local Commit, remote ref, pull-request head, and complete exact-Commit CI evidence and rejects any stale, incomplete, failed, or contradictory result.

An accepted Intent appends immutable Actor and evidence attribution, seals the Branch Delivery, and creates or exactly replays the existing recoverable Done and Issue-close child transition. An Agent self-report, successful Agent Run, pull-request author, Product App identity, or GitHub `APPROVED` review never substitutes for this human decision. A lost child-mutation acknowledgement follows targeted inspection and reconciliation rather than reopening or rewriting the accepted Delivery.

### Milestone Delivery and ReleaseEvidencePolicyV1

GitHub remains authoritative for a Milestone's Issue scope, title, description, due date, and open or closed state. One versioned Saki Milestone Delivery record binds the exact Development Project, Repository, and GitHub Milestone and owns only Planned, In Progress, Ready to Release, or Canceled phase metadata; the expected `saki-v*` tag, expected release Commit and official Upstream Baseline metadata; repair state; and optional immutable embedded Release Evidence. Phase changes and finalization use the expected record revision. Released is derived only from embedded evidence, never written as mutable phase metadata.

The Milestone Projection keeps each source's confirmation, failure, staleness, and invalidation separate. It combines an exact GitHub scope fingerprint with Work Item totals by Board Status from one matching confirmed Board generation, unmapped or unsupported counts, typed Blockage, the Saki phase, and the Release summary. It never silently joins different scan generations or presents partial Milestone scope as complete.

`ReleaseEvidencePolicyV1`, identified by `release-evidence/v1`, is the sole control-plane owner of version 1 selection, completeness, and freshness. It exposes no caller-supplied exclusion, predicate, or policy language. After a Finalize Intent is prepared, the policy requires a new complete Board scan, a fully paginated Milestone scope read, a nonempty exact mapping, every selected Work Item in Done or Canceled, and accepted current Branch Delivery evidence with complete exact-Commit CI success for every Done item that has a Delivery.

The same evaluation requires every retained delivery Commit to be an ancestor of the release Commit, an exact `refs/tags/saki-v*` reference recursively peeled to that Commit, a GitHub Release that matches the same Commit without treating `target_commitish` as identity, and proof that the exact official Upstream Baseline exists in the configured upstream Repository and is an ancestor of the release Commit. Because [an installation token is limited to repositories granted to that installation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app), version 0.1.0 persists the upstream Repository's canonical `nameWithOwner`, node id, and database id, then proves upstream existence through a bounded credential-free public read. `GET /repos/{owner}/{repo}` must match those three identities and public visibility before lightweight `GET /repos/{owner}/{repo}/git/commits/{commit_sha}` returns the full exact SHA. A separate serial queue bounds the anonymous path, which remains subject to GitHub's shared low unauthenticated quota; a private configured upstream is unsupported. A final complete reread must match the evaluated facts.

One human expected-revision compare-and-set embeds the policy and evaluation digest, exact Development Project, selected Work Items and their Branch Delivery head/base refs, prior metadata revision, tag, Release, peeled Commit, all three upstream Repository identities, Upstream Baseline and ancestry proof, Actor, and Intent mapping in the Milestone Delivery record. Evaluation and final fresh scans may observe different complete Board generations; semantic final-reread equality uses the Board fingerprint and facts, while the embedded evidence and digest retain and bind the final generation. External Milestone closure, concurrent GitHub change, or changed final reread produces repair, conflict, or reconciliation without publishing partial phase or evidence state. Later external drift does not rewrite embedded Release Evidence.

### Ownership and boundaries

This feature is one concrete realization of the broader [recoverable Control Intent proposal](../../proposed/architecture/2026-08-18-saki-recoverable-control-intents.md) and the targeted-delivery portion of [ADR 0013](../../../../docs/adr/0013-polling-first-staged-github-synchronization.md). It reuses the existing Host Operation lifecycle, Product App Service, Git process launcher, GitHub mutation recovery, Binding write admission, Work Item transitions, and single control-plane Service. It adds exactly one adjacent Saki state migration and no parallel client, launcher, lease, queue, generic saga, or release-policy language.

The feature persists the durable Git, PR, CI, acceptance, and release facts that their owning projections need. Projecting selected Git, PR, and CI facts into Principal-scoped My Work and Attention remains deferred to [follow-up #74](https://github.com/BreakfastDaPaiDang/saki/issues/74), consistent with the [durable Intervention decision](2026-08-18-saki-durable-intervention-answer.md). This feature does not add a generic Signal aggregate, Attention table, dismissal lifecycle, or network work to projection reads.

Automatic merge, automatic Done, complex Git history editing, arbitrary release trains, GitHub user authorization, and post-acceptance Delivery mutation remain outside this decision.

## Alternatives considered

**Use a mutable branch, pull request, or GitHub Release `target_commitish` as delivery identity.** Each can move independently and can point at a different Commit after an earlier observation. Exact Commit, ref, pull-request head, recursively peeled tag, and Release relationships preserve the identity that acceptance and release finalization require.

**Treat Agent Run success, pull-request approval, or the external credential as acceptance.** Those facts establish execution, review, or effect identity rather than a current human Principal's attributed decision. Conflating them would let provenance or an external account confer Saki authority.

**Retry Push or pull-request creation after an unavailable response.** Silence does not prove that the remote effect failed. Exact remote-ref or marker-based inspection can prove a result, safe absence, conflict, or reconciliation requirement without duplicating or overwriting external work.

**Fold delivery observations into the Board scan and checkpoint.** PR, CI, tag, and Release facts have different lifetimes and active-view demand from shared Work Item Status. Coupling them would make a partial delivery refresh either block Board publication or falsely advance the Board checkpoint.

**Store Release Evidence in a separate record.** A second record would add a cross-record publication gap in which phase and evidence disagree. Embedding the immutable evidence through the Milestone Delivery compare-and-set makes Released derivable from one authoritative value.

**Let callers filter Milestone scope or configure a generic evidence policy.** Caller exclusions can make an incomplete release appear complete, while a policy language adds versioning and evaluation behavior before a second genuine policy exists. One versioned fixed policy provides deterministic version 1 evidence.

**Create Signal or Attention records during delivery.** Copied notification state would duplicate the Branch Delivery and targeted observation owners. Follow-up #74 owns deriving Principal-scoped entries from current durable producer records without acquiring mutation authority.

## Verification

Branch Delivery schema, storage, control-plane, and recovery tests pin one current aggregate per Development Project and Work Item, expected-revision updates before acceptance, immutable accepted evidence, exact Commit and ref admission, Push lost-acknowledgement inspection, marker-bound pull-request creation, exact association, and recoverable In review and Done child transitions. They also prove that raw pull-request review facts remain independent display evidence and that human acceptance still requires current authority plus a complete successful exact-Commit CI reread.

GitHub Service Definition, Product App, and Host API tests cover strict pull-request, review, CI, Milestone, tag, Release, Commit, public upstream Commit, and ancestry facts; complete pagination and parent-identity checks; operation-specific permissions; bounded failures; provider detachment; and closed wire projections. Polling tests exercise an immediate provider-scoped pass, full-interval scheduling after completion, pending-record selection, per-record isolation, and abort-and-drain disposal without advancing a Board checkpoint.

Milestone Delivery and policy tests pin complete scope joined to one matching Board generation, typed incompleteness and repair, conditional accepted Delivery evidence for Done items, exact CI and ancestry, recursive tag peel, matching Release Commit, credential-free public Upstream Baseline existence, and a final semantic reread. They also prove that unchanged facts may cross to a newer complete Board generation while the embedded digest binds the final generation, and that changed or tampered evidence fails closed.

The keyless assembled delivery snapshot runs the production bundle, Host HTTP API, control plane, real local Stage and Commit path, and external-only GitHub and Push fakes. It covers Commit, one recoverable Push, pull-request creation, In review with a confirmed raw review, separately attributed human acceptance, recoverable Done and Issue close, and immutable Milestone Release Evidence without adding an Attention queue or generic Signal aggregate.

## Consequences

The combined Host, GitHub, Work Item, and Milestone recovery paths could grow into a generic saga framework. Fixed operation families, existing owners, one current Branch Delivery aggregate, and one adjacent migration deliberately trade reuse for an auditable version 0.1.0 path.

Mutable refs, pull-request heads, and paginated CI can change between reads. Exact Commit binding, source-specific freshness, mutation-boundary rereads, and a final matching release reread reduce the accepted race window, but contested external state may still stop in conflict or reconciliation instead of maximizing availability.

Repository-controlled Git configuration, hooks, transports, prompts, or credential output could escape the intended Host trust boundary. Push remains unavailable unless the Local Host can establish isolation and use the one configured system credential helper without exposing its bytes.

Targeted polling adds GitHub API cost and can delay current evidence under rate limits. Limiting interactive refresh to active Views, background work to durable pending records, keeping intervals configurable, and preserving last-confirmed observations avoid a second background synchronization engine but accept visible staleness.

A fixed release policy may not fit a later multi-repository or partial-release workflow. The explicit `release-evidence/v1` identifier permits a later policy version without turning the first release into a premature policy DSL or weakening already embedded evidence.

An accepted Branch Delivery cannot absorb a later corrective Commit or changed PR. This preserves what the human accepted; corrections require separately attributed product work rather than silently mutating the evidence behind Done.
