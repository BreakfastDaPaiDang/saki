# Saki Product Requirements

English | [中文](product-requirements.zh.md)

Status: Draft for review of product positioning, core abstractions, and stage boundaries. Separate specifications own version implementation scope.

## Product positioning

Saki is an Agent-native project operating system built on DeepSeek Harness (DSH). It organizes goals, work, resources, Agent executions, automation, and outcome evidence into continuously operable Projects, enabling an individual to manage software development first, business systems next, and eventually a shared work system with organization members.

Saki does not aim to copy a traditional IDE, project management tool, or chatbot. It provides the missing product kernel between them: a Work Item can enter the correct Project, receive resources and permissions on an appropriate Host, trigger a traceable Execution, and return verifiable Outcome Evidence to work status, milestones, and business results.

## Problem

Agent development is scattered across editor windows, separate conversations, terminals, GitHub pages, and local directories. Projects have no stable relationship with Sessions, Issues and boards cannot reliably start Agents, and code results do not naturally return to PRs, CI, Milestones, and Releases. As the number of projects grows, finding context, synchronizing state manually, and resuming interrupted work becomes increasingly expensive.

Delivered software remains a business system that needs management. Bots, content pipelines, scheduled tools, services, databases, and external platforms each have their own logs, credentials, tasks, and deployment entry points, but lack a unified project view, observable state, and Agent operation entry point.

Multi-person collaboration adds identity, authorization, personal and shared spaces, shared execution resources, and audit concerns. Exposing a single-user Host directly to other people is unsafe and cannot establish clear work ownership.

## Product kernel

Saki treats a Project as an operable, observable, and portable management unit, not as an alias for a folder, repository, or board.

### Project

A durable scope that organizes work, resources, automation, and results around a continuing goal. Different capability combinations form Development Projects, Managed Systems, and later types without duplicating the product kernel for each domain.

### Resource Binding

A stable, revalidatable association between a Project and an external or local resource. Resources may include a Workspace, Git worktree, GitHub Repository, GitHub Project, deployment environment, service, database, messaging channel, or specialized tool. Saki stores an identity, owning Host, revisioned locator, health, and access method without copying the complete data owned by the resource; relocation changes the observation, not the binding's historical identity.

### Principal

A durable Saki security subject that can authenticate and receive Grants. Human users, durable Agent Identities, and Project automation may have Principal identities, while browser sessions, Hosts, and external credentials remain separate.

### Grant

A versioned authorization issued to a Principal for named actions within a resource scope, validity period, and delegation limit. A Grant defines the security ceiling; it does not decide when work should run.

### Actor

The immutable attribution Saki derives when accepting a Control Intent, recording which Principal exercised authority, on whose behalf, and through which Grant versions. Actor is historical explanation, not an identity or permission source.

### Agent Identity

A durable Agent actor that can receive continuing responsibility and follow-up work while retaining history across Executions. An Agent Identity may own an Attention Inbox, responsibility scope, and long-term memory, but does not determine the configuration or location of a particular attempt.

### Agent Profile

A named, reusable, versioned Agent execution configuration within a Project. An Agent Profile declares role instructions, context sources, requested tools and permissions, model routing, budgets, and permitted trigger types; it determines how an Agent works without owning continuing responsibility. Every Agent Run records the Profile version actually used.

### Work Item

A unit of intended work with an explicit outcome and acceptance criteria. Its shared carrier may be a GitHub Issue or a later business system, while Saki organizes it with consistent Work Item Status, Blockage, and Milestone semantics.

### Work Assignment

A durable responsibility relation between a Work Item and the human Principal, Agent Identity, or Project Automation Principal expected to carry it forward. Assignment does not grant authority or start an Execution.

### Work Session

A durable, user-visible collaboration conversation scoped to one Work Item. It keeps human and Agent participation attributable across execution attempts and coordinator replacement; a Work Item may have multiple Work Sessions while designating at most one as primary.

### Execution

One traceable attempt performed by an Agent, workflow, or scheduled task. Agent Run is the first Execution type; later types may include Scheduled Run, Event-triggered Run, and distributed Run. Execution is separate from Work Item Status, and successful exit does not mean the work has been accepted.

