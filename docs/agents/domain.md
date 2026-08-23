# Domain docs

English | [中文](domain.zh.md)

Saki uses multiple domain contexts. The root context map identifies each glossary and its scope.

## Before exploring

1. Read `CONTEXT-MAP.md`.
2. Read the `CONTEXT.md` files relevant to the work.
3. Read system-wide decisions under `docs/adr/`.
4. Read context decisions under `docs/adr/<context>/`.

Proceed silently when a referenced context or ADR directory does not exist. Domain modeling creates them only after terminology or a decision is resolved.

## Layout

```text
/
├── CONTEXT-MAP.md
└── docs/
    ├── agents/
    ├── contexts/
    │   └── work-management/
    │       └── CONTEXT.md
    └── adr/
        └── <context>/
```

## Use defined terms

Use the canonical term from the relevant glossary in issue titles, implementation briefs, hypotheses, tests, and documentation. Do not substitute a synonym listed under `Avoid`.

Use the domain-modeling workflow when a required concept is absent or an existing definition conflicts with the requested behavior.

## ADR conflicts

Surface a conflict with an existing ADR explicitly. Do not silently override the recorded decision.
