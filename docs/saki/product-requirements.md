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

A revalidatable association between a Project and an external or local resource. Resources may include a Workspace, Git worktree, GitHub Repository, GitHub Project, deployment environment, service, database, messaging channel, or specialized tool; Saki stores the association and access method without copying the full data owned by the resource.

### Agent Identity

A durable Agent actor that can receive continuing responsibility and follow-up work while retaining history across Executions. An Agent Identity may own an inbox, responsibility scope, and long-term memory, but does not determine the configuration or location of a particular attempt.

### Agent Profile

A named, reusable, versioned Agent execution configuration within a Project. An Agent Profile declares role instructions, context sources, requested tools and permissions, model routing, budgets, and permitted trigger types; it determines how an Agent works without owning continuing responsibility. Every Agent Run records the Profile version actually used.

### Work Item

A unit of intended work with an explicit outcome and acceptance criteria. Its shared carrier may be a GitHub Issue or a later business system, while Saki organizes it with consistent Work Item Status, Blockage, and Milestone semantics.

### Execution

One traceable attempt performed by an Agent, workflow, or scheduled task. Agent Run is the first Execution type; later types may include Scheduled Run, Event-triggered Run, and distributed Run. Execution is separate from Work Item Status, and successful exit does not mean the work has been accepted.

### Outcome Evidence

A locatable fact that demonstrates whether Work Item acceptance criteria or a business result have been satisfied, such as a Diff, test result, Commit, PR, CI result, Release, deployment status, log, or business metric. Automatic completion must rely on Outcome Evidence rather than an Agent's self-reported success.

### Automation Policy

A Project configuration for triggers, resource limits, concurrency, permissions, pause conditions, delivery operations, and evidence required for automatic completion. Automation level is an explicit choice for each Project, not a hidden global switch.

### Signal

An attributed point-in-time fact produced by a person, machine, or Agent, such as a manual assignment, timer expiry, state alert, external event, Work Item change, Agent handoff, or Execution result. Event Subscription normalizes matching external events into Signals; a Signal supplies information but grants no execution authority.

### Event Subscription

A durable Project subscription to an external event source that declares the source, filters, deduplication, and ownership of generated Signals. It does not start an Agent directly; Automation Policy decides whether a Signal updates state, notifies a person, appends to existing work, creates a Work Item, or starts an Execution.

### View

A projection that provides a particular information density and set of operations over the same Project data. Board, Milestone View, Development Workspace, Operations Cockpit, operator console, and organization-member inbox may serve different decisions and preferences without becoming new authoritative data sources.

### Saki Host

A device that runs Saki capabilities and owns local files, processes, credential references, and execution resources. A Project may progressively gain multiple Hosts or remote execution targets, but resource location and execution ownership must remain visible.

The core relationships are `Project -> Work Item -> Execution -> Outcome Evidence` and `Project -> Agent Identity -> Agent Run -> Outcome Evidence`. Agent Identity is an optional owner of continuing responsibility, while every Agent Run fixes the Agent Profile version actually used. Resource Binding determines what a Project can access, Signal supplies facts about change, Automation Policy determines when execution is allowed, and View determines how people observe and intervene.

## Traceable Project operational graph

Saki uses one traceable relationship graph to connect product intent, Work Items, Signals, Agent Identities, Agent Profile versions, Executions, resource changes, and Outcome Evidence. Stage 1 exposes a relatively complete graph and evidence chain to development operators for debugging, recovery, review, and automation. Later stages retain those relationships while Views primarily show daily operators, organization members, and request-only participants the Board, tasks, state, and areas requiring intervention.

The Project operational graph provides explanation and recovery capability; it does not require every user to operate a graph interface. A dense operator console, project asset overview, Agent-run supervision, member inbox, and simplified Board all project the same domain facts, and the product does not assume one universal home page.

## Control plane and execution plane

The control plane owns Project registration, Resource Binding metadata, Work Item projections, Agent Identities, Agent Profiles, Signal routing, Automation Policies, queues, scheduling, Execution assignment, run-history projections, and audit relationships. It decides what work should execute under which conditions, but does not directly hold working directories, processes, model Sessions, or credential contents.

