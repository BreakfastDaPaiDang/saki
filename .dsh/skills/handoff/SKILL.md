---
name: handoff
description: Write a portable, repository-local handoff for another Saki Session, harness, person, or working directory.
argument-hint: What will the receiving Session do?
disable-model-invocation: true
metadata:
  saki:
    upstream: https://github.com/mattpocock/skills
    commit: 9c9f36ccd3995266cd675468af71639c8dde1ec5
    dsh-capabilities:
      - read
      - write
    one-of-capabilities: []
    optional-capabilities: []
    host-commands: []
    mutation: workspace
---

# Handoff

Write a concise handoff for a fresh agent. Save it under `.scratch/handoffs/<descriptive-slug>.md` inside the current repository, never in an operating-system temporary directory.

## DSH compatibility preflight

Confirm that `read` and `write` are available and that the current working directory belongs to the intended repository. If either capability is absent or the repository cannot be identified, stop before writing and report the corrective action.

The handoff contains:

- the receiving Session's concrete objective and current status;
- links or repository-relative paths to specifications, plans, ADRs, Issues, commits, diffs, and evidence rather than copied content;
- unresolved blockers and the next safe action;
- a `## Suggested skills` section naming skills the recipient should load with the DSH `skill` capability.

Tailor the document to any invocation argument. Redact credentials, tokens, personal data, and sensitive environment values. Do not claim an unrun check passed, and do not duplicate source material already stored in the repository or tracker.