### Execution Dispatch

A durable command produced from an accepted Control Intent for an enrolled Host to create or resume one Execution. Repeated delivery addresses the same intended Execution through a bounded Dispatch Claim and one idempotent Host Operation; delivery state does not prove Execution success.

### Host Operation

A durable Host-owned admission and inspection record for one Execution Dispatch. It binds a stable dispatch identity to the intended Execution before external effects and lets repeated delivery find the same operation; it is neither the Control Intent nor evidence that the Execution succeeded.

### Outcome Evidence

A locatable fact that demonstrates whether Work Item acceptance criteria or a business result have been satisfied, such as a Diff, test result, Commit, PR, CI result, Release, deployment status, log, or business metric. Automatic completion must rely on Outcome Evidence rather than an Agent's self-reported success.

### Automation Policy

A versioned Project configuration for triggers, typed resource limits, concurrency, pause conditions, delivery operations, and evidence required for automatic completion. It decides when a Project Automation Principal may use authority already supplied by Grants; it cannot create that authority. Automatic effects reserve applicable budgets before dispatch and settle attributed usage afterward. Unknown provider-wide usage follows an explicit pause or local-limits-only rule rather than becoming zero or unlimited. Automation level is an explicit choice for each Project, not a hidden global switch.

### Automation Budget Reservation

A durable, idempotent allocation of typed limits for one automatic operation before its external effects. It connects the policy revision and Actor to the affected Project, Work Item, Execution, provider profile, and Host Operation; confirmed usage settles it, confirmed absence releases it, and unknown outcome keeps it reserved for reconciliation.

### Usage Ledger Entry

An attributed measurement, estimate, correction, release, or unresolved amount linked to the external evidence that supports it. Ledger entries let Saki explain and enforce automatic resource use without pretending to own a provider's subscription balance or bill.

### Signal

An attributed point-in-time fact produced by a person, machine, or Agent, such as a manual assignment, timer expiry, state alert, external event, Work Item change, Agent handoff, or Execution result. Event Subscription normalizes matching external events into Signals; a Signal supplies information but grants no execution authority.

### Event Subscription

A durable Project subscription to an external event source that declares the source, filters, deduplication, and ownership of generated Signals. It does not start an Agent directly; Automation Policy decides whether a Signal updates state, notifies a person, appends to existing work, creates a Work Item, or starts an Execution.

### Intervention Request

A durable request for a named human or later Agent Identity to provide input, approval, credential authorization, acceptance, conflict resolution, or recovery action. The response is separately attributed, cannot widen Grants, and remains answerable independently of the live process or model turn that requested it.

### Attention Inbox

A per-Principal or per-Agent-Identity projection of unresolved Work Assignments, Intervention Requests, recovery states, and selected Signals. It neither owns those facts nor acts as an execution queue and is distinct from the Work Item Status named Inbox.

### View

A projection that provides a particular information density and set of operations over the same Project data. Board, Milestone View, Development Workspace, Operations Cockpit, operator console, and Attention Inbox may serve different decisions and preferences without becoming new authoritative data sources.

### Saki Installation

The stable, migratable identity and product namespace of one active Saki control plane. An Installation owns portable product state and policy and may enroll multiple Saki Hosts; it is not the machine or process that currently runs it.

### Saki Host

An enrolled execution node with a stable identity and revalidated capability inventory. It owns machine-local files, processes, capability Providers, credential resolution, and execution resources. A Project may progressively bind resources on multiple Hosts, but resource location and execution ownership must remain visible.

### Installation State Generation

A complete, versioned copy of Saki-owned Installation state. One generation is active and writable; upgrade candidates and retained generations stay closed until an explicit maintenance operation selects or removes them.

### Recovery Backup

An exact local rollback artifact for one Installation State Generation and a compatible Saki build. It protects an upgrade rollback point but is not a portable Host-transfer format.

### Installation Export

An encrypted, versioned portable archive of declared Installation records and dependencies. It preserves product identity and relationships while requiring Host resources, credentials, and unresolved operations to be rebound or reconciled after restore.

