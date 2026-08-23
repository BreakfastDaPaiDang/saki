---
status: accepted
---

# Separate the control plane from the execution plane

English | [中文](0004-control-and-execution-planes.zh.md)

Saki separates product decisions from resource execution through logical control and execution planes. The control plane owns Project intent, policy, routing, assignment, and durable projections; the execution plane owns Host-local resource access and performs bounded work through DSH. Version 0.1.0 co-locates both planes in one process and repository but connects them through an Execution interface.

## Considered options

Allowing product views and orchestration to call local Git, files, processes, credentials, and Sessions directly is initially simpler but makes remote Hosts, migration, recovery, and resource ownership cross every caller. Splitting network services immediately would add transport, deployment, and failure modes before a second execution implementation exists. Logical separation preserves one implementation now and permits a network adapter when remote execution becomes real.

## Consequences

The control plane sends execution requests that identify the Project, trigger, Profile version, resource requirements, limits, and grants. The execution plane reports attributed status events, interaction requests, results, and Outcome Evidence without mutating control-plane projections directly. Host paths, live handles, and credential contents remain in the execution plane; while disconnected it may continue only previously assigned work or an explicitly delegated offline policy, and locally buffered facts reconcile after connectivity returns.