The execution plane resides on a Saki Host or later remote execution target and owns Workspace resolution, actual Git worktree state, DSH Sessions, terminals and processes, tool and model invocation, credential-reference resolution, and Host capability state. It changes real resources within an authorized Execution and reports attributed progress, results, and Outcome Evidence; it does not choose Project priorities, create unbounded follow-up work, or widen permissions by itself.

The two planes connect through a stable Execution interface: the control plane sends an execution request containing the Project, trigger source, Profile version, resource requirements, limits, and grants, and the execution plane returns state events, interaction requests, results, and evidence references. Version 0.1.0 may co-locate both in one process and repository, but a Web View or control logic may not bypass the interface to operate Host resources directly. A network transport adapter is added only when a second real remote implementation exists, rather than introducing microservices in the first version. See [ADR 0004](../adr/0004-control-and-execution-planes.md).

## Signal transport and collaboration

External-platform events, timer expirations, Host state, human operations, and Agent outputs first pass through a source Adapter and become attributed Signals; they do not enter model context or start execution directly. A Signal stores at least a stable identifier, source, occurrence and receipt times, Project ownership, deduplication key, related subject, causal relationship, and payload reference so Saki can replay, reconcile, and trace chained behavior.

Automation Policy may choose five classes of effect for a Signal: update only a Project read model; notify a person or Agent Identity; associate the new fact with an existing Work Item or Execution; create a Work Item when there is a continuing expected outcome, human collaboration, or acceptance requirement; or start an Execution directly when the work is bounded and authorized. A routine scheduled check can therefore produce only an Execution and Outcome Evidence, escalating to a Work Item only when it finds an anomaly or needs coordination.

Agent handoffs also produce Signals attributed to an Agent Identity and Agent Run with a causal relationship, rather than using a private message channel that can widen authority directly. Signal routing must handle duplicate events, event storms, and Agent loops; a subsequent Agent may be invoked only within causal-depth, concurrency, cost, and time limits granted by Automation Policy.

## Product principles

### Work must leave an evidence chain

A PRD or specification preserves product intent, a Work Item preserves atomic work, a PR preserves implementation discussion, and CI, Release, deployment, or business metrics preserve delivery facts. Saki connects these records and does not treat chat history as the sole source of facts.

### Automation requires progressive authorization

Ready means only that a Work Item can be claimed. Manual mode requires an operator to trigger and accept work; automatic mode may claim, commit, deliver, and mark Done automatically, but each capability requires Automation Policy authorization and must stop in an explainable, recoverable state on failure.

### Authoritative sources must be explicit

Git, GitHub, DSH Sessions, and business systems continue to own their respective data. Saki owns only Project associations, Execution associations, Automation Policies, and necessary caches; every View must display data sources, synchronization time, and failure location.

### Agent context must attribute its sources

Agent context may combine an Agent Identity's continuing responsibilities and memory, an Agent Profile's role instructions and context recipe, the Workspace `AGENTS.md`, a Work Item, system state and alerts, historical Outcome Evidence, and handoff information from other Agents. Every model-visible input must identify its source and be written to a recoverable Session record; Signals and Agent messages cannot become hidden instruction channels that bypass Automation Policy.

### Plugin-first, single-repository-first

Saki capabilities should form replaceable modules through DSH bundles, Service Definitions, Providers, and Consumers, but remain in the single Saki repository by default at the current stage. A repository is split only when its interface, users, maintainers, release cadence, or security lifecycle is independent. See [ADR 0002](../adr/0002-plugin-first-single-repository.md).

