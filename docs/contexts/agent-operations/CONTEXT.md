# Agent Operations

English | [中文](CONTEXT.zh.md)

Agent Operations defines how one Saki Installation directs enrolled Hosts and names persistent Agent actors, reusable execution configuration, individual attempts, and incoming facts.

## Language

**Saki Installation**: The stable, migratable identity and product namespace of one active Saki control plane. It may enroll multiple Saki Hosts, but it is neither a machine nor a Host and version 0.1.0 permits only one active writer. _Avoid_: Saki Host, process, deployment

**Saki Host**: An enrolled execution node with a stable Host identity, trust state, revalidated capability inventory, and ownership of machine-local resources and credential resolution. A Local Host may share a process with the control plane without becoming the Saki Installation. _Avoid_: Saki Installation, browser client, Workspace

**Resource Binding**: A stable association from a Project to one resource on a named Saki Host. Its revisioned locator and health observation may change through rebind, while its identity owns execution references and leases. _Avoid_: path, DSH Workspace, Execution Lease

**Installation State Generation**: A complete, versioned copy of Saki-owned Installation state. Exactly one generation is selected as active and writable; candidates, retained generations, and Recovery Backups never become active by filename or recency. _Avoid_: database version, backup

**Recovery Backup**: An exact local rollback artifact for one Installation State Generation and its compatible Saki build. It does not claim portability to a replacement Host. _Avoid_: Installation Export, snapshot

**Installation Export**: An encrypted, versioned portable archive of declared Saki-owned state and explicitly included portable dependencies. Restore validates and rebinds it rather than treating copied local paths, credentials, or processes as Host authority. _Avoid_: Recovery Backup, data-directory copy

**Principal**: A durable Saki security subject that can authenticate and receive Grants. A human, durable Agent Identity, or Project automation identity may back a Principal; a Web session, Host, or provider credential does not. _Avoid_: Actor, account, session

**Grant**: A versioned authorization issued to a Principal for named actions within a resource scope and delegation limit. It establishes a security ceiling, not a trigger or evidence rule. _Avoid_: Automation Policy, credential, role

**Actor**: The immutable attribution of an accepted action, derived from authenticated Principal, delegation, and Grant facts at that time. It explains who exercised authority and on whose behalf; it neither authenticates nor grants access. _Avoid_: Principal, Host Operator, caller payload

**Project Automation Principal**: A Principal that represents one Project's automatic mode and can act only through explicit Grants plus a satisfied Automation Policy. It is not the policy itself or the Host Operator. _Avoid_: Automation Policy, system user

**Automation Policy**: A versioned Project policy that decides when automatic work may use existing Grants, which reservations and evidence it requires, and when it must pause. It cannot create authority. _Avoid_: Grant, trigger, account quota

**Automation Budget Reservation**: A durable, idempotent allocation of typed resource limits for one admitted automatic operation before its external effects. Unknown outcome remains reserved until inspection or intervention. _Avoid_: Usage Snapshot, estimate, Grant

**Usage Ledger Entry**: An attributed record of measured, estimated, corrected, released, or unresolved resource use linked to its evidence source. It accounts for automation without becoming the provider's balance. _Avoid_: Usage Snapshot, invoice

**Agent Identity**: A durable, addressable Agent actor that may own continuing responsibility, an inbox, long-term memory, and history across executions. It states who continues the work, not how one attempt is configured. _Avoid_: Agent Profile, Agent Session

**Work Assignment**: A durable responsibility relation between a Work Item and the human Principal, Agent Identity, or Project Automation Principal expected to carry it forward. It neither grants authority nor starts an Execution. _Avoid_: Agent Run, Grant

**Agent Profile**: A named, reusable, versioned execution configuration that declares role instructions, context sources, requested tools and permissions, model routing, budgets, and compatible trigger types. It states how an Agent Run works, not who owns continuing responsibility. _Avoid_: Agent Identity, Agent Preset

**Execution**: One traceable attempt performed by an Agent, workflow, schedule, or event-driven process. Completion of an Execution does not by itself prove acceptance or a business result. _Avoid_: Work Item, Session

**Agent Run**: An Execution performed by an Agent. It records the actual Agent Profile version and may refer to an Agent Identity when a durable actor owns the work. _Avoid_: Agent Session, Agent Identity

**Control Intent**: A durable, idempotent request admitted under an Actor and Grants to change Saki state or invoke external work. It records the requested action, attribution, and recovery outcome; it is neither evidence that the action succeeded nor authority inferred from a Signal. _Avoid_: Signal, Execution, Grant

**Execution Dispatch**: A durable instruction produced from an accepted Control Intent for an enrolled Host to create or resume one Execution. It records delivery and recovery state, not proof that the Execution succeeded. _Avoid_: Control Intent, Agent Run

**Dispatch Claim**: A bounded, revisioned, and fenced claim that lets one current executor coordinate Host admission of an Execution Dispatch. It is not an exactly-once guarantee and grants no Resource Binding access. _Avoid_: Execution Lease, Work Assignment

**Host Operation**: A durable Host-owned admission record for one Execution Dispatch. It binds the stable dispatch identity to the intended Execution before external effects and supplies an idempotent inspection and cancellation reference; it is not the Execution outcome. _Avoid_: Execution Dispatch, Agent Run, process

**Execution Lease**: A durable claim that grants one Agent Run writable access to a Resource Binding. At most one active writable Agent Run holds a binding's lease; read-only Sessions do not require it. _Avoid_: process lock, Agent Run

**Intervention Request**: A durable, addressable request for specified input, approval, credential authorization, acceptance, or recovery action. A response is attributed separately and cannot expand the responder's Grants. _Avoid_: live question, notification

**Attention Inbox**: A projection of unresolved Work Assignments, Intervention Requests, recovery states, and relevant Signals for one Principal or Agent Identity. It neither owns those facts nor acts as an execution queue. _Avoid_: Work Management Inbox, mailbox, queue

**Project Coordinator**: A Project role held by an Agent Identity that routes and supervises work across Work Items. Its responsibility persists across replaceable Coordination Sessions. _Avoid_: main Session, project Session

**Coordination Session**: A replaceable Session through which a Project Coordinator plans, delegates, and follows up on Project work. It does not own Project state or continuing responsibility. _Avoid_: Agent Identity, permanent Session

**Work Session**: A durable, user-visible collaboration conversation scoped to one Work Item. A Work Item may have multiple Work Sessions but designates at most one as primary; each remains addressable across Agent Runs and coordinator replacement while preserving attributed participation. _Avoid_: Agent Run, subagent

**Signal**: An attributed point-in-time fact produced by a person, machine, or Agent. A Signal supplies information but grants no authority to execute. _Avoid_: Work Item, command

**Event Subscription**: A durable Project subscription that selects external events and normalizes them into attributed Signals. Automation Policy decides the effects of those Signals. _Avoid_: scheduled task, Automation Policy
