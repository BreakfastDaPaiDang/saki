# Agent brief

An agent brief is the durable implementation instruction added when a Work Item becomes `ready-for-agent`. Discussion remains context; the brief must stand on its own after surrounding code moves.

```md
## Agent Brief

**Category:** bug / enhancement
**Summary:** One observable outcome.

**Current behavior:**
The verified state before implementation.

**Desired behavior:**
The required user- or caller-visible result, including failure and recovery behavior.

**Key interfaces:**
- Stable type, service, command, or protocol obligation and why it changes.

**Acceptance criteria:**
- [ ] Independently observable criterion.

**Out of scope:**
- Adjacent behavior this Work Item does not change.
```

Name stable interfaces and domain terms, not line numbers or speculative implementation steps. Include the relevant verification evidence and every true blocker. Do not equate an Agent completion message with Outcome Evidence.
