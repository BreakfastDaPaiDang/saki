---
name: domain-modeling
description: Build and sharpen Saki domain terminology and record hard-to-reverse decisions in the repository's context and ADR structure.
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
    one-of-capabilities: []
    optional-capabilities: []
    host-commands: []
    mutation: workspace
---

# Domain modeling

Use this skill when terminology or a durable decision is changing. Merely reading an existing glossary does not require domain modeling.

## DSH compatibility preflight

Before editing, confirm that `read`, `write`, `edit`, `glob`, and `grep` are available. If any is absent, stop and name the missing capability before changing a file.

Read `CONTEXT-MAP.md`, `docs/agents/domain.md`, every relevant `docs/contexts/<context>/CONTEXT.md`, and applicable decisions under `docs/adr/` and `docs/adr/<context>/`. Repository instructions override the generic source formats bundled beside this skill.

## During the discussion

- Challenge a term that conflicts with a context glossary and quote both meanings.
- Replace vague or overloaded language with one proposed canonical term and concrete scenarios.
- Check claims against code and current decisions before recording them.
- Update the owning context glossary as soon as a term is settled. Keep implementation details out of glossaries.
- Offer an ADR only when the decision is hard to reverse, surprising without its rationale, and the result of a genuine trade-off.
- Surface an ADR conflict instead of silently replacing it.

Use [CONTEXT-FORMAT.md](CONTEXT-FORMAT.md) for glossary entries and [ADR-FORMAT.md](ADR-FORMAT.md) only after applying the repository's Agent Note, documentation, and bilingual requirements.
