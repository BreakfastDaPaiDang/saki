---
name: to-spec
description: Synthesize the settled conversation into a Saki specification and publish it to the configured GitHub repository.
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

# To spec

Synthesize the current conversation and repository state. Do not restart the requirements interview. Use the canonical terms from `CONTEXT-MAP.md` and the relevant context glossaries, and honor applicable ADRs.

## DSH compatibility preflight

Perform this preflight before writing a local artifact or changing GitHub:

1. Confirm `read`, `write`, `edit`, `glob`, and `grep`, plus one of `bash` or `pwsh`.
2. In PowerShell, resolve `git` and `gh` with `Get-Command`; in Bash, use `command -v`.
3. Run `git rev-parse --show-toplevel` and confirm this is the intended checkout.
4. Run `gh auth status`, `gh repo view -R BreakfastDaPaiDang/saki --json viewerPermission`, and `gh label list -R BreakfastDaPaiDang/saki --limit 200`.
5. Read `docs/agents/issue-tracker.md` and `docs/agents/triage-labels.md`.

If any check fails, stop before mutation and report the missing capability, command, authentication, repository permission, or label. Never publish a partial specification. Every `gh` command for this repository must include `-R BreakfastDaPaiDang/saki`.

## Specification

Produce one issue with these sections:

1. **Problem statement** — the user's problem and observable impact.
2. **Outcome** — the user-visible result, without implementation choreography.
3. **User stories** — numbered actors, outcomes, and benefits covering normal, failure, recovery, and permission cases.
4. **Implementation decisions** — agreed module responsibilities, public interfaces, data and API obligations, and relevant ADR links. Do not include volatile line numbers.
5. **Testing decisions** — observable behaviors, public interfaces, prior repository examples, and required assembled evidence.
6. **Out of scope** — explicit exclusions.
7. **Open questions** — only genuinely unresolved decisions; omit the section when empty.

Confirm that the synthesis matches the settled conversation before publishing. Publish through a body file with `gh issue create -R BreakfastDaPaiDang/saki`. Apply `ready-for-agent` only when the issue is independently implementable and unblocked; otherwise use the repository's current triage role.
