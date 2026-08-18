# dsh-credentials-windows-dpapi

English | [中文](README.zh.md)

Windows current-user DPAPI [credential](../credentials/README.md) provider. It persists only opaque ciphertext and reports `protectionLevel: 'local-user-trust'`; it never falls back to the process environment, `.env`, plaintext credential files, or machine-scoped DPAPI.

> **`local-user-trust` is not process isolation.** Any process deliberately running as the same Windows user may call DPAPI to decrypt a copied blob. This provider protects values at rest from other ordinary users and accidental propagation, not from compromise of the Host account or malicious same-user code.

## Config

| Field | Default | Meaning |
|---|---|---|
| `path` | `<harness home>/.credentials.dpapi.json` | Host-local ciphertext document. |
| `dshHome` | `$DSH_HOME` or `~/.dsh` | Harness home used when `path` is omitted. |

Activation fails on non-Windows hosts and validates an existing document before publishing `ctx.credentials`.

## Stored document

Version 1 has exactly two root fields and each record has exactly two fields:

```json
{
  "version": 1,
  "records": {
    "OPENAI_REFRESH_TOKEN": {
      "kind": "dpapi-current-user",
      "ciphertext": "<canonical base64>"
    }
  }
}
```

Malformed JSON, unknown or missing fields, unsupported versions, invalid references, non-canonical base64, empty ciphertext, and every record kind other than `dpapi-current-user` fail loud. There is no compatibility fallback: a future format needs an explicit migration. The whole document is Host-local data and must be excluded from portable installation export and Host-replacement backup.

Writes re-read the document under the cross-process lock from [`dsh-atomic-write`](../../util/atomic-write/README.md), replace one record, sort references for deterministic output, and atomically commit. Writes within one provider instance are serialized; an absent `unset` is a no-op. `credentials/updated` fires only after a changed document commits and carries the reference only.

## DPAPI parameters

The native adapter calls `CryptProtectData` and `CryptUnprotectData` with `CRYPTPROTECT_UI_FORBIDDEN`. It does not pass `CRYPTPROTECT_LOCAL_MACHINE`, so Windows selects current-user scope. Description, optional entropy, reserved data, and prompt structure are null; no second portable secret or interactive prompt participates in recovery. DPAPI-owned outputs are copied and released with `LocalFree`.

The adapter clears its temporary plaintext and ciphertext `Buffer` copies. JavaScript strings cannot be reliably zeroized, so trusted provider consumers must keep resolved values operation-local and must not log, cache, project, or serialize them.

## Resolution and safe observations

`resolve(ref)` reads and validates the current document on every operation, decrypts the selected record, and returns its non-empty value with source `windows-dpapi-current-user` and protection level `local-user-trust`. `resolveRequired(ref, CREDENTIAL_PROTECTION_LOCAL_USER_TRUST)` is the fail-closed consumer entry point: missing values and missing, invalid, or different protection metadata fail before the caller receives the value.

`describe(ref)` returns only `ref`, configured state, source, protection level, writability, health, and observation time. It probes current-user decryption without constructing a JavaScript string containing the credential. A copied, corrupt, or differently scoped record is `configured: true, health: 'unavailable'`; the raw ciphertext and native input bytes never enter its result or diagnostic message.

Only trusted Host plugins should receive the raw credential service. Browser APIs, Agent tools, Projections, Session events, logs, diagnostics, crash artifacts, and portable exports should carry `CredentialRef` plus safe observations, never plaintext or ciphertext.

## Model Experience

Indirectly, through consumers of `ctx.credentials`: a resolved value may authorize a provider operation, while that consumer owns every model-visible effect. This package registers no prompt, tool, or model context.

#### KV Cache effect

No direct invalidation; credentials never enter a request prefix.

## Known Limitations and Deferred Work

- **Same-user code can decrypt copied records** — a separately isolated credential broker or external secret manager is required before Host-supplied credentials can be treated as unavailable to Agent processes.
- **Recovery is Host-bound** — moving the document to another Windows user or machine normally makes records unavailable; reauthorize OAuth accounts or re-import private material on the destination Host.
- **External edits do not emit events** — every operation re-reads the file and observes the edit, but only provider-owned commits publish `credentials/updated`.
- **JavaScript strings cannot be zeroized** — temporary byte buffers are cleared, but a resolved string remains subject to the JavaScript runtime's memory behavior.
- **Atomic, not crash-durable** — inherited from `dsh-atomic-write`; the complete document is validated again on the next boot or operation.