Coupling is measured by whether a change remains inside the module that owns it, not by the number of directories or repositories. Real variation points such as Resource Adapter, Signal Source, and Execution Provider should be replaceable through narrow interfaces; Saki does not publish hypothetical plugin interfaces when only one implementation exists. The ability to split a capability into another repository later without changing product semantics is evidence that the module is sufficiently independent, not a present requirement.

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
3. **Autonomous development orchestration**: Add Signal ingestion, event triggers, scheduled tasks, queues, budgets, concurrent worktrees, automatic acceptance, and failure recovery so multiple projects and Agent Profiles can progress continuously.
4. **Distributed development execution**: Dispatch Executions to different Hosts or remote environments with Host availability, project migration, resource matching, and recoverable scheduling.

Stage 1 is complete when one operator can plan, execute, automate, and observe multiple software projects in Saki and run work safely across local or remote execution resources; multi-user login and organization authorization are not required.

### Stage 2: Business systems and business Agent platform

Stage 2 registers developed or existing business systems as Managed Systems and extends the Stage 1 development Agent platform into a business Agent platform. Through Resource Bindings, Saki connects running services, deployment environments, databases, messaging platforms, content pipelines, scheduled tasks, and specialized tools, while an Operations Cockpit presents health, pending work, Agent Profiles, automation, events, logs, and business results together.

A Development Agent usually receives context from a Workspace, `AGENTS.md`, a Work Item, and repository state; a business Agent may also read human-authored responsibilities and runbooks, current Managed System state, alerts, business metrics, historical Executions, and relevant people. Business Agents that continuously own on-call, operations, content-production, or approval responsibilities are Agent Identities; they may select different Agent Profiles by work type and share a Project and some Resource Bindings while retaining separate inboxes, responsibilities, and continuous histories.

Human input enters through responsibilities, runbooks, Work Items, and explicit instructions; machine input produces Signals through scheduled tasks, state alerts, and event subscriptions; other Agents collaborate through attributed handoff Signals and Outcome Evidence. Automation Policy determines whether a Signal creates a Work Item, starts a particular Agent Profile, appends context to an existing Execution, or requests human action, and an Agent cannot gain more authority merely by receiving a message from another Agent.

The business Agent platform provides at least Agent Identities and inboxes, Agent Profile management, context-source composition, Event Subscriptions, Signal routing, execution queues, permissions and budgets, Agent handoffs, Outcome Evidence, and run observation. Agent Profiles may reuse DSH per-session Agent Presets; Saki does not create another model loop but owns the product relationships between Projects and those runtime capabilities.

Stage 2 is complete when an operator can manage both project code and operational reality in Saki and connect existing systems such as `feishu-bot`, automated tools, and content or video pipelines to a unified observation, Agent-execution, and operation loop; it may remain a single-user product.

### Stage 3: Organization work system

Stage 3 makes the Web application the primary workspace for organization members and adds GitHub-identity login, personal and organization spaces, project discovery and authorization, roles and audit, shared Agent supply, resource quotas, collaborative Work Items, reviews, and approvals. Organization members access Projects with their own identities, automation uses separate machine identities, and nobody needs access to the Host Operator's model credentials or subscription session.

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
- Stage 3: Organization members can use their own GitHub identities in the Web workspace to access personal and organization Projects and share Agent capability supplied by Hosts without sharing Host credentials.

## Related specifications and gaps

- [Saki 0.1.0 implementation specification](versions/0.1.0.md) defines behavior, scope, failure recovery, and release criteria for the first Stage 1 slice.
- [Work Management domain language](../contexts/work-management/CONTEXT.md) defines Work Items, statuses, Milestones, Releases, and Outcome Evidence.
- [Agent Operations domain language](../contexts/agent-operations/CONTEXT.md) defines Agent Identity, Agent Profile, Execution, Agent Run, Signal, and Event Subscription.
- [Agent three-part model decision](../adr/agent-operations/0001-agent-identity-profile-run.md) records ownership among durable actors, execution configurations, and individual attempts.
- [Control-plane and execution-plane decision](../adr/0004-control-and-execution-planes.md) records the responsibilities of the two planes and how they connect.
- Frontend information architecture, interaction prototypes, and the visual system do not yet have a separate design specification; key flows must be completed before splitting 0.1.0 implementation Issues, but the current PRD does not lock page layout early.
