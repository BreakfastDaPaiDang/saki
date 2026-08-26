---
status: accepted
---

# Use forward-only migrations and generation-switched Installation maintenance

English | [中文](0012-forward-migrations-and-installation-maintenance.zh.md)

Saki gives its persisted product state a forward-compatibility promise from version 0.1.0. It stores canonical control-plane state in a dedicated SQLite database routed through DSH `storageDomain`, migrates that state only through contiguous forward steps, and switches upgrades between complete Installation State Generations. A separate Installation-maintenance plugin owns product backup, encrypted export, restore, and Host-replacement behavior.

## Why this decision

DSH currently rejects a domain medium whose version differs from its `DomainSpec`. That fail-loud rule is appropriate for replaceable pre-release harness data, but Saki begins storing Project relationships, authorization, automation, and recovery state that cannot be recreated safely after every schema change. Dogfooding would otherwise force a choice between freezing the data model and deleting useful state.

The storage layer and product-maintenance layer solve different problems. `storageDomain` already owns domain schemas, durable validation, and backend-independent records, so it is the correct owner of an opt-in migration mechanism. Saki understands which records form one portable Installation and what a restored Host must rebind, so generic storage must not own Saki export contents, credential policy, automation recovery, or Host retirement.

SQLite fits the canonical Saki control plane because its records receive frequent point updates and must grow without whole-file rewrites. JSON remains useful for tests and small human-readable domains, but it is not the production authority for Saki Installation state. A dedicated database also lets Saki move one complete state generation without coupling its lifecycle to unrelated DSH domains.

In-place migration would make a migration defect and its rollback compete for the same only copy. Side-by-side generations preserve the last known-readable state until the candidate has completed every migration and invariant check. The active manifest, rather than a filename or newest timestamp, decides which generation accepts writes.

## Decision

Every Saki-owned persisted schema participates in a forward compatibility sequence beginning with its first 0.1.0 schema. A domain that registers no migration sequence retains DSH's current version-mismatch rejection. A migratable domain registers every supported `N -> N+1` step with the source and target validation schemas. The caller contract requires each step to be deterministic and free of external effects. The runner supplies only a detached, deeply frozen snapshot to a synchronous callback and validates exact input, adjacent output, and committed readback, but it cannot prove repeatability or detect ambient imports; the registering caller owns those obligations and their evidence. Stored data newer than the running build and requests for downgrade migration fail closed.

Saki uses one dedicated SQLite database for canonical control-plane records through `storageDomain`. An upgrade first stops new writes and automation, drains owned writes, creates and verifies a Recovery Backup of the active Installation State Generation, and migrates a separate candidate database through each contiguous step. Saki opens and validates the candidate with the target domain specification, checks product invariants, and atomically changes the Installation manifest only after all checks pass. Failure before that switch leaves the old generation active and unchanged. Rollback restores the Recovery Backup with a build whose declared state capability reads the recorded state version; Saki does not implement reverse migrations, and rollback does not preserve writes accepted only by the newer generation.

The exact B03 transition is manually cold: that Host predates the Installation lease, so the operator stops it and confirms it remains offline before invoking the B18 maintenance executable. Beginning with B18, every Host serving lifetime and cold-maintenance command acquires the same no-wait Installation lease for one Installation root; a live leased Host therefore excludes backup, verification, and upgrade. The lease cannot retroactively fence a B03 process or coordinate a copied Installation root.

An `installation-maintenance` plugin owns the Saki-specific maintenance flow. A Recovery Backup is an exact local rollback artifact for one Installation State Generation. Its metadata records the state version that determines reader compatibility and the source build as provenance only. An Installation Export is a distinct encrypted, versioned portable archive containing Saki-owned records, an inventory with integrity hashes, and explicitly referenced DSH Session exports. It excludes raw credentials, DPAPI ciphertext, caches, live processes, worktree contents, and absolute paths as reusable resource authority. The export format identifies its source schema and build and uses a maintained authenticated-encryption implementation rather than custom cryptography.

Restore validates and decrypts into a new candidate generation instead of overwriting a running Installation. An explicit replacement restore retains the Saki Installation id and creates a new Saki Host id. Resource Bindings enter `needs-rebind`; Provider Account Profiles require reauthorization or Host-only private-material import; unresolved Host Operations and Execution Dispatches require reconciliation; automatic execution stays disabled until the recovery checks complete. The old Host must be retired or kept offline before the replacement becomes active. Version 0.1.0 does not claim to fence two historical copies when an operator deliberately starts both without an external coordinator.

Version 0.1.0 provides these maintenance operations through PowerShell 7 and the Saki CLI. A complete backup-management UI is not a release requirement.

## Considered options

**Keep rejecting every old Saki schema.** This preserves the DSH pre-release rule but makes Saki's first durable Project state disposable and prevents reliable dogfooding across record changes.

**Migrate SQLite in place.** SQLite transactions can protect many DDL changes, but application migration defects, invariant failures, and build rollback would still act on the same sole database. A candidate generation costs additional disk space and maintenance time in exchange for a simpler recovery point.

**Implement migration by reading SQLite tables inside Saki.** This would duplicate backend knowledge, bypass the domain schemas that own validation, and couple Saki to one storage implementation. The generic opt-in migration belongs with `storageDomain`; Saki only chooses its routed backend and orchestrates product maintenance.

**Make the control plane fully event sourced.** An append-only product journal could reconstruct old projections, but it would introduce event-schema evolution, replay, compaction, and temporal semantics for every Saki record. Existing lifecycle records plus external evidence meet the 0.1.0 audit and recovery requirements.

**Use JSON as the canonical Saki database.** Human readability is useful, but whole-unit publication makes high-frequency control records increasingly expensive and creates a larger failure and contention unit than SQLite's document-per-row storage.

**Provide reverse migrations.** A reverse step cannot generally recover information discarded or reinterpreted by a newer schema. Pairing an exact Recovery Backup with a reader that declares support for its recorded state version states the actual rollback guarantee.

**Copy the entire Harness home during Host replacement.** That would mix portable Installation state with credentials, caches, active-process residue, local paths, and unrelated DSH data while encouraging two writable copies. A declared Installation Export makes included and excluded authority explicit.

## Consequences

Saki upgrades require a short maintenance interval and enough disk space for the active generation, candidate, and Recovery Backup. The manifest and retained backup become critical recovery metadata, and pruning must never remove the only generation needed for the declared rollback state version.

DSH storage gains an opt-in migration path without weakening fail-loud behavior for domains that do not promise compatibility. Saki gains a product-specific maintenance module without teaching generic storage about Projects, Sessions, credentials, or Hosts. Backup and export tests must cover corruption, interruption before and after manifest switch, missing migration steps, newer stored versions, wrong decryption material, excluded secrets and paths, restore into a nonempty target, and the post-restore recovery states.

Installation Export preserves identity and relationships, not machine authority. Host replacement therefore includes visible rebind, reauthorization, reconciliation, and old-Host retirement work. The single-writer guarantee remains operational rather than distributed; a future unattended failover or shared storage deployment requires external coordination and a separate decision.