The core relationships are `Saki Installation -> Installation State Generation`, `Project -> Work Item -> Execution -> Outcome Evidence`, `Work Item -> Work Assignment`, `Work Item -> Work Session -> Agent Run`, `Control Intent -> Execution Dispatch -> Host Operation -> Execution`, `Automation Policy -> Automation Budget Reservation -> Usage Ledger Entry`, `Project -> Agent Identity -> Agent Run -> Outcome Evidence`, and `Principal -> Grant -> Actor -> Control Intent`. Work Sessions organize attributed collaboration for Agent work without excluding non-Agent Executions. Agent Identity is an optional owner of continuing responsibility, while every Agent Run fixes the Agent Profile version actually used. Resource Binding locates what a Project can access, Grant limits who may act on it, Signal supplies facts about change, Automation Policy determines when execution is eligible and bounded, Intervention Request persists a required response, Attention Inbox projects unresolved work, and View determines how people observe and intervene.

## Model supply and context lifecycle

Saki treats model access as execution supply rather than an attribute of a Work Item. An Agent Profile may request a Model Route, but every Execution records the provider, model, reasoning configuration, and Provider Account Profile actually resolved. Provider Account Profiles expose authentication, capabilities, health, and attributed Usage Snapshots without copying raw credentials into Project or Session records.

Context Capacity, Runtime Context Limit, and Context Policy remain separate facts. The model advertises Context Capacity; a product surface, subscription, or account may expose a lower Runtime Context Limit; a versioned Context Policy chooses a lower compaction trigger and a strategy for compaction, pruning, restoration, and observation. Saki must not infer one from another or present logical retrieved history as a physical model window.

Generated media is durable project output rather than an ephemeral chat response. A Generation Job records its resolved Model Route, inputs, lifecycle, output artifacts, and provenance and may run concurrently subject to provider-account limits. The [Model Supply domain language](../contexts/model-supply/CONTEXT.md) owns these terms.

## Agent coordination and work sessions

A Project Coordinator is a role held by an Agent Identity, not one permanent Session. It uses replaceable Coordination Sessions to delegate and supervise Work Items, reads durable Project state instead of retaining every child transcript in model context, and may continue coordinating after a Session restart or Host migration.

A Work Session is the collaboration record around a Work Item rather than an intrinsic subagent. DSH may execute it as a top-level Session or continuable subagent, and an Agent working inside it may create one-shot or nested subagents for bounded internal work. Saki preserves Work Item association, Work Assignment, the primary active Work Session, and message attribution independently of DSH parent-child lineage; see [Agent Operations ADR 0002](../adr/agent-operations/0002-work-sessions-and-subagent-lineage.md).

## Traceable Project operational graph

Saki uses one traceable relationship graph to connect product intent, Work Items, Signals, Agent Identities, Agent Profile versions, Executions, resource changes, and Outcome Evidence. Stage 1 exposes a relatively complete graph and evidence chain to development operators for debugging, recovery, review, and automation. Later stages retain those relationships while Views primarily show daily operators, organization members, and request-only participants the Board, tasks, state, and areas requiring intervention.

The Project operational graph provides explanation and recovery capability; it does not require every user to operate a graph interface. A dense operator console, project asset overview, Agent-run supervision, Attention Inbox, and simplified Board all project the same domain facts, and the product does not assume one universal home page.

## Control plane and execution plane

One active control plane writes the state of a Saki Installation. The Installation can migrate between machines and can enroll multiple Hosts, but version 0.1.0 does not support active-active control planes. Its co-located Local Host retains a separate identity so future remote execution and Host replacement do not change Project ownership.

The control plane owns Principals, Grants, Actor attribution, Project registration, Resource Binding metadata, Work Item projections, Work Assignments, Agent Identities, Agent Profiles, Signal routing, Automation Policies, Execution Dispatches, Intervention Requests, scheduling, Attention Inbox projections, run-history projections, and audit relationships. It decides what work should execute under which conditions, but does not directly hold working directories, processes, model Sessions, or credential contents.

