---
status: accepted
---

# Use one active Saki Installation with enrolled Hosts

English | [中文](0007-single-control-plane-and-enrolled-hosts.zh.md)

A Saki Installation is the stable, migratable identity and product namespace of one active control plane. An Installation may enroll multiple Saki Hosts, but version 0.1.0 supports only one active control-plane writer and one co-located Local Host. Co-location is a deployment choice, not an identity merge: the Installation and Host retain separate stable identifiers, records, and responsibilities.

## Why this decision

Saki starts on one Windows machine, but Project state must survive moving to a new machine and later dispatch work to remote machines or servers. Treating the current process, filesystem root, device, and product identity as one object would embed local paths and credentials into control-plane records. Migration would then resemble cloning a live system, and adding a remote executor would force every Project and authorization rule to learn about transport.

The control plane and execution plane also have different trust responsibilities. The control plane owns product policy, assignment, recovery, and durable projections. A Host owns machine-local capability Providers, resources, live processes, and raw credential resolution. Browser clients, GitHub users, organization members, repository content, model output, and external event payloads do not become trusted merely because they can reach either plane.

Cordis lifecycle management can revert effects made through its context, but it is not a sandbox for code loaded into the Host process. An installed Cordis or npm plugin can access the process and operating-system authority available to that Host. Dynamic model-generated plugins therefore cannot be promoted from disposable execution material into persistent Host plugins without an explicit operator review and installation step.

Active-active control planes would require distributed leader election, fencing, durable leases, conflict resolution, and external-effect coordination before Saki has a second deployment target. Those mechanisms do not improve the first local development loop. A single active writer preserves deterministic ownership now while keeping the Installation identity independent from the machine that currently runs it.

## Considered options

**Make the current machine or process the Saki identity.** This is initially simple, but it makes backup restoration, machine replacement, and remote execution ambiguous and encourages Host paths and credentials to leak into portable records.

**Run multiple active control-plane replicas.** This improves availability only after Saki owns distributed fencing and consistency. Without those mechanisms, two replicas could claim one worktree, duplicate an external mutation, or diverge on policy state.

**Treat every browser or user device as a Host.** A client can request and observe work, but it does not thereby own an enrolled execution environment, capability inventory, or credential boundary. Conflating the two would grant resource authority through UI reachability.

**Treat plugins as isolated extensions.** Cordis scopes lifecycle and dependency access; it does not prevent arbitrary same-process code from using Node or operating-system APIs. Describing installed plugins as untrusted would promise a security boundary that does not exist.

**Split the planes into network services immediately.** This would introduce enrollment transport, authentication, delivery, and partial-network failure before a second Host exists. Stable identities and the Host Execution seam preserve that option without premature deployment complexity.

## Consequences

The control plane persists a stable Installation identity and a Host registry. Each Host has a stable Host id, enrollment and trust state, and a revalidated capability inventory. Resource Bindings and Host operations identify their owning Host rather than relying on an implicit local machine or an absolute path as global identity.

Raw secrets remain with a capability Provider on a Host. The control plane may persist opaque credential references, capability and health state, attributed usage, and routing decisions, but not secret values. Moving an Installation therefore requires an explicit backup, restore, and Host re-enrollment procedure; copying the data directory does not silently make two active writers supported.

The portable path is the encrypted Installation Export defined by [ADR 0012](0012-forward-migrations-and-installation-maintenance.md), not a live data-directory copy. Replacement restore retains the Installation id, creates a new Host id, and requires resource rebinding, credential reauthorization, unresolved-operation reconciliation, and old-Host retirement before automatic work resumes.

Version 0.1.0 binds the Web surface to loopback by default and bootstraps one local Host Operator. It does not obtain multi-user safety merely by adding GitHub login or exposing the port. Principal identity, grants, browser-session security, and deliberate non-loopback deployment remain separate decisions.

Installed Host plugins are privileged trusted code. Model-generated dynamic plugins remain ephemeral execution material unless the operator reviews and promotes them through the normal installation path. Repository content, model output, browser payloads, and external events remain untrusted inputs even when processed by a trusted plugin.

The initial Installation, control plane, and Local Host may still run in one process and one plugin composition. This decision creates logical ownership and durable identities, not microservices. A future remote node joins as an enrolled Host through an authenticated Host Execution Provider; active-active control planes require a new ADR.
