---
name: tdd
description: Implement Saki behavior test-first through agreed public interfaces, one red-green tracer bullet at a time.
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
    host-commands: []
    mutation: workspace
---

# Test-driven development

TDD is a red–green loop through an agreed public interface. Tests observe behavior callers, users, or assembled applications rely on; they do not reach through private collaborators.

Read `CONTEXT-MAP.md`, the relevant context glossary, ADRs, and testing instructions before naming tests or selecting evidence. See [tests.md](tests.md) and [mocking.md](mocking.md).

## DSH compatibility preflight

Before writing a test, confirm `read`, `write`, `edit`, `glob`, and `grep`, plus one of `bash` or `pwsh`. Resolve any repository-specific test command before mutation. If a capability or executable required by the selected test is absent, stop and report the missing item and the command that would have run.

## Loop

1. State the public interface and one observable behavior fixed by the approved specification.
2. Write one test and run it to capture the expected failure.
3. Add only enough implementation to make that test pass.
4. Repeat with the next behavior, informed by the preceding slice.
5. Refactor only while green and rerun the narrow affected evidence after each structural change.

Avoid implementation-coupled mocks, tautological expected values, and horizontal batches of tests written ahead of implementation. Use the repository's defined term `seam` only for a complete capability seam containing Service Definition, Service Provider, and Consumer roles; ordinary test locations are public interfaces or assembled entry paths.
