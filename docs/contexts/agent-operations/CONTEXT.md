# Agent Operations

English | [中文](CONTEXT.zh.md)

Agent Operations defines how Saki names persistent Agent actors, reusable execution configuration, individual attempts, and incoming facts.

## Language

**Agent Identity**: A durable, addressable Agent actor that may own continuing responsibility, an inbox, long-term memory, and history across executions. It states who continues the work, not how one attempt is configured. _Avoid_: Agent Profile, Agent Session

**Agent Profile**: A named, reusable, versioned execution configuration that declares role instructions, context sources, requested tools and permissions, model routing, budgets, and compatible trigger types. It states how an Agent Run works, not who owns continuing responsibility. _Avoid_: Agent Identity, Agent Preset

**Execution**: One traceable attempt performed by an Agent, workflow, schedule, or event-driven process. Completion of an Execution does not by itself prove acceptance or a business result. _Avoid_: Work Item, Session

**Agent Run**: An Execution performed by an Agent. It records the actual Agent Profile version and may refer to an Agent Identity when a durable actor owns the work. _Avoid_: Agent Session, Agent Identity

**Signal**: An attributed point-in-time fact produced by a person, machine, or Agent. A Signal supplies information but grants no authority to execute. _Avoid_: Work Item, command

**Event Subscription**: A durable Project subscription that selects external events and normalizes them into attributed Signals. Automation Policy decides the effects of those Signals. _Avoid_: scheduled task, Automation Policy
