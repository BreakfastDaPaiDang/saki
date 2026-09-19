# Agent Note: Saki upstream runtime integration

Status: implemented

English | [中文](2026-09-06-saki-upstream-runtime-integration.zh.md)

## Problem

Saki owns durable control state, authenticated loopback RPC, Windows credential protection, and AgentRun recovery. Upstream Session persistence, Remote APIs, storage layouts, and terminal protocol handling evolve independently. Keeping the old API surface in parallel would leave these consumers outside the current runtime lifecycle and snapshot corpus.

## Decision

Saki reads the `events` slice from each `SessionHandleReadResult` without mutating its event values, uses `snapshotEvents()` for live Sessions, closes every acquired handle, and mounts `session-projection` in its bundle and AgentRun fixtures. Its preset catalog excludes both shipped and user roots because Saki supplies the runnable preset composition. Credential references retain protection and availability metadata through the typed Credentials Remote. Saki's loopback request policy remains attached to its registered route, including failures before dispatch; ordinary browser routes use the browser authentication policy.

Storage keeps the optional closed-unit lease and explicit create-only migration operations alongside upstream per-record layouts. Ordinary SQLite serving requires physical v2; closed migration can read physical v1 without modifying the source. JSON single-unit writes retain strict lossless JSON and root-identity checks. These are separate from released Session generations, which follow the [Session migration decision](2026-08-31-released-session-format-migrations.md).

POSIX Session writer locks use the lazy `./flock` entry of the [prebuilt system primitives](2026-09-07-prebuilt-system-primitives.md). Windows uses its kernel semaphore without loading a POSIX addon; missing POSIX bindings reject lock acquisition. No unlocked fallback exists.

Persistent PowerShell uses the upstream headless terminal emulator for protocol replies through the same serialized terminal writes as caller input. The noninteractive host and foreground child-process input remain distinct: host prompts reject while child REPLs can read from the PTY. The [persistent PTY decision](../../archived/architecture/2026-08-11-pwsh-persistent-pty.md) owns readiness and input ordering.

Saki skill scenarios live in the shared SDK session corpus, with explicit portable shell compositions and final workspace expectations. Their assertions preserve routed `ask-matt` and `handoff` invocations and the `to-tickets` missing-shell refusal. Tool-schema sidecars match the shipped SDK profile, which excludes the optional `ralph` tool. Host and credential expected output without recorded-session input remains owner-local in the expected-output tier. Saki process expectations honor `DSH_EXAMPLE_MODE` through the shared launcher; CI verifies complete Git and recovery output through built package exports, while the source-launch case checks module resolution and authentication.

Real-Git behavior fixtures and source-launched browser flows select the local provider's platform fallback through protected owner selection, retaining its handle tracking and teardown. POSIX uses process groups; Windows uses direct-child observation and tree termination. Repeated source-runner bootstrap otherwise consumes the aggregate inventory deadline before Git evidence is complete. GitRunner tests, assembled process expectations, and launcher smokes retain platform-selected native containment. Repository state, operation receipts, cancellation, and restart assertions remain exact in both layers. Windows Project registration fixtures allow 180 seconds for a complete flow and cleanup: the registration/read case executes hundreds of real Git commands and takes about 76 seconds on the maintenance host; command and capture deadlines remain independently enforced.

The assembled Delivery transcript requests evidence refreshes explicitly and sets `targetedPendingPollIntervalMs` to its case deadline. Background refresh advances the Delivery revision, so an automatic pass between a Push receipt and the next mutation would invalidate the transcript's expected revision. Unit tests verify that stale mutation refusal independently.

Native subprocess and shell fixtures await shell startup and observe target output before testing cancellation or disposal. The Linux observer keeps the establishment state captured before each query and discards replies invalidated by a concurrent signal; neither reply can establish quiescence for a newly started or newly signalled target. Fake-terminal lifecycle and spawn-failure disposal-order cases select the process-group implementation; dedicated Linux scope cases verify native launch and outcome handling. Timeout-output cases allow the native bootstrap to start the target within the deadline under test. Foreground output observers restore their instance-scoped spawn spies, and fixture teardown awaits owned processes before removing their directories. PowerShell lifecycle cases observe the target PID before disposal, verify its exit afterward, and dispose their context in `finally`; their case deadlines cover both native startup and managed-range exit.

