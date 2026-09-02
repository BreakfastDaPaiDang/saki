# `@breakfastdapaidang/saki-tool-intervention`

English | [中文](README.zh.md)

Private model-facing `request_intervention` tool for Saki Development Agents. It creates a durable operator question through `ctx.sakiControlPlane` instead of suspending a live question Promise.

## Tool

`request_intervention` accepts one required `question` string. The control plane validates a non-empty, well-formed value of at most 4,096 characters, commits or exactly reuses an `opening` Intervention Request, and returns its stable id. Only durable success concludes the current turn and renders compact JSON in the exact shape `{"interventionId":"<id>"}`; a rejection returns a tool error without concluding the turn.

After the canonical tool result and balanced turn are present, the plugin flushes the Session and asks the control plane to finalize the opening. A transient failure schedules one local retry after `openingRecoveryRetryDelayMs` (default 1,000 ms); a new balanced turn may wake the same pending work sooner. The retry is only a wake-up hint: the control plane, Local Host, and Session persistence own evidence inspection and recovery, while this package retains no answer or authority state.

## Role

This package is the Development Agent Consumer for Saki Intervention Requests. The product Host composes it inside the system-owned Development Agent Preset. Generic DSH question and approval tools remain live interactions and are not replaced.

## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`request_intervention` schema](../../../docs/tool-catalog.md#breakfastdapaidangsaki-tool-intervention) with a required text question. Its description states that durable success ends the turn and that the answer arrives later in the same Agent Run.

#### Token effect

The fixed schema adds a small token cost to each Development Agent request where the tool is visible.

#### KV Cache effect

The schema remains prefix-stable while the Development Agent Preset and tool definition are unchanged.

### Tool-call history, result, and answer

#### What the model sees

The question remains in the assistant tool-call arguments and the successful tool result contains only the Intervention id. The operator answer is not a replacement tool result: after durable acceptance, Saki appends an attributed user message to the same Session through a new Execution Dispatch.

#### Token effect

The question, compact id result, and later answer are data-dependent retained tokens. Waiting for the operator performs no model request.

#### KV Cache effect

The later answer is append-only Session input after the reusable prefix. Ending the question turn prevents later assistant output from being generated as though the missing answer already existed.

## Known Limitations and Deferred Work

- **Text input only** — the request declares one bounded text answer; approvals, credential authorization, acceptance, and structured choices require adjacent product schemas.
- **One blocking question per Agent Run** — parallel open questions conflict; the accepted-answer handoff may retain one successor `opening` while the preceding answer is delivered.
- **Saki Agent context required** — calls outside an active Saki-owned Agent Session fail without creating a request.
