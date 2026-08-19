---
name: grilling
description: Interview the user in dependency-ordered rounds until a plan, decision, or idea has no unresolved branches.
metadata:
  saki:
    upstream: https://github.com/mattpocock/skills
    commit: 9c9f36ccd3995266cd675468af71639c8dde1ec5
    dsh-capabilities: []
    one-of-capabilities: []
    optional-capabilities:
      - subagent
    host-commands: []
    mutation: none
---

# Grilling

Build a decision tree. Its frontier contains every question whose prerequisites are already settled. Ask the whole frontier in one round, then wait for the user's answers before recomputing it.

Format each question as:

```text
❓ Q1 — <title>: <question and viable choices>

➡️ <recommended answer and the material trade-off>
```

Finding facts is the agent's responsibility. Inspect the repository and available primary sources before asking the user for information the environment can provide. A bounded fact-finding task may use `subagent` when available; otherwise investigate in the current Session. Decisions remain with the user.

## DSH compatibility preflight

This skill has no required tool capability and performs no mutation itself. If a fact-finding step would require an unavailable capability, identify the missing capability and continue with every independent frontier question; do not guess the blocked fact.

Finish only when the frontier is empty and ask the user to confirm the shared understanding before implementation begins.