The execution plane resides on a Saki Host or later remote execution target and owns Host Operations, Workspace resolution, actual Git worktree state, DSH Sessions, terminals and processes, tool and model invocation, credential-reference resolution, and Host capability state. It changes real resources within an authorized Execution and reports attributed progress, results, and Outcome Evidence; it does not choose Project priorities, create unbounded follow-up work, or widen permissions by itself.

The two planes connect through a stable Execution interface: the control plane delivers an attributed Execution Dispatch containing the target Host, Project, trigger source, Profile version, resource requirements, limits, and delegated authority, and the execution plane prepares one idempotent Host Operation before returning state events, Intervention Requests, results, and evidence references. Version 0.1.0 may co-locate both in one process and repository, but a Web View or control logic may not bypass the interface to operate Host resources directly. A network transport adapter is added only when a second real remote implementation exists, rather than introducing microservices in the first version. See [ADR 0004](../adr/0004-control-and-execution-planes.md), [ADR 0007](../adr/0007-single-control-plane-and-enrolled-hosts.md), [ADR 0008](../adr/0008-principals-grants-and-actor-attribution.md), [ADR 0009](../adr/0009-durable-dispatch-intervention-and-attention-projections.md), and [ADR 0010](../adr/0010-fenced-idempotent-dispatch-admission.md).

## Signal transport and collaboration

External-platform events, timer expirations, Host state, human operations, and Agent outputs first pass through a source Adapter and become attributed Signals; they do not enter model context or start execution directly. A Signal stores at least a stable identifier, source, occurrence and receipt times, Project ownership, deduplication key, related subject, causal relationship, and payload reference so Saki can replay, reconcile, and trace chained behavior.

Automation Policy may choose five classes of effect for a Signal: update only a Project read model; notify a person or Agent Identity; associate the new fact with an existing Work Item or Execution; create a Work Item when there is a continuing expected outcome, human collaboration, or acceptance requirement; or start an Execution directly when the work is bounded and authorized. A routine scheduled check can therefore produce only an Execution and Outcome Evidence, escalating to a Work Item only when it finds an anomaly or needs coordination.

Agent handoffs also produce Signals attributed to an Agent Identity and Agent Run with a causal relationship, rather than using a private message channel that can widen authority directly. Signal routing must handle duplicate events, event storms, and Agent loops; a subsequent Agent may be invoked only within causal-depth, concurrency, cost, and time limits granted by Automation Policy.

## Product principles

### Work must leave an evidence chain

A PRD or specification preserves product intent, a Work Item preserves atomic work, a PR preserves implementation discussion, and CI, Release, deployment, or business metrics preserve delivery facts. Saki connects these records and does not treat chat history as the sole source of facts.

### Automation requires progressive authorization

Ready means only that a Work Item can be claimed. Manual mode requires an operator to trigger and accept work; automatic mode may claim, commit, deliver, and mark Done automatically only when its Project Automation Principal has the required Grants, Automation Policy permits the action, and every required budget is reserved. Signals, policies, Agents, and child Agents cannot widen authority, budget exhaustion never implies Done, and failure must stop in an explainable, recoverable state. See [ADR 0015](../adr/0015-reserved-automation-budgets-and-usage-ledger.md).

### Authoritative sources must be explicit

Git, GitHub, DSH Sessions, and business systems continue to own their respective data. Saki owns only Project associations, Execution associations, Automation Policies, confirmed synchronization checkpoints, and necessary caches; every View must display data sources, confirmation time, optimistic or stale state, and failure location. GitHub scans publish atomically, and page cursors or webhook delivery never become authority. See [ADR 0013](../adr/0013-polling-first-staged-github-synchronization.md).

### Agent context must attribute its sources

Agent context may combine an Agent Identity's continuing responsibilities and memory, an Agent Profile's role instructions and context recipe, the Workspace `AGENTS.md`, a Work Item, system state and alerts, historical Outcome Evidence, and handoff information from other Agents. Every model-visible input must identify its source and be written to a recoverable Session record; Signals and Agent messages cannot become hidden instruction channels that bypass Automation Policy.

### Plugin-first, single-repository-first

