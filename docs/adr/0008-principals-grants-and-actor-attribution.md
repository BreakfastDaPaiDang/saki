---
status: accepted
---

# Separate Principal identity, Grant authority, and Actor attribution

English | [中文](0008-principals-grants-and-actor-attribution.zh.md)

Saki represents security identity, durable authority, and action attribution as three different concepts. A Principal is a durable subject that can authenticate and receive authority, a Grant is a versioned authorization for a Principal to perform named actions within a resource scope, and an Actor is the immutable attribution snapshot that Saki derives when accepting a Control Intent. Authentication, external credentials, Automation Policy, and Agent execution state do not substitute for any of these concepts.

## Why this decision

Version 0.1.0 has one Host Operator, but the same development loop already contains several identities: the person using the Web client, automatic Project work, a one-off Agent Run, a future durable Agent Identity, a GitHub App installation, the credential used by Git, and the Commit author. Treating the current operator as all of them would make historical attribution depend on a temporary single-user deployment and would force a later multi-user system to reinterpret existing records.

Authentication answers who established a session; authorization answers what that identity may do; attribution answers who exercised authority for one accepted action. These facts change at different times. A user can link another login without gaining more access, a Grant can be revoked without rewriting historical actions, and an automatic action can use an external App credential without pretending that the App chose the work.

Automation Policy also has a different responsibility from a Grant. A Grant establishes the security ceiling: permitted actions, resource scope, expiry, and delegation. Automation Policy decides when work is eligible, which budgets and evidence apply, and when execution must pause. Requiring both prevents a Project configuration, Signal, or model output from creating its own authority.

The Actor must be constructed inside the trusted control plane. Accepting a caller-supplied Actor or inferring authority from a browser payload, Session lineage, Agent object, GitHub organization membership, or possession of a credential would turn provenance into permission and make non-escalation unenforceable.

## Considered options

**Use one user or account record for identity, permission, and attribution.** This fits the first Host Operator but cannot represent automatic work, delegation, linked identities, external execution credentials, or actions whose authority has since been revoked.

**Use Automation Policy as the authorization record.** Policy can decide when to act, but allowing it to mint its own permissions makes editing a trigger equivalent to granting Host or Project access. Policy must operate within authority granted by a Principal.

**Create a new Principal for every Agent Run.** A disposable run has no independent continuing identity and would create large numbers of meaningless security records. A one-off Run instead uses a bounded delegated Grant and appears in the Actor chain; a durable Agent Identity may be backed by a Principal.

**Grant access directly from GitHub organization membership.** Membership is useful identity evidence and may inform an administrative policy, but it does not express access to a local Host, private Project, model account, or execution budget. Linking a GitHub identity therefore authenticates a Principal without directly creating Host authority.

**Trust an Actor supplied by the client or adapter.** A browser, Agent, webhook, or external adapter could then claim another identity or omit its delegation chain. The control plane derives Actor from authenticated context and current Grants instead.

**Build a complete role hierarchy or general policy language in version 0.1.0.** The first release needs scoped, versioned Grants and explicit delegation, not a second general IAM product. Named roles may later present or provision Grant sets without becoming another authority engine.

## Consequences

A Principal is a stable Saki security subject. Initial Principal forms are a human, a durable Agent Identity, and one Project Automation Principal per Project that uses automatic mode. Host identity remains separate machine authentication, and external provider accounts or GitHub App installations remain credential identities rather than product decision-makers.

A Grant records its issuer, subject Principal, allowed actions, resource scope, validity, delegation limit, parent Grant when delegated, revision, and revocation state. Delegation can only narrow the parent Grant. A role such as Host Operator is a product-facing way to provision Grants; it is not a parallel authorization system.

The control plane derives an Actor when it accepts a Control Intent. The Actor records the effective Principal, original initiator, delegation chain, Grant identifiers and revisions, authentication context, and applicable Automation Policy or Agent Run references. Clients may request an action but cannot provide trusted Actor or Grant fields. Historical Actor data remains unchanged when identities are relinked or Grants are later revoked.

Grant revocation blocks new Intents, new delegation, and any not-yet-started external effect that requires the revoked authority. It does not block inspection, cancellation, reconciliation, or compensation needed to make an already possible external effect safe. Active execution checks revocation at capability boundaries instead of treating an admission-time snapshot as permanent authority.

Signals carry provenance but no authority. A Project Automation Principal needs both an explicit Grant and a satisfied Automation Policy before it can submit an Intent. A one-off Agent Run receives only a delegated subset of its initiating Principal's authority and cannot grant itself or a child more access. A durable Agent Identity may receive its own Grants, but its model output never changes them directly.

Version 0.1.0 bootstraps one local human Principal and Host Operator Grant with a short-lived, single-use secret conveyed through the local launch flow. The secret is exchanged for a server-side Web session represented by an HttpOnly, SameSite cookie; it is not a password database, query-string credential, or durable Grant. The loopback server validates the request origin and protects state-changing requests from forgery. Non-loopback identity, TLS termination, and multi-user session administration remain outside the release.

A later GitHub login links an external identity to a human Principal. GitHub organization membership may be evaluated when an administrator provisions Grants, but login alone grants no Host, Project, model-account, or filesystem authority. For an external mutation, audit records preserve both the Saki Actor that chose the action and the external App or user credential that performed it.
