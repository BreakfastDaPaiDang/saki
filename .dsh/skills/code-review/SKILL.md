---
name: code-review
description: Review a Saki diff against repository standards and its originating specification in two independent subagents.
metadata:
  saki:
    upstream: https://github.com/mattpocock/skills
    commit: 9c9f36ccd3995266cd675468af71639c8dde1ec5
    dsh-capabilities:
      - read
      - glob
      - grep
      - subagent
    one-of-capabilities:
      - bash
      - pwsh
    optional-capabilities:
      - skill
    host-commands:
      - git
    mutation: none
---

# Code review

Review the three-dot diff from a fixed point to `HEAD` along two independent axes: repository standards and specification fidelity.

## DSH compatibility preflight

Before spawning work, confirm `read`, `glob`, `grep`, and `subagent`, plus one of `bash` or `pwsh`; resolve `git`. Resolve the supplied fixed point with `git rev-parse`, capture `git diff <fixed-point>...HEAD` and `git log <fixed-point>..HEAD --oneline`, and stop if the ref is invalid or the diff is empty. If `subagent` is absent, stop and say that two-axis isolation requires a Saki development preset with subagents; do not silently perform a combined review.

Find the originating specification from issue references, an explicit path or URL, or matching repository documents. GitHub reads follow `docs/agents/issue-tracker.md` and use an explicit `-R BreakfastDaPaiDang/saki`. If none exists, report that the specification axis cannot run.

## Parallel axes

Spawn both reviews concurrently:

- **Standards** reads all applicable `AGENTS.md`, documentation rules, ADRs, and package contracts. If the `dsh-code-review` skill is present in the catalog, load it with the DSH `skill` capability before reviewing. Report hard violations separately from judgment calls and ignore facts already enforced by a passing mechanical check.
- **Specification** reads the complete originating requirement and reports missing or partial behavior, scope additions, and behavior that appears implemented incorrectly. Quote the requirement supporting each finding.

Give both subagents the fixed diff command and commit list. Present their reports under separate `## Standards` and `## Specification` headings without merging their rankings. End with the finding count and most severe finding within each axis.