Saki capabilities should form replaceable modules through DSH bundles, Service Definitions, Providers, and Consumers, but remain in the single Saki repository by default at the current stage. A repository is split only when its interface, users, maintainers, release cadence, or security lifecycle is independent. See [ADR 0002](../adr/0002-plugin-first-single-repository.md).

Coupling is measured by whether a change remains inside the module that owns it, not by the number of directories or repositories. Real variation points such as Resource Adapter, Signal Source, and Execution Provider should be replaceable through narrow interfaces; Saki does not publish hypothetical plugin interfaces when only one implementation exists. The ability to split a capability into another repository later without changing product semantics is evidence that the module is sufficiently independent, not a present requirement.

Plugin composition is not a sandbox boundary. Code installed as a Cordis or npm plugin on a Host is privileged trusted code, while repository content, model output, browser payloads, and external events remain untrusted inputs. A dynamic model-generated plugin remains ephemeral until a Host Operator reviews and promotes it through the normal installation path.

### Credential protection claims must name their threat model

Product records, Projections, Agents, and browser clients receive credential references and safe observations, not raw values. Every Host credential Provider declares a Credential Protection Level; version 0.1.0 accepts `local-user-trust` for its single-operator Windows Host and states that same-user Agent processes remain trusted by that level. See [ADR 0011](../adr/0011-dpapi-local-user-trust-credentials.md).

Host migration never gains apparent portability by copying encrypted credential blobs that the replacement Host cannot safely use. Before organization members share Agent capability backed by Host-supplied accounts, Saki must use a Credential Broker under a distinct OS identity or an external secret manager and verify that Agent execution cannot recover raw values.

### Durable product state must survive evolution explicitly

Saki-owned product records carry a forward-compatibility promise from their first 0.1.0 schema. Upgrades migrate a separate Installation State Generation and publish it only after validation; rollback uses a verified Recovery Backup rather than reverse migration. Host replacement uses an Installation Export whose declared contents exclude machine authority, then requires rebinding, reauthorization, and reconciliation. See [ADR 0012](../adr/0012-forward-migrations-and-installation-maintenance.md).

### Integrate general capabilities and own product semantics

Saki should not rebuild general Agent, model, terminal, file, LSP, browser, computer-control, SSH, or provider-integration capabilities that DSH or its community can supply. Saki must own Project, Resource Binding, orchestration from Work Item to Execution, Outcome Evidence, and cross-system Views because together they form the product distinction.

## Capability sourcing strategy

Before splitting a version into Issues, Saki maintains one capability assessment instead of making community expectations into dependencies:

| Category | Decision criterion | Saki action |
| --- | --- | --- |
| Inherit directly | DSH already provides a stable capability | Compose it through profiles or plugins without copying its implementation |
| Thin adaptation | An external platform or community capability exists, but its interface does not match Saki Project semantics | Implement only an Adapter and necessary mappings, keeping it replaceable |
| Saki-owned | The capability carries Saki's core product semantics | Implement it in the Saki repository behind a clear plugin interface |
| Defer and wait | The general capability does not block the current loop and DSH or the community is likely to provide it | Record the gap and fallback without building it early |

Waiting cannot be justified only by saying that the community may build something. A candidate dependency requires a runnable project, continuing maintainers, a design compatible with Saki interfaces, or a clear upstream plan; when a capability blocks the current version and has no credible candidate, Saki builds the thinnest replaceable implementation.

## Product stages

Stages describe product capability boundaries and do not equal individual versions. Version 0.1.0 is only the first usable slice of Stage 1.

### Stage 1: Agent-native development system

Stage 1 lets a single Host Operator use Saki as the primary development environment and personal Agent platform. It gives development operators a relatively complete Project operational graph and evidence chain, beginning with a local multi-project loop and then adding daily development interfaces, Project-level Agent Profiles, multiple model and tool integrations, Event Subscriptions, scheduled automation, parallel worktrees, task queues, remote Hosts, distributed execution, and Host migration.

Stage 1 progresses through these capabilities:

