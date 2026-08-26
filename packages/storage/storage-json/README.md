# @deepseek-ai/dsh-storage-json

English | [中文](README.zh.md)

JSON backend for the [storage hub](../storage/README.md): one human-readable `<unit>.json` file per unit under a configured root, registered under a configurable name that defaults to `json`. Design: [domain KV storage Agent Note](../../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md).

## Model

- The in-memory unit state is authoritative; every write primitive republishes the whole file via temp-write + fsync + atomic `rename()` replace. A unit file is always the complete current net state — legibility is this backend's reason to exist; scale is the SQLite backend's job.
- Every materialized file uses the exact physical-v1 fields `unit`, `global`, and `tables`; the `unit` header carries exactly the name, domain-owned version, `formatVersion: 1`, and global-slot declaration. The physical format version evolves independently from domain migration versions. Ordinary and closed reads use fatal UTF-8 decoding and one strict lossless parser: invalid byte sequences, a byte-order mark, comments, trailing commas, nested duplicate members, numeric tokens that JavaScript would round, underflow, or overflow, unversioned or unsupported files, unknown fields, layout differences, foreign headers, and other malformed data reject with `malformed-medium`; only a differing domain version rejects with `version-mismatch`.
- A missing file opens as an empty unit and materializes on the first write. The backend resolves its configured root to an absolute path once at construction and pins the first real directory identity it creates or observes. The root and every existing unit entry must remain a real directory and regular file respectively; symbolic links, Windows junctions, dangling links, and replacements observed while reading reject with `malformed-medium`. A root replacement detected immediately before `rename()` or `link()` is a definite `malformed-medium` failure with no final publication. A mismatch detected after `rename()` or `link()` reports `commit-outcome-unknown`: a direct unit or live domain is poisoned, while closed materialization returns an `uncertain` token for evidence-preserving readback.
- Write ordering across calls belongs to the caller (the domain layer's write chain); each call validates and clones lossless JSON before publication and is durable once resolved. A definite pre-publication failure restores the prior in-memory state. If replacement is already visible but directory durability fails, the call rejects with `durability-uncertain` and `published: true` while retaining the published state internally; that direct unit rejects every subsequent read or write until it is closed. Cross-provider recovery discards and recreates the affected backend (or restarts) before opening a fresh unit from the medium. `loadAll()` returns a detached value graph, so later mutation of write inputs or loaded snapshots cannot change in-memory or durable state; `close()` synchronously stops admission and drains reads and writes admitted earlier.
- The optional `kv.closed.withReservedUnit` operation reserves one unit name before returning its promise. Once the scope observes callback settlement it ends lease admission; reservation release and backend close wait for the callback and every lease method admitted earlier, including methods the callback did not await. Its lease inspects and reads without opening or changing the unit, or validates and atomically materializes a complete missing unit without replacing any existing entry. Reservations fail fast with `unit-open` against live, opening, or other reserved access. Pre-publication methods observe the caller's `AbortSignal`. Create-only publication never removes a linked final entry after a directory-sync failure and returns an `uncertain` token whose same-lease `readBack()` supplies exact visibility evidence; late cancellation does not suppress that readback.

## Config

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `backend` | string | `json` | Storage registry and lifecycle-service name; distinct names allow multiple JSON roots in one composition |
| `root` | string | required — no default (a cwd fallback would scatter files) | Directory holding unit files, resolved once against the construction cwd and created `0o700` on demand; the final entry is never accepted as a symbolic link or junction |

## Model Experience

### Stored domain records

#### What the model sees

Nothing. This backend contributes no prompt, tool, or schema; it persists non-session domain data behind `ctx.storage` for host-side consumers only.

#### Token effect

Zero live-request tokens.

#### KV Cache effect

None — the backend never touches live request prefixes.

## Known Limitations and Deferred Work

- Missing-unit materialization requires same-directory hard-link support so publication can remain atomic and create-only.
- Windows namespace durability has no explicit write-through call: ordinary replacement relies on libuv's `rename()` and missing-unit materialization publishes a synced temporary file through a no-clobber hard link. The session-log backend's stricter Win32 helper is planned to move down here when the append-log facet lands (see the Agent Note's migration section).
- Node's path-based filesystem API cannot bind publication to an already-open directory handle on every supported platform. The backend checks the pinned root identity immediately before and after publication and rejects detected replacement, but another process can still replace the root inside that final path-resolution interval; deployments must keep the configured root under the host's exclusive administrative control.
- No cross-process write locking: two processes writing the same root can interleave whole-file replacements (last write wins). Single-host-process deployments are the current consumer; the multi-process story is deferred per the Agent Note's out-of-scope table.
