# @deepseek-ai/dsh-storage-sqlite

English | [中文](README.zh.md)

SQLite backend for the [storage hub](../storage/README.md): registers under a configurable name that defaults to `sqlite`, serving the `kv` facet over one `node:sqlite` database file (or `:memory:`). Design and trade-offs: [domain KV storage Agent Note](../../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md).

## Storage model

Physical schema v2 stores one document per row. Each declared unit table has a collision-free `u2_<unit-utf8-hex>_<table-utf8-hex>` STRICT table with `(key TEXT PRIMARY KEY, value TEXT NOT NULL)`, so one key updates one row. The database encoding must be UTF-8, and logical record keys are stored as canonical JSON string text so every JavaScript string, including embedded NUL and unpaired surrogates, remains distinct. Reads select key and value TEXT cells as raw bytes and decode UTF-8 without replacement before validating keys or parsing JSON; invalid encoding, non-canonical keys, hidden NUL suffixes, duplicate object members, and numeric tokens that JavaScript would round, underflow, or overflow all reject as malformed media. The authoritative layout is split across `units(name, version, has_global)`, `unit_tables(unit, table_name)`, and `unit_globals(unit, value)`. Schema SQL, object types, names, and owning-table names are likewise read from `sqlite_schema` as raw bytes and decoded strictly before token or inventory checks; only the exact implicit primary-key autoindexes are omitted from that inventory. A file-backed ordinary open validates the complete layout and every stored key, value, and global first through a frozen copy and again on the original connection before writer configuration, so rejecting malformed media does not change its journal mode or source bytes. Opening a unit also requires its version, global capability, declared table set, and physical record tables to match exactly before the live handle is returned. `PRAGMA user_version` identifies the physical schema; ordinary opens accept only v2 and never repair or upgrade an existing medium in place.

Every ordinary write primitive is a single prepared statement; write ordering stays the caller's responsibility. If an entered statement throws, its commit outcome is unknown and the backend permanently rejects further reads and writes through that shared connection while still allowing close to release it. Closed-unit materialization is create-only and commits metadata, record tables, and initial content in one transaction. A successful `COMMIT` returns a durable result; a failed `COMMIT` is rolled back and rejected only while SQLite still reports an active transaction, otherwise it returns an uncertain result with a scoped `readBack()` and poisons the shared connection. File-backed closed reads always freeze the database plus any nonempty `-wal` and `-journal` sidecars into a private temporary copy, normalize every copied recovery file to `0o600`, verify that the source database and all sidecars did not change during the copy, and let SQLite replay the WAL or recover a hot rollback journal only in the copy. This preserves source bytes, modes, and file inventory even when the source is read-only or the backend already has a warm writer. A fresh `:memory:` closed inspection reports missing without initializing or stamping the database; after its shared connection is poisoned it has no independent read view, so uncertain readback rejects. An absent file database counts as missing only when its `-wal`, `-shm`, and `-journal` paths are also absent; any orphan sidecar, including an empty or non-regular entry, is a malformed medium that ordinary and closed operations leave unchanged. Relative database paths are resolved when the backend is constructed, so later working-directory changes cannot redirect ordinary or closed access to another medium. Unit and table names are validated before DDL, and the hexadecimal physical names contain no external SQL syntax. Missing directories and database files are created owner-only (`0o700`/`0o600`).

The closed-unit API also reads the exact legacy physical-v1 B03 layout for migration only: the medium must contain one unit, no global row, and exactly the descriptor's legacy record tables, and the descriptor must declare `hasGlobal: false`. Ordinary serving still rejects v1.

## Configuration (schemastery)

```ts
interface Config {
  backend?: string // storage registry name; default `sqlite`
  path: string   // SQLite database file path, or ':memory:' for an in-process DB
  journalMode?: 'wal' | 'delete' | 'truncate' | 'persist'   // journal_mode pragma; default 'wal'
}
```

## Model Experience

### Stored domain records

#### What the model sees

Nothing. This backend contributes no prompt, tool, or schema; it persists non-session domain data (workspace records, future session sidecar metadata) behind `ctx.storage` for host-side consumers only.

#### Token effect

Zero live-request tokens.

#### KV Cache effect

None — the backend never touches live request prefixes.

## Known Limitations and Deferred Work

- **`DatabaseSync` is synchronous** — each write blocks the event loop for its (single-statement) duration; acceptable at domain-data scale.
- **No busy-wait or retry policy** — another connection holding a write transaction rejects the operation immediately; there is no multi-process write protection.
- **Only physical v2 opens for ordinary serving** — the strict physical-v1 reader exists only for a closed migration lease; no format is repaired or upgraded in place.
- **`openDatabase` duplicates the session-persistence SQLite open sequence** — extraction into a shared media layer is deferred to the planned session-backend migration (see the Agent Note's reuse audit).