1. **Development loop**: Register a Development Project, start an Agent from a Work Item, review Diffs, commit, and track PRs, CI, Milestones, and Releases. Version 0.1.0 delivers this slice.
2. **Development-environment replacement**: Add code navigation, search, LSP, deeper Git operations, Actions, plugin management, and sufficient browser, computer, or SSH integration so daily development no longer depends on VS Code, while allowing a Project to select Development Agent Profiles with different roles.
3. **Autonomous development orchestration**: Add Project Coordinator identities, Signal ingestion, event triggers, scheduled tasks, durable dispatch, Agent Attention Inboxes, budgets, concurrent worktrees, automatic acceptance, and failure recovery so multiple projects and Agent Profiles can progress continuously.
4. **Distributed development execution**: Dispatch Executions to different Hosts or remote environments with Host availability, project migration, resource matching, and recoverable scheduling.

Stage 1 is complete when one operator can plan, execute, automate, and observe multiple software projects in Saki and run work safely across local or remote execution resources; multi-user login and organization authorization are not required.

### Stage 2: Business systems and business Agent platform

Stage 2 registers developed or existing business systems as Managed Systems and extends the Stage 1 development Agent platform into a business Agent platform. Through Resource Bindings, Saki connects running services, deployment environments, databases, messaging platforms, content pipelines, scheduled tasks, and specialized tools, while an Operations Cockpit presents health, pending work, Agent Profiles, automation, events, logs, and business results together.

A Development Agent usually receives context from a Workspace, `AGENTS.md`, a Work Item, and repository state; a business Agent may also read human-authored responsibilities and runbooks, current Managed System state, alerts, business metrics, historical Executions, and relevant people. Business Agents that continuously own on-call, operations, content-production, or approval responsibilities are Agent Identities; they may select different Agent Profiles by work type and share a Project and some Resource Bindings while retaining separate Attention Inboxes, responsibilities, and continuous histories.

Human input enters through responsibilities, runbooks, Work Items, and explicit instructions; machine input produces Signals through scheduled tasks, state alerts, and event subscriptions; other Agents collaborate through attributed handoff Signals and Outcome Evidence. Automation Policy determines whether a Signal creates a Work Item, starts a particular Agent Profile, appends context to an existing Execution, or requests human action, and an Agent cannot gain more authority merely by receiving a message from another Agent.

The business Agent platform provides at least Agent Identities and Attention Inboxes, Agent Profile management, context-source composition, Event Subscriptions, Signal routing, durable Execution Dispatch, Intervention Requests, permissions and budgets, Agent handoffs, Outcome Evidence, and run observation. Agent Profiles may reuse DSH per-session Agent Presets; Saki does not create another model loop but owns the product relationships between Projects and those runtime capabilities.

Stage 2 is complete when an operator can manage both project code and operational reality in Saki and connect existing systems such as `feishu-bot`, automated tools, and content or video pipelines to a unified observation, Agent-execution, and operation loop; it may remain a single-user product.

### Stage 3: Organization work system

Stage 3 makes the Web application the primary workspace for organization members and adds GitHub-identity login, personal and organization spaces, project discovery and authorization, roles and audit, shared Agent supply, resource quotas, collaborative Work Items, reviews, and approvals. A GitHub identity authenticates or links a human Principal; organization membership may inform Grant administration but does not directly grant Host access. Automation uses separate Principals, and nobody receives the Host Operator's raw model credentials or subscription session. Shared Host-supplied accounts require a Credential Broker beyond the `local-user-trust` boundary used by the single-operator release.

The specific Stage 3 information architecture must emerge from actual use in the first two stages; Saki does not yet assume a traditional project-management product, portal, or social collaboration product. The Web interface will own complete Project, Work Item, Agent, resource, review, and organization-management capabilities; Adapters for Feishu, QQ, and similar systems provide only event input, notifications, approvals, or lightweight shortcuts, are not the primary work entry point, and do not own separate organization-work state.

Stage 3 is complete when an organization can develop and operate Projects together with explicit permissions, traceable execution, and metered resources, and can migrate Hosts or expand execution nodes without losing Project identity or history.

## Product roles

