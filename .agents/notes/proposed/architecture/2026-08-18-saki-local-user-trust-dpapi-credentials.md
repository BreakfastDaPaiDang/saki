# Agent Note: Saki local-user-trust DPAPI credentials

Status: proposed

English | [中文](2026-08-18-saki-local-user-trust-dpapi-credentials.zh.md)

## Problem

Saki 0.1.0 needs to retain Codex and Kimi refresh tokens and the Saki Product GitHub App private key across unattended restarts. The existing `credentials-local` Provider keeps values in plaintext YAML, skips its POSIX owner-mode enforcement on Windows, and shares the Host user's readable filesystem with Agent subprocesses. Opaque `CredentialRef` values prevent accidental propagation through product records but do not establish how the stored value is protected or let Saki reject a weak effective source.

## Proposal

Implement [ADR 0011](../../../../docs/adr/0011-dpapi-local-user-trust-credentials.md) as a generic DSH `credentials-windows-dpapi` Service Provider and compose it from the Saki bundle. The package remains independent of Provider Account Profiles and is an upstream candidate; Saki owns only the policy that classifies particular references as high-value and requires their protection.

Extend safe `CredentialInfo` metadata and `ResolvedCredential` with a provider-defined `protectionLevel`. Identifiers are descriptive rather than an implicit ordered scale. The Windows Provider reports `local-user-trust` for its current-user DPAPI layer and a distinct source id. Existing ambient and plaintext layers report their own explicit levels instead of being treated as unknown strength.

For a managed high-value reference, Saki accepts authorization completion, profile activation, and external-effect admission only when the effective resolved result reports `local-user-trust`. Environment, project `.env`, user `.env`, `.credentials.yaml`, missing metadata, and machine-scoped DPAPI are rejected for those references. General DSH consumers may continue to use other sources where their own policy allows them.

The Provider owns a versioned opaque document under Harness home that maps `CredentialRef` values to DPAPI current-user ciphertext and safe metadata. It never writes managed plaintext or optional plaintext fallback. Writes retain the credential seam's atomic update, per-operation resolution, contained notification, and no-secret diagnostic requirements. Exact file schema and migration behavior are owned by the data-evolution decision rather than by Saki account records.

Only privileged Host Provider consumers receive `ResolvedCredential.value`. The Saki control plane and Host transport use a safe credential directory that exposes reference, source, protection level, configured state, writability, health, and last observation without wrapping or returning `resolve`. Agent tools and dynamic execution contexts do not receive the raw resolver. This code-level restriction reduces accidental access; the declared `local-user-trust` level still assumes any process deliberately running under the Host Windows user may recover a copied DPAPI blob.

Export, backup intended for Host replacement, Projections, events, logs, diagnostics, crash artifacts, and Agent context exclude plaintext and ciphertext. Restoring product state on another Host leaves affected profiles unavailable and creates an Intervention Request for device reauthorization or private-material re-import. The original Host's store remains Host-local data rather than portable Installation state.

A future organization-sharing feature may not expose Host-supplied model accounts under `local-user-trust`. It first requires a Credential Broker under a distinct OS security identity or an external secret manager, an authenticated operation path to trusted provider code, and verification that Agent execution cannot read or decrypt raw values. This proposal reserves the requirement without designing the broker protocol.

## Alternatives considered

**Modify `credentials-local` in place.** That package's documented purpose is a portable plaintext file plus environment layering. Replacing it with Windows-only encrypted storage would change existing users' configuration semantics and make a generic sibling capability harder to select independently.

**Add DPAPI encryption while retaining silent plaintext fallback.** Availability would improve at the cost of making the protection claim depend on which layer happened to win. Saki needs an observable, fail-closed requirement for high-value references.

**Expose protection only through `describe()`.** Admission could inspect one source and resolve another after a concurrent update. Including the level with the resolved result lets the privileged consumer enforce the effective value it is about to use; safe descriptions remain for UI and planning.

**Treat protection levels as a total ordering.** Storage mechanisms have incomparable threat models. Stable descriptive identifiers plus explicit policy avoid claiming that every future provider is universally stronger or weaker.

**Make DPAPI ciphertext portable.** Current-user DPAPI intentionally binds decryption to a Windows user and machine. Copying unusable ciphertext would create a misleading backup and complicate incident handling without enabling recovery.

## Acceptance criteria

- A generic Windows credential Provider passes the shared credential contract suite and Windows integration coverage without depending on Saki packages.
- Managed values contain no plaintext on disk, use DPAPI current-user scope, and cannot select machine scope through configuration.
- `CredentialInfo` and `ResolvedCredential` expose safe, provider-defined protection metadata; no secret value reaches `describe()`.
- Saki rejects a managed Codex refresh token, Kimi refresh token, or Product GitHub App private key when its effective source or protection level does not satisfy `local-user-trust`.
- Control-plane records, wire payloads, Projections, Session events, Agent tools, logs, diagnostics, crash output, and portable exports contain references and safe observations only.
- Host replacement restores product relationships but leaves protected profiles unavailable until device reauthorization or Host-only private-material import completes.
- Product UI names the `local-user-trust` limitation, and Stage 3 shared-account work cannot claim completion without a separately accepted Credential Broker design and adversarial isolation test.

## Risks

DPAPI does not protect against compromise of the Host Windows account, a privileged administrator, malicious installed Host code, a same-user Agent that locates and decrypts the blob, or a value already resident in trusted provider memory. JavaScript strings also prevent reliable zeroization. The Provider reduces plaintext-at-rest and accidental-propagation exposure but must not be used as evidence of process isolation.

Adding protection metadata to the generic seam affects every credential Provider and test fake, and careless defaults could silently label legacy sources as safe. The change must require explicit provider declarations. A Host-bound store also makes disaster recovery depend on reauthorization; the UI and backup flow must make that consequence visible before failure.
