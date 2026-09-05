# Agent Note: Saki upstream runtime integration

Status: implemented

English | [中文](2026-09-06-saki-upstream-runtime-integration.zh.md)

## Problem

Saki owns durable control state, authenticated loopback RPC, Windows credential protection, and AgentRun recovery. Upstream Session persistence, Remote APIs, storage layouts, and terminal protocol handling evolve independently. Keeping the old API surface in parallel would leave these consumers outside the current runtime lifecycle and snapshot corpus.

## Decision

Saki uses Session read handles and `snapshotEvents()` directly, closes every acquired handle, and mounts `session-projection` in its bundle and AgentRun fixtures. Its preset catalog excludes both shipped and user roots because Saki supplies the runnable preset composition. Credential references retain protection and availability metadata through the typed Credentials Remote. Saki's loopback request policy remains attached to its registered route, including failures before dispatch; ordinary browser routes use the browser authentication policy.

Storage keeps the optional closed-unit lease and explicit create-only migration operations alongside upstream per-record layouts. Ordinary SQLite serving requires physical v2; closed migration can read physical v1 without modifying the source. JSON single-unit writes retain strict lossless JSON and root-identity checks. These are separate from released Session generations, which follow the [Session migration decision](2026-08-31-released-session-format-migrations.md).

POSIX Session writer locks load `fs-ext` only on their execution path. The dependency is optional at installation so Windows can use its kernel semaphore without building a POSIX addon; a POSIX deployment missing the addon fails when it acquires a lock. No unlocked fallback exists.

Persistent PowerShell uses the upstream headless terminal emulator for protocol replies through the same serialized terminal writes as caller input. The noninteractive host and foreground child-process input remain distinct: host prompts reject while child REPLs can read from the PTY. The [persistent PTY decision](2026-08-11-pwsh-persistent-pty.md) owns readiness and input ordering.

Saki skill scenarios live in the shared SDK session corpus, with explicit portable shell compositions and final workspace expectations. Their assertions preserve routed `ask-matt` and `handoff` invocations and the `to-tickets` missing-shell refusal. Host and credential expected output without recorded-session input remains owner-local in the expected-output tier. Real-Git fixtures use a request budget that accommodates repeated repository observations; their filesystem, operation-receipt, and restart assertions still decide success.

Connection requires credential storage for its browser-session signing record even when Saki owns the mounted Host API authentication. The POSIX composition selects the existing local provider with `plaintext` protection; the Product GitHub App remains disabled. Windows selects DPAPI for both Connection records and Product App references.

PowerShell snapshots retain the shipped headless profile's tools, permission events, and runtime-context message. The persistent PowerShell composition disables the ordinary `pwsh` tool on every platform to keep a single registration.

Loader configuration discovery returns slash-normalized repository paths before classifying each plugin reference by its owning manifest. CLI credential fixtures declare their settings, questions, and DPAPI plugins as development dependencies, so a fresh checkout validates the same resolution graph on Windows and POSIX.

Git test fixtures unlink junctions before awaiting recursive removal, allowing transient Windows process handles to drain during bounded retries. Fixture relocation retries only Windows access and sharing errors; other failures remain visible. Every teardown caller awaits removal.

Saki packages and the DPAPI provider omit empty invariant companions under the [invariant publication rule](../simplification/2026-08-28-omit-unneeded-invariant-companions.md). Their README reasons identify the authoritative parsers or state owners; removing empty registrations does not remove durable-state validation.

The [Saki Actions cost policy](../process/2026-08-18-saki-actions-cost-policy.md) owns trigger cadence and runner allocation. Upstream standby-runner notes retain applicable implementation findings without recreating a master-push workflow. Archived notes remain immutable.

## Alternatives considered

**Retain adapters for the old Session and RPC APIs.** Rejected because Saki has no independent compatibility promise for those internal APIs; direct migration keeps resource ownership and wire types explicit.

**Discard Saki modifications when choosing upstream files.** Rejected because cold migration, credential protection, and pre-dispatch rejection behavior are product requirements with independent tests.

**Require the POSIX native addon on Windows.** Rejected because Windows locking does not use it; installing a compiler would add a deployment prerequisite without serving the Windows implementation.

## Consequences

Upstream upgrades must validate both source-launched and built Saki compositions, Session recovery, storage migration, credential projection, and terminal input ownership. Shared SDK replay checks skill routing and final workspace state. Native Windows locking and PowerShell require platform-specific evidence; the required CI matrix owns cross-platform coverage.
