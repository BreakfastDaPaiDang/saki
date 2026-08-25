# `@breakfastdapaidang/saki-installation-maintenance`

English | [中文](README.zh.md)

Private Saki Installation maintenance and serving preparation. The package owns the Installation-wide writer lease, deterministic state-source selection, manifest-selected Installation State Generations, exact Recovery Backups, crash recovery, and the offline v2-to-v3 upgrade. Generic closed-domain migration remains owned by [`@deepseek-ai/dsh-storage-domain`](../../storage/storage-domain/README.md); Saki control-plane schemas and product invariants remain owned by [`@breakfastdapaidang/saki-control-plane`](../control-plane/README.md).

## State formats and authority

The state capability, rather than a build id, decides format compatibility. This build can read state versions 2 and 3 and can create only version 3. Build ids in generation and backup metadata record provenance; equality with the running build is never a readability or migration test.

| State version | Required domains | Use |
| --- | --- | --- |
| 2 | Exact B03 `saki_control_plane@2`, without a storage-generation seal | Read-only validation, Recovery Backup, and offline migration only |
| 3 | `saki_control_plane@3` plus the required `saki_storage_generation@1` seal | Fresh provisioning, serving, backup, and verification |

The v2 reader accepts only the exact B03 schema and physical SQLite-v1 subset. It validates the selected Installation owner and Foundation references together with the Access aggregate and Project Registry/Intent cross-record invariants. A missing bootstrap-completion summary remains valid before bootstrap has completed. If consumed evidence shows completion without its summary, exactly one consistent initial challenge and Browser Session pair must reconstruct it deterministically. Registration Actor generation attribution must name the initial or current historical generation, while terminal Access challenge or Browser Session attribution may name another schema-valid historical generation. The reader does not impose v3-wide constraints on unrelated historical Foundation records.

`installation.json` is the sole authority after it exists. It selects one exact `generation.json` by bounded leaf, byte length, and SHA-256; the selected generation metadata must repeat the Installation id, storage-generation id, and state version. Without an Installation manifest, only the exact configured B03 database may be selected. If neither exists, serving provisions fresh v3 state. Generation names, backup timestamps, operation journals, and directory recency never select state; unexplained residue requires maintenance recovery.

## Lease, serving, and publication

The B03 Host predates this lease and must be stopped and kept offline manually before the B18 transition. Beginning with B18, every Host lifetime and offline command holds the same Installation lease. Before opening its lock database, the package rejects a linked or non-directory Installation root and durably creates every missing directory. On POSIX, each acquisition synchronizes the nearest existing directory and its parent as a retry checkpoint, then synchronizes every newly created child and its parent before continuing. A separate `installation-lock.sqlite` connection owns `BEGIN EXCLUSIVE` with no wait; process death lets the operating system release ownership. The lock database never selects product state, and the package does not use PID files, stale-owner deletion, or a timeout as ownership evidence.

`withPreparedSakiServingState()` holds the lease across recovery, state preflight, application boot, the complete serving callback, and teardown. Fresh state first publishes a provisioning manifest, provisions and validates the control plane, and promotes that exact manifest to `ready`. A valid v2 source returns `upgrade-required`; serving never migrates it online.

Upgrade first durably publishes a fixed pending intent, the identity-selected immutable operation journal, and then the fixed active selector. The journal fixes the backup and candidate identities before their effects. Upgrade creates and verifies an exact Recovery Backup, materializes a separate v3 candidate, validates its current schemas and Saki product relationships, proves the source SQLite artifacts unchanged, and then atomically publishes a `ready` Installation manifest. A crash before manifest publication retains v2 authority; a crash after publication retains v3 authority. Startup and every maintenance command reconcile deterministic file temps and pending, active, and settled operation metadata under the lease, using them only to validate and clean named artifacts, never to choose authority.

## Recovery Backups

A Recovery Backup is an owner-only, immutable local copy of one exact SQLite artifact set. POSIX uses mode `0700` for its directory and `0600` for every file. Windows replaces inheritance with a protected DACL containing exact Full Control entries for only the path's current owner and LocalSystem; the directory entries inherit to descendants, while every final file is protected explicitly. Verification rejects an unprotected or inherited final DACL, any extra trustee or access rule, and any permission, inventory, or byte mismatch. Canonical `backup.json` records the Installation id, storage-generation id, state version, source-build provenance, and the role, suffix, length, and SHA-256 of every copied database, WAL, SHM, or rollback-journal artifact. State-version readability is checked through the supplied capability.

Recovery Backups are rollback evidence, not portable Installation Exports. The package does not infer a backup from recency and verifies only the caller-selected `backup-<uuid>` identity.

## Offline commands

Stop the Saki Host before running a maintenance command; a live Host owns the same no-wait lease. From the repository root, the PowerShell 7 wrapper passes arguments and the executable's exit code through unchanged:

```powershell
./scripts/saki-maintenance.ps1 backup
./scripts/saki-maintenance.ps1 verify <backup-id>
./scripts/saki-maintenance.ps1 upgrade
```

`backup` supports a valid selected v2 or v3 generation. `verify` checks one explicit backup id. `upgrade` accepts only exact v2 state and publishes v3 after creating its backup; it rejects state that is already current.

The default Installation root is `$DSH_HOME/saki`. The legacy path defaults to `SAKI_DATABASE_PATH`, then `<installation-root>/control.sqlite`. `--installation-root` and `--legacy-database` accept absolute paths only. Each command writes one path-free JSON value: success to stdout with exit code `0`, an operation failure to stderr with exit code `1`, or usage to stderr with exit code `2`. A built checkout can invoke `saki-maintenance` from the package bin instead of the source wrapper.

## Model Experience

### Offline Installation maintenance

#### What the model sees

Nothing; `saki-maintenance` is an operator-run offline executable and contributes no prompt, tool schema, Session event, or model request.

#### Token effect

Zero direct tokens because the package never assembles or invokes a model request.

#### KV Cache effect

Independent; no model request or reusable request prefix exists.

## Known Limitations and Deferred Work

- **One retained upgrade source** — the migration path accepts exact B03 v2 and produces v3; it provides no downgrade, reverse migration, or general old-media repair.
- **Local Recovery Backup only** — the package creates and verifies rollback artifacts but does not expose a restore command. Encrypted Installation Export, replacement-Host restore, and retention orchestration are outside this maintenance increment.
- **No distributed fencing** — the SQLite lease excludes processes using the same Installation root; it does not coordinate deliberately duplicated roots or Hosts.
- **No maintenance Web UI** — backup, verification, and upgrade are CLI and PowerShell 7 operations.
