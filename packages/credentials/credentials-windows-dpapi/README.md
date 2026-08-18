# dsh-credentials-windows-dpapi

English | [中文](README.zh.md)

Windows CNG DPAPI `LOCAL=user` [credential](../credentials/README.md) provider. It persists only opaque ciphertext and reports `protectionLevel: 'local-user-trust'`; it never falls back to the process environment, `.env`, plaintext credential files, classic DPAPI, or machine-scoped CNG DPAPI.

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
      "kind": "dpapi-ng-local-user",
      "ciphertext": "<canonical base64>"
    }
  }
}
```

Malformed JSON, unknown or missing fields, unsupported versions, invalid references, non-canonical base64, empty ciphertext, and every record kind other than `dpapi-ng-local-user` fail loud. There is no compatibility fallback: a future format needs an explicit migration. The whole document is Host-local data and must be excluded from portable installation export and Host-replacement backup.

Writes re-read the document under the cross-process lock from [`dsh-atomic-write`](../../util/atomic-write/README.md), replace one record, sort references for deterministic output, and atomically commit. Writes within one provider instance are serialized; an absent `unset` is a no-op. `credentials/updated` fires only after a changed document commits and carries the reference only.

## CNG DPAPI parameters

The native adapter creates a `LOCAL=user` protection descriptor and calls `NCryptProtectSecret` and `NCryptUnprotectSecret` with `NCRYPT_SILENT_FLAG`. On unprotect it obtains the descriptor carried by the protected blob, reads its complete rule through `NCryptGetProtectionDescriptorInfo`, and requires the exact string `LOCAL=user` before copying plaintext into JavaScript. A classic DPAPI blob supplies no CNG descriptor and a machine-scoped CNG DPAPI blob reports `LOCAL=machine`, so both fail closed even if file metadata claims the accepted record kind.

Every descriptor handle is closed with `NCryptCloseProtectionDescriptor`, and Windows-owned descriptor strings and data allocations are released with `LocalFree`. Returned data allocations are overwritten before release after both successful and failed calls, including non-null zero-length results.

The adapter clears its temporary plaintext and ciphertext `Buffer` copies. JavaScript strings cannot be reliably zeroized, so trusted provider consumers must keep resolved values operation-local and must not log, cache, project, or serialize them.

## Resolution and safe observations

`resolve(ref)` reads and validates the current document on every operation, decrypts the selected record, and returns its non-empty value with source `windows-dpapi-current-user` and protection level `local-user-trust`. `resolveRequired(ref, CREDENTIAL_PROTECTION_LOCAL_USER_TRUST)` is the fail-closed consumer entry point: a missing value or any different protection level fails before the caller receives the value.

`describe(ref)` returns only `ref`, configured state, source, protection level, writability, health, and observation time. It verifies the protected descriptor and plaintext validity without constructing a JavaScript string containing the credential. A copied, corrupt, classic, or differently scoped record is `configured: true, health: 'unavailable'`; the raw ciphertext and native input bytes never enter its result or diagnostic message.

Only trusted Host plugins should receive the raw credential service. Read responses and safe observations carry `CredentialRef` plus the documented safe fields, never plaintext or ciphertext. `credentials.set` is the named write-only Host API exception: plaintext crosses the wire in its request and is never echoed in a response. This package registers no Agent tool, Projection, Session event, export record, or model context containing credential material, and its diagnostics omit input and stored bytes. Excluding credential material from process crash collection and portable exports remains an obligation of the application composition.

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
