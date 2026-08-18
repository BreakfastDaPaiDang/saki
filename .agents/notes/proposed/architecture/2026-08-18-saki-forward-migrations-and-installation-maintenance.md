# Agent Note: Saki forward migrations and Installation maintenance

Status: proposed

English | [中文](2026-08-18-saki-forward-migrations-and-installation-maintenance.zh.md)

## Problem

Saki 0.1.0 begins persisting irreplaceable control-plane relationships while DSH `storageDomain` rejects every stored domain version that differs from the running `DomainSpec`. Saki needs to evolve those records through dogfooding, recover from interrupted upgrades, roll back a defective build, and replace its Windows Host without copying credentials, active-process residue, or local paths as if they were portable authority. These needs must not make Saki aware of SQLite tables or make generic storage aware of Project, Session, credential, and Host semantics.

## Proposal

Implement [ADR 0012](../../../../docs/adr/0012-forward-migrations-and-installation-maintenance.md) in two layers. Extend `packages/storage/storage-domain` with an opt-in, backend-independent forward migration mechanism. Add `packages/saki/installation-maintenance` as the Saki product Consumer that quiesces the control plane, creates and validates state generations, invokes domain migration, publishes the active generation, exports portable state, and restores an Installation onto a replacement Host.

Route Saki's canonical control-plane domain to a dedicated `storage-sqlite` backend and database file. Other DSH domains keep their own configured routes and lifecycles. JSON remains available to the Saki control-plane contract suite and to genuinely small human-readable domains; production Saki state does not change backend automatically according to record count.

### Domain migration mechanism

A migratable domain declares its current version, the validation schema for each retained source version, and one migration for every supported adjacent pair. The registry rejects duplicate steps, gaps from a supported source to the current version, non-integer versions, and steps whose declared endpoints are not `N -> N+1`. A domain without this registry retains the current `version-mismatch` behavior.

Migration and the [declared derived-medium reset proposal](2026-07-28-storage-root-and-derived-medium-recovery.md) are mutually exclusive policies. A derived domain may discard and rebuild damaged or version-mismatched media; an authoritative domain that promises compatibility must migrate or reject. No domain may fall back from a failed migration to reset.

The domain layer inspects the stored unit version through a generic storage operation, opens the source with its matching historical descriptor, loads and validates a detached snapshot, closes the source, applies one migration step, and validates the complete output against the next version before continuing. A step receives JSON-compatible records and returns new JSON-compatible records; it cannot receive a backend, Cordis context, credential resolver, clock, network client, or mutable domain handle. Migration never emits ordinary `domain/changed` events because no active domain observes the candidate.

The final snapshot is written into a fresh target unit and opened through the normal current `DomainSpec` before publication. Existing runtime write ordering, post-durability events, and record operations remain unchanged. A stored version newer than the running version, a missing step, invalid source data, invalid output, unknown table, or target invariant failure aborts without changing the selected generation. The migration API exposes structured version and validation evidence to maintenance code without exposing backend-specific rows.

### Installation State Generations

One small Installation manifest records the Installation id, active generation id, Saki state-format version, compatible build identity, and integrity reference. Each generation is a complete dedicated Saki database. Exactly one manifest-selected generation is active and writable; a candidate and every retained or backed-up generation remain closed and immutable.

The 0.1.0 upgrade sequence is:

1. Enter maintenance mode, reject new mutating Intents, disable automation, drain `storageDomain` writes, and wait for Saki-owned operations that can safely quiesce. External operations that cannot be stopped become reconciliation work rather than being reported as finished.
2. Close the active Saki domain and database. Create an owner-readable Recovery Backup with the active generation id, exact state-format version, compatible build identity, length, and cryptographic digest, then verify that artifact before migration continues.
3. Create a new candidate generation. Invoke the generic domain migration through every contiguous version and open the resulting database with the current `DomainSpec`.
4. Validate Installation identity, referential integrity, unique admission owners, lifecycle enums, occupied Execution Leases, non-terminal Intent and Dispatch recoverability, and the absence of secret values. Write and fsync a candidate manifest, then atomically replace the active manifest.
5. Reopen the selected generation, run normal startup recovery, and admit new work only after recovery reaches a safe state. Retained old generations remain read-only until retention policy permits removal.

On startup, the manifest is the only selector. A candidate file, backup timestamp, or numerically newest generation never wins implicitly. A crash before the manifest replacement selects the old generation; a crash after replacement selects the new generation. If the manifest or selected generation fails integrity checks, startup enters maintenance recovery and never guesses another writer. Rollback explicitly installs the recorded compatible build and restores its Recovery Backup; reverse migration is unsupported.

### Recovery Backup and Installation Export

A Recovery Backup serves local rollback and preserves one exact Saki Installation State Generation. It is paired with a compatible Saki build and is not accepted as a portable Host-transfer claim. It contains only the dedicated Saki database and maintenance metadata; Host credential stores remain outside the generation. Owner-only filesystem protection and verified hashes are required even though the Saki database contains references rather than raw credentials.

An Installation Export is a versioned portable archive with an authenticated-encryption envelope, a manifest, and content hashes. The implementation selects a maintained library and records the format, key-derivation parameters when a passphrase is used, encryption algorithm, archive version, source build, source state version, Installation id, and included-file inventory. Saki does not implement cryptographic primitives. Export first produces a consistent read-only generation snapshot and uses the existing DSH Session export capability for every Session explicitly linked from a retained Work Session; it does not copy live Session persistence media directly.

