---
name: ask-matt
description: Route Saki development work through the repository-owned planning, implementation, review, and handoff skills.
disable-model-invocation: true
metadata:
  saki:
    upstream: https://github.com/mattpocock/skills
    commit: 9c9f36ccd3995266cd675468af71639c8dde1ec5
    dsh-capabilities:
      - skill
    one-of-capabilities: []
    optional-capabilities: []
    host-commands: []
    mutation: none
---

# Ask Matt

Route the user's request through the smallest repository-owned development flow that completes it. Load a model-invocable selection with the DSH `skill` capability. For a user-only selection, name its exact `/skill` command and stop; never imitate its instructions.

## DSH compatibility preflight

Before taking another action, confirm that the `skill` capability is available. If it is absent, stop and say: "This flow requires the DSH skill capability. Select a Saki development preset that includes skill discovery and retry."

## Main flow

1. Use `grill-with-docs` when an idea or design still has unresolved decisions.
2. Use `to-spec` once the conversation contains enough settled requirements for a durable specification.
3. Use `to-tickets` after the specification is approved and needs independently executable Work Items with explicit blockers.
4. Use `implement` for one approved Work Item or small agreed change. It loads `tdd` for implementation and `code-review` before completion.
5. Use `handoff` when work must move to another Session, harness, person, or working directory.

Incoming, underspecified Issues enter through `triage`. Use `domain-modeling` directly when the disagreement is about Saki terminology or an architectural decision, `tdd` for an already concrete behavior, and `code-review` for an existing diff against a fixed point.

Do not route to skills outside this pack. Read [PHASE-BOUNDARIES.md](PHASE-BOUNDARIES.md) when choosing whether to continue, delegate, start a fresh Session, or write a handoff.
