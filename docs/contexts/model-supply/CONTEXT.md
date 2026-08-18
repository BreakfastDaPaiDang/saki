# Model Supply

English | [中文](CONTEXT.zh.md)

Model Supply defines how Saki names external model accounts, resolves models for executions, manages usable context, and records generated-media work.

## Language

**Provider Account Profile**: A named reference to one account at one model provider, together with observable authentication, entitlement, usage, health, and capability metadata. Raw credentials remain in the credential store, and the profile does not combine allowances across accounts. _Avoid_: account pool, model provider

**Credential Protection Level**: A declared classification of which identities and processes may recover the raw credential behind a Provider Account Profile. `local-user-trust` trusts processes running as the Host OS user and must not be presented as Agent-process isolation. _Avoid_: Grant, credential health

**Credential Broker**: A credential authority outside the Agent execution identity that supplies provider access without exposing raw values to Agent processes. _Avoid_: credential store, Provider Account Profile

**Model Route**: The provider, model, reasoning configuration, and Provider Account Profile selected for an Execution. An Agent Profile may request a route, while the Execution records the route actually resolved. _Avoid_: Agent Profile, model account

**Context Capacity**: The maximum context window advertised by the underlying model independently of a product surface, subscription, or account allocation. _Avoid_: Runtime Context Limit, compaction threshold

**Runtime Context Limit**: The usable context limit exposed to a particular Provider Account Profile and runtime surface. It may be lower than Context Capacity because of product configuration, subscription, or provider policy. _Avoid_: Context Capacity, compaction threshold

**Context Policy**: A named, versioned policy for measuring, compacting, pruning, restoring, and observing Session context against a Runtime Context Limit. Its compaction threshold is configuration rather than a model property. _Avoid_: context window, Context Capacity

**Usage Snapshot**: A provider-attributed, point-in-time observation of allowance windows, remaining usage, credits, and retrieval status for one Provider Account Profile. It is not a Saki-owned balance or authorization to exceed provider limits. _Avoid_: quota balance, shared allowance

**Generation Job**: A traceable request to generate or edit media through a resolved Model Route. It records inputs, status, outputs, and provenance and may attach its artifacts to a Work Session or Work Item. _Avoid_: Agent Run, image message
