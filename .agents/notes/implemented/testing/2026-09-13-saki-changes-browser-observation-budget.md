# Agent Note: Changes browser budgets cover complete Git observations in source mode

Status: implemented

English | [中文](2026-09-13-saki-changes-browser-observation-budget.zh.md)

## Problem

The [Changes browser CI failure](https://github.com/BreakfastDaPaiDang/saki/actions/runs/34733414845/job/103660353373) exceeded a 90-second wait for the first unstaged Diff while the page still showed the pending read. That wait covered a complete Host query, including repeated repository observations and patch validation. It did not measure one Git command or enforce a product latency guarantee.

The fixture launches the source Host. Its Linux and Windows paths use the [subprocess runner selector](../../../../packages/subprocess/subprocess-local/src/runner-launch.ts) to start a TypeScript runner for every managed command. A native Windows probe of the same seven-line Diff executed 384 Git commands and completed in 162 seconds; the preceding status query executed 82 commands in 34 seconds. The probe verified the returned typed Diff and each command's settlement. These timings describe the source fixture, not measured packaged Host latency.

The [four-worker Linux trace](https://github.com/BreakfastDaPaiDang/saki/actions/runs/34735097494/job/103664990490) exposed an earlier capture failure: 35 commands each took about 0.8 seconds, and the next command was canceled 30 seconds after capture began. Planning also rejected its selection, and Work exhausted its HTTP wait. The consumer job already constrained its other test pools under Saki's standard-runner policy, but the new browser gate inherited the e2e configuration's four-worker default.

## Decision

The consumer job sets `DSH_E2E_MAX_WORKERS` to two for Saki standard runners and retains four elsewhere. The workflow test rejects a missing Saki worker limit. This keeps the browser cases parallel while allocating the same worker budget as the other consumer pools.

The [Changes browser case](../../../../packages/saki/bundle/tests/web-changes.e2e.ts) allows ten minutes per complete gesture and one hour for the whole scenario to cover process startup in source mode; the native Windows scenario completed in 23 minutes. The original Git command, inventory, and baseline limits remain owned by the execution provider; the Windows fixture retains its explicit capture budget overlay. The browser waits for the same visible states and checks the real index, commit count, exact replay, inherited file, and refreshed layout. The CI invocation uses `--retry=0`.

Each private Changes recording retains phase timestamps, screenshots, and when each command starts and settles. The fixture wraps only its own subprocess service, delegates the original call with its receiver, and restores the method through the context effect. Timing records omit command arguments and environment values. The consumer job retains the directory after either a successful or failed run, as described in the [bundle diagnostics](../../../../packages/saki/bundle/README.md#changes-browser-diagnostics).

## Alternatives considered

- Retry the browser case: a retry does not explain which operation exceeded its budget and repeats real repository mutations.
- Bypass the managed runner or select built code inside the source fixture: that removes coverage of the supported source launch path.
- Remove repeated repository observations: those reads establish the [Git operation safety and recovery guarantees](../architecture/2026-08-28-saki-recoverable-structured-git-operations.md).
- Serialize the browser suite: the fixtures allocate separate repositories, and changing concurrency does not remove the startup cost of each command in source mode.

## Consequences

Browser validation in source mode can take many minutes and retains a finite outer deadline for hangs. Command timings distinguish accumulated startup cost from a command that does not settle; they do not measure quiescence of the managed process range or prove packaged performance. Product limits, repository safety checks, and mutation assertions remain independently owned.
