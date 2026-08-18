# Agent Note: Saki local-user-trust DPAPI credentials

Status: implemented

English | [中文](2026-08-18-saki-local-user-trust-dpapi-credentials.zh.md)

## Problem

Saki's unattended account work needs to retain refresh tokens and private keys across Host restarts without copying them into product state. The existing `credentials-local` Provider keeps managed values in plaintext YAML, skips its POSIX owner-mode enforcement on Windows, and shares the Host user's readable filesystem with Agent subprocesses. Opaque `CredentialRef` values prevent accidental propagation but do not describe the effective source's recovery trust model or let a privileged consumer reject a weaker source at use time.

## Decision

[ADR 0011](../../../../docs/adr/0011-dpapi-local-user-trust-credentials.md) is implemented in the generic [`@deepseek-ai/dsh-credentials-windows-dpapi`](../../../../packages/credentials/credentials-windows-dpapi/README.md) Service Provider and the shared credential Service Definition. The package remains independent of Provider Account Profiles and Saki packages. Saki owns the separate policy that classifies particular references as high-value and requires their protection.

`ResolvedCredential` and safe `CredentialInfo` observations carry a provider-defined `protectionLevel`. The identifiers describe recovery trust models rather than an ordered strength scale. The typed same-process interface requires every Provider to construct that field, while parsers and other untyped inputs validate it before constructing a Provider result. `CredentialProvider.resolveRequired(ref, required)` resolves once and compares the exact level on that result; a missing value and every different level fail before the caller receives the value. The plaintext environment, project `.env`, user `.env`, and `.credentials.yaml` sources explicitly report `plaintext` instead of inheriting a safe default.

The Windows Provider reports source `windows-dpapi-current-user` and protection level `local-user-trust`. Its version-1 document contains only `version` and `records`; each record contains only kind `dpapi-ng-local-user` and canonical-base64 ciphertext. Parsing rejects unknown fields, invalid references, unsupported versions, empty or non-canonical ciphertext, and every other record kind. The Provider has no ambient, plaintext, classic-DPAPI, or machine-scoped fallback.

Classic `CryptUnprotectData` does not return the scope that protected a blob, so a writable record kind cannot prove current-user protection. The native adapter instead uses CNG DPAPI. Protection creates a `LOCAL=user` descriptor and calls `NCryptProtectSecret`; unprotection obtains the descriptor carried by the blob through `NCryptUnprotectSecret`, reads its complete rule through `NCryptGetProtectionDescriptorInfo`, and requires the exact string `LOCAL=user` before copying plaintext into JavaScript. Classic blobs, `LOCAL=machine`, missing descriptors, and unknown rules fail closed.

Every descriptor handle is closed with `NCryptCloseProtectionDescriptor`. Windows-owned descriptor strings and data allocations are released with `LocalFree`; every returned data allocation is overwritten before release after successful and failed native calls, including non-null zero-length results. Temporary JavaScript byte buffers are cleared, while the package documents that JavaScript strings cannot be reliably zeroized.

Every operation re-reads and validates the Host-local document. Writes serialize within one Provider instance, re-read under the cross-process `dsh-atomic-write` lock, sort records, and commit atomically. Disposal drains the active write and refuses queued or captured-service writes that have not started. An absent `unset` emits no update.

`describe(ref)` returns reference, configured state, source, protection level, writability, health, and observation time without plaintext or ciphertext. A copied, corrupt, classic, or differently scoped record remains configured but reports `unavailable`. The Host API maps those fields through an explicit allowlist; extra fields on a Provider object do not cross read responses. Its named write-only `credentials.set` request carries plaintext to the Provider and never echoes it. Native and Provider failures discard arbitrary underlying exceptions so diagnostics and error causes cannot retain credential input.

Only privileged Host consumers receive `ResolvedCredential.value`. The Provider registers no Agent tool, Projection, Session event, export record, or model context containing credential material. Its ciphertext document is Host-local data. The generic package does not implement process crash collection, portable Installation export, or Host-replacement backup; Saki composition owns their exclusion rules. The `local-user-trust` name deliberately preserves the negative guarantee that any process running deliberately as the same Windows user may call DPAPI on a copied blob.

## Deferred Saki composition

No Saki bundle, Provider Account Profile implementation, authorization completion flow, or dispatch admission consumer composes this Provider yet. The generic capability therefore does not claim that Codex, Kimi, or Product GitHub App credentials already require `local-user-trust`, that Host replacement opens an Intervention Request, or that the product UI exposes credential health. The Saki 0.1.0 specifications retain those product obligations. A later high-value consumer satisfies this decision only by calling `resolveRequired` at its operation boundary and storing references plus safe observations outside the credential Provider.

Organization sharing also remains outside this implementation. `local-user-trust` is not sufficient for Host-supplied accounts used by other organization members; that capability requires a Credential Broker under a distinct OS security identity or an external secret manager, an authenticated operation path, and adversarial verification that Agent execution cannot recover raw values.

## Alternatives considered

**Modify `credentials-local` in place.** That package's documented purpose is a portable plaintext file plus environment layering. Replacing it with Windows-only encrypted storage would change existing users' configuration semantics and make a generic sibling capability harder to select independently.

**Add DPAPI encryption while retaining silent plaintext fallback.** Availability would improve at the cost of making the protection claim depend on which layer happened to win. Saki needs an observable, fail-closed requirement for high-value references.

**Expose protection only through `describe()`.** Admission could inspect one source and resolve another after a concurrent update. Including the level with the resolved result lets the privileged consumer enforce the effective value it is about to use; safe descriptions remain for UI and planning.

**Treat protection levels as a total ordering.** Storage mechanisms have incomparable threat models. Stable descriptive identifiers plus explicit policy avoid claiming that every future provider is universally stronger or weaker.

**Make DPAPI ciphertext portable.** Current-user DPAPI normally binds decryption to a Windows user and machine and provides no supported portable recovery contract here. Copying usually unusable ciphertext would create a misleading backup and complicate incident handling without enabling recovery.

## Verification

Shared credential tests pin explicit protection metadata and fail-closed exact-level resolution for missing values and different levels. Deterministic native-adapter tests pin descriptor verification, handle and allocation cleanup, overwrite-before-free ordering, zero-length outputs, native failures, invalid UTF-8, empty plaintext, and diagnostic redaction. Real Windows tests pin CNG DPAPI `LOCAL=user` ciphertext-at-rest and restart round trips, then relabel genuine CNG `LOCAL=machine` and classic LocalMachine blobs and prove that both remain unavailable and cannot resolve. A real Loader composition runs from source and built packages, while a keyless runnable snapshot pins the Host safe-view response fields. Strict document tests reject malformed records and unsupported kinds. Host API tests inject extra plaintext and ciphertext properties into Provider observations and prove that neither reaches read responses. The affected credential packages retain full statement, branch, function, and line coverage on Windows.

## Consequences

The generic credential Service Definition can express a consumer's accepted recovery model without teaching the seam a false ordering. Existing Providers and test doubles must declare their level explicitly, and privileged callers that require protection must use `resolveRequired` on the exact value they consume.

The DPAPI document is bound to the current Windows user and normally the machine, so Host replacement requires reauthorization or re-import rather than ciphertext restoration. This improves plaintext-at-rest and accidental-propagation exposure but does not protect against compromise of the Host account, a privileged administrator, malicious installed Host code, a same-user Agent that locates and decrypts the blob, or a value already resident in trusted memory. These security limits continue to constrain Saki composition.
