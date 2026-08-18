# Decision record routing

Read `.agents/notes/README.md` and `docs/agents/domain.md` before recording a decision.

- Product and domain decisions live under `docs/adr/` or `docs/adr/<context>/` according to their scope and follow the established sibling format.
- Source architecture, repository process, testing strategy, and other codebase decisions that meet the Agent Note criteria use a complete bilingual Agent Note triplet under `.agents/notes/<lifecycle>/<class>/`.
- Documentation pairs update both languages and their `.i18n.yaml` consistency record together.

Do not invent a generic ADR template or numbering scheme when the target directory already establishes one. Record the problem, selected decision, rationale, genuine alternatives, and consequences required by the owning format.
