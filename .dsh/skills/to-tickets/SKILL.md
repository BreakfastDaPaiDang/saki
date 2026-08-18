---
name: to-tickets
description: Split an approved Saki specification into independently executable tracer-bullet Work Items with explicit dependency edges.
disable-model-invocation: true
metadata:
  saki:
    upstream: https://github.com/mattpocock/skills
    commit: 9c9f36ccd3995266cd675468af71639c8dde1ec5
    dsh-capabilities:
      - read
      - write
      - edit
      - glob
      - grep
    one-of-capabilities:
      - bash
      - pwsh
    optional-capabilities: []
    host-commands:
      - git
      - gh
    mutation: tracker
---

# To tickets

Turn an approved specification into tracer-bullet Work Items. Each Work Item must deliver an observable vertical slice, fit one fresh implementation Session, and name only dependencies that genuinely prevent it from starting.

## DSH compatibility preflight

Before creating or editing any Work Item, perform the complete tracker preflight from `to-spec`: verify the filesystem capabilities, one shell capability, `git`, `gh`, the intended checkout, GitHub authentication, `viewerPermission`, and the repository's current labels. Read `docs/agents/issue-tracker.md` and `docs/agents/triage-labels.md`. Use `-R BreakfastDaPaiDang/saki` on every `gh` command.

Determine before the first create whether the available GitHub API and token can write native dependency relationships. If they cannot, use a `## Blocked by` section with issue references for the entire batch. Do not discover this limitation after creating a partial dependency graph. On any preflight failure, stop without mutation and give the exact corrective action.

## Process

1. Read the full referenced specification, body, comments, context glossaries, and applicable ADRs.
2. Draft narrow end-to-end slices. A completed slice is demonstrable or independently verifiable.
3. Use expand–migrate–contract only for a mechanical change whose callers cannot stay green in vertical slices.
4. Present the proposed Work Items, each with title, outcome, blockers, acceptance criteria, and scope exclusions. Ask the user to approve granularity and dependency edges.
5. Publish blockers first through body files. Add native blocking links when the preflight proved them available; otherwise include stable issue references under `## Blocked by`.
6. Add `ready-for-agent` only to Work Items whose blockers are complete and whose body is self-contained. Leave blocked Work Items without that role until their frontier opens.

Do not close or rewrite the parent specification. Do not publish legacy aliases or call a Work Item a Session, Agent Run, or subagent.