Saki readiness requires every enabled Loader entry to be active, even when the shared boot policy permits an optional entry to remain inactive. The announcer audits the settled tree before stdout or the clean-exit request and disposes the application on rejection. Checking only the readiness provider would allow incomplete recovery or Host composition to appear usable. Disabled rows remain intentional configuration, and Loader warnings retain the detailed activation diagnosis.

The bundle's `./launcher` entry owns launch-environment dependencies. Its readiness plugin remains independently loadable from TypeScript on a clean checkout, while assembled process fixtures resolve launcher helpers through the built entry.

The bundle sets `personaPrefix` and `personaSuffix` explicitly; the development preset supplies its stable prompt through the Persona plugin’s `prefix` field. Connection installs HTTP routes when WebServer becomes available and publishes its validated recovery configuration into the browser bootstrap. Saki route authentication also applies to pre-dispatch failures.

Connection requires credential storage for its browser-session signing record even when Saki owns the mounted Host API authentication. The POSIX composition selects the existing local provider with `plaintext` protection; the Product GitHub App remains disabled. Windows selects DPAPI for both Connection records and Product App references.

PowerShell snapshots retain the shipped headless profile's tools, permission events, and runtime-context message. The persistent PowerShell composition disables the ordinary `pwsh` tool on every platform to keep a single registration.

Standard Web snapshot pages explicitly select `Asia/Shanghai`, matching the retained `clientTimeZone` event payloads. Locale and timezone are browser fixture inputs; replay preserves the logged timezone rather than normalizing it away.

The preview Worker installs Proxy identity tracking before loading the VFS graph. Its `node:util/types` shim recognizes constructed and revoked proxies without reflection, preserving the credential normalizer's rejection before property inspection. The predicate covers proxies constructed inside that Worker; structured-clone transport rejects foreign proxies.

Loader configuration discovery returns slash-normalized repository paths before classifying each plugin reference by its owning manifest. CLI credential fixtures declare their settings, questions, and DPAPI plugins as development dependencies, so a fresh checkout validates the same resolution graph on Windows and POSIX.

Git test fixtures unlink junctions before awaiting recursive removal, allowing transient Windows process handles to drain during bounded retries. Fixture relocation retries only Windows access and sharing errors; other failures remain visible. Every teardown caller awaits removal.

Saki packages and the DPAPI provider omit empty invariant companions under the [invariant publication rule](../simplification/2026-08-28-omit-unneeded-invariant-companions.md). Their README reasons identify the authoritative parsers or state owners; removing empty registrations does not remove durable-state validation.

The [Saki Actions cost policy](../process/2026-08-18-saki-actions-cost-policy.md) owns trigger cadence and runner allocation. Upstream standby-runner notes retain applicable implementation findings without recreating a master-push workflow. Archived notes remain immutable.

The terminology check preserves five exact artifacts from the Saki skill-handoff recording: its v2 and v3 Session logs, workspace seed, and two expected workspace files. SHA-256 seals admit only their captured bytes; modified content and new paths remain checked. Rewriting recorded user, model, and tool text for an editorial rule would change replay evidence without a runtime behavior change. Current source, diagnostics, and documentation name build identity, message source metadata, execution lineage, and request attribution explicitly.

Persistence-type history imports the existing `saki-agent-run`, `saki-intervention-answer`, and `saki-agent-run-wake` message sources through the [sealed Saki acknowledgement](../../../../docs/persistence-changes/2026-09-19-saki-message-sources.md). Three exact predecessor/successor digest pairs distinguish adoption of that existing vocabulary from a new persisted-type change. The import preserves Session format 3 and upstream history; changed schemas receive the ordinary version classification.

## Alternatives considered

**Retain adapters for the old Session and RPC APIs.** Rejected because Saki has no independent compatibility promise for those internal APIs; direct migration keeps resource ownership and wire types explicit.

**Discard Saki modifications when choosing upstream files.** Rejected because cold migration, credential protection, and pre-dispatch rejection behavior are product requirements with independent tests.

**Require the POSIX native addon on Windows.** Rejected because Windows locking does not use it; installing a compiler would add a deployment prerequisite without serving the Windows implementation.

## Consequences

Upstream upgrades must validate both source-launched and built Saki compositions, Session recovery, storage migration, credential projection, and terminal input ownership. Shared SDK replay checks skill routing and final workspace state. Native Windows locking and PowerShell require platform-specific evidence; the required CI matrix owns cross-platform coverage.