| First appearance | Role | Responsibility |
| --- | --- | --- |
| 0.1.0 | Host Operator | Own Host resources, register Projects, configure credentials and automation, and accept high-risk results |
| Later Stage 1 | Automation Operator | Manage queues, budgets, remote Hosts, failure recovery, and unattended policies; may be the same person as the Host Operator |
| Stage 2 | System Operator | Own Managed Systems, business Agent Identities and Profiles, operational state, business work, releases, and recovery |
| Stage 3 | Organization Member | Create, claim, review, and observe Work Items in authorized Projects |
| Stage 3 | Organization Administrator | Manage members, spaces, Project authorization, shared execution resources, and audit policy |

## Stage success criteria

- Stage 1: Saki itself and multiple real development projects can complete daily development, automation, and distributed execution without multiple VS Code windows.
- Stage 2: Persistent Agent Identities with different responsibilities can use multiple Agent Profiles to observe, operate, and recover at least one existing business system and one automation pipeline in Saki, associating business results with a Work Item or direct execution evidence.
- Stage 3: Organization members can use their own GitHub identities in the Web workspace to access personal and organization Projects and share Agent capability supplied by Hosts through a brokered credential boundary without receiving Host credentials.

## Related specifications and gaps

- [Saki 0.1.0 implementation specification](versions/0.1.0.md) defines behavior, scope, failure recovery, and release criteria for the first Stage 1 slice.
- [Work Management domain language](../contexts/work-management/CONTEXT.md) defines Work Items, statuses, Milestones, Releases, and Outcome Evidence.
- [Agent Operations domain language](../contexts/agent-operations/CONTEXT.md) defines Agent Identity, Agent Profile, Project Coordinator, Work Assignment, Work Session, Execution Dispatch, Dispatch Claim, Host Operation, Intervention Request, Attention Inbox, Agent Run, Signal, and Event Subscription.
- [Model Supply domain language](../contexts/model-supply/CONTEXT.md) defines Provider Account Profiles, Credential Protection Levels, Credential Brokers, Model Routes, context limits and policies, Usage Snapshots, and Generation Jobs.
- [Agent three-part model decision](../adr/agent-operations/0001-agent-identity-profile-run.md) records ownership among durable actors, execution configurations, and individual attempts.
- [Work Session and subagent lineage decision](../adr/agent-operations/0002-work-sessions-and-subagent-lineage.md) keeps product collaboration independent from DSH runtime parentage.
- [Control-plane and execution-plane decision](../adr/0004-control-and-execution-planes.md) records the responsibilities of the two planes and how they connect.
- [Durable dispatch, intervention, and attention decision](../adr/0009-durable-dispatch-intervention-and-attention-projections.md) separates accepted work, Host delivery, human response, and projected attention.
- [Fenced idempotent dispatch admission decision](../adr/0010-fenced-idempotent-dispatch-admission.md) defines claim expiry, retry, Host preparation, acceptance, start, and ambiguous-result handling.
- [DPAPI local-user-trust credential decision](../adr/0011-dpapi-local-user-trust-credentials.md) defines the 0.1.0 at-rest protection, explicit same-user limitation, and organization-sharing gate.
- [Forward-migration and Installation-maintenance decision](../adr/0012-forward-migrations-and-installation-maintenance.md) defines state generations, rollback artifacts, encrypted portable exports, and replacement-Host recovery.
- [GitHub synchronization decision](../adr/0013-polling-first-staged-github-synchronization.md) defines complete staged scans, optimistic conflicts, mapping repair, and rate-limit behavior.
- [Resource Binding lifecycle decision](../adr/0014-stable-resource-bindings-over-canonical-worktrees.md) separates stable Project resource identity from canonical worktree location and historical Session paths.
- [Automation budget decision](../adr/0015-reserved-automation-budgets-and-usage-ledger.md) defines typed reservations, settlement, unknown usage, and one-time exceptions.
- The [version 0.1.0 frontend contract](architecture/0.1.0-frontend-contract.md) defines client information and interaction semantics. Frontend work may be pre-split into K0 through K7 to expose ownership and dependencies, but K1 through K7 remain non-Ready and cannot begin production implementation until K0's low-fidelity prototypes receive product approval and the backend Projection and Intent fixtures required by that slice are available. Neither prototypes nor visual review turn the long-term PRD into a fixed page layout.