The portable archive includes Saki-owned domain records, safe Provider Account Profile metadata and credential references, Project and Work Item relationships, automation policy, reconciliation state, generated artifact references that have a portable representation, and the declared Session exports. It excludes plaintext credentials, DPAPI ciphertext, ambient environment values, caches and indexes that can be rebuilt, active process and terminal state, package caches, worktree bytes, and absolute paths as reusable Resource Binding authority. Its manifest lists every excluded category and identifies incomplete portable dependencies. An export cannot be described as replacement-ready while linked worktree changes or required artifacts exist only on the source Host; the CLI reports those conditions and requires resolution or an explicit nonportable diagnostic export.

### Restore and Host replacement

Restore never overwrites an active Installation. It decrypts, verifies hashes and versions, validates every included record, imports Session archives through the owning Session capability, and builds a new candidate generation. A replacement restore retains the Installation id, creates a new Host id, records the source Host as retired or awaiting explicit retirement confirmation, and then publishes the candidate through the same manifest switch used by upgrade.

Every Resource Binding becomes `needs-rebind`, with its former display path retained only as a hint. Provider Account Profiles with Host-bound credentials become unavailable and produce Intervention Requests for device reauthorization or Host-only private-material import. Non-terminal Host Operations and Execution Dispatches enter reconciliation because the replacement Host cannot infer the old process result. Occupied Execution Leases remain blocked until their operation evidence and binding ownership are reconciled. Automation stays disabled until these states and the required GitHub refresh complete.

The maintenance command warns that the old Host must remain offline or be retired before activation. Version 0.1.0 has no external coordinator capable of fencing an operator who deliberately starts two restored historical copies. A future remote-control-plane deployment must replace that operational rule with authenticated lease or leader coordination.

### Command and package ownership

`packages/saki/installation-maintenance` owns `upgrade`, `backup`, `export`, `restore`, `verify`, and retention orchestration and exposes typed progress suitable for a later UI. Version 0.1.0 wires these operations to the Saki CLI and PowerShell 7 administration scripts only. `packages/saki/control-plane` supplies quiescence, invariant validation, recovery status, and portable-record selection; it does not read archive files or database rows. Storage backends supply generic closed-medium inspection and materialization primitives only when `storage-domain` cannot implement them through its current facet.

## Alternatives considered

**Keep the repository's no-migration pre-release rule for Saki.** The rule protects DSH from compatibility scaffolding before a release, but Saki's first dogfood schema already stores user-owned relationships. Resetting that state is a product data-loss policy, not merely a development convenience.

**Add a Saki migration abstraction above raw SQLite.** It would look smaller initially, but every migration would depend on backend layout and bypass the historical zod schemas needed to prove each step. Extending the existing domain owner keeps migration available to other durable consumers without making it mandatory.

**Perform an in-place transaction and copy the file only on failure.** A transaction cannot protect against application invariants that are discovered after reopen or against later rollback to an old build after new writes. An immutable candidate and explicit publish point keep both failure decisions simple.

**Put Sessions in the Saki database.** DSH Session logs have separate append, lineage, attachment, compression, and export semantics. Saki needs stable references and declared exports, not a second Session authority.

**Export the Harness home.** This would accidentally include credentials, unrelated profiles, cache state, and location-specific media while failing to explain how a replacement Host obtains authority. An allowlisted archive with a manifest is more reviewable and testable.

**Require a full maintenance Web UI for 0.1.0.** The single Host Operator can use PowerShell 7 and the CLI during the first dogfood release. Typed progress and error results preserve a future UI without delaying the state-safety mechanism.

## Acceptance criteria

- A domain with no migration registry still rejects every version mismatch, while a registered contiguous chain migrates each retained source version to the current schema through both JSON and SQLite contract tests where the backend supports closed-unit materialization; migration and derived-medium reset cannot be enabled together.
- Migration tests reject gaps, downgrade requests, newer stored data, mutated input, invalid source and target records, external-service access, unknown tables, and publication before final validation.
- Crash injection at every upgrade phase proves that exactly one manifest-selected generation reopens and that the old active database remains byte-identical when publication has not occurred.
- Recovery Backup verification detects truncation, digest mismatch, incompatible builds, missing metadata, and attempts to use the artifact as a portable restore.
- Installation Export round-trips Saki records and linked Session exports through authenticated encryption while scans prove that plaintext credentials, DPAPI ciphertext, ambient values, reusable absolute-path authority, caches, worktree contents, and live-process state are absent.
- Replacement restore retains the Installation id, allocates a new Host id, marks Resource Bindings `needs-rebind`, disables Host-bound profiles, reconciles unresolved Dispatch and Operation state, and keeps automation disabled until recovery completes.
- The PowerShell 7 and CLI workflow can back up, verify, upgrade, export, restore into an empty target, and produce machine-readable failure evidence without a Web UI.

## Risks

Historical schemas increase maintenance cost and can accidentally become an invitation to preserve obsolete product models indefinitely. The compatibility promise applies to persisted data, not every old API or plugin configuration, and retention policy may define a supported direct-upgrade floor while still requiring a complete chain from that floor.

Side-by-side generations need additional disk space and robust atomic publication on Windows. Antivirus, abrupt power loss, or manual file edits can interrupt filesystem operations, so every phase requires fsync-equivalent publication, integrity verification, and deterministic restart behavior using the manifest rather than directory discovery.

An encrypted archive remains sensitive: weak passphrases, exposed command-line arguments, copied decrypted temporary files, or verbose diagnostics can defeat its envelope. The implementation must keep secrets out of arguments and logs, restrict temporary files, and use a reviewed library. Installation portability also does not make worktrees portable; an operator who ignores the source-Host and uncommitted-change warnings can restore relationships whose underlying resources are unavailable.
