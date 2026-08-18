---
status: accepted
---

# Use DPAPI with an explicit local-user-trust credential boundary

English | [中文](0011-dpapi-local-user-trust-credentials.zh.md)

Saki 0.1.0 uses a generic Windows DPAPI credential Provider for managed OAuth refresh tokens and private keys, while declaring its Credential Protection Level as `local-user-trust`. This protects persisted values without claiming that a deliberate process running as the Host's Windows user cannot recover them.

## Why this decision

The existing `credentials-local` Provider persists plaintext values in `.credentials.yaml`. Its owner-only mode check does not run on Windows, and DSH's Windows sandbox restricts writes rather than reads. Keeping only a `CredentialRef` in product records prevents accidental copying into Projections, events, logs, and Agent context, but it does not protect the underlying file from a same-user Agent process.

Windows DPAPI with current-user scope improves the truthful 0.1.0 boundary: another ordinary OS user cannot decrypt a copied blob through the same API, while Saki can authorize devices and restart unattended without asking for a separate passphrase. DPAPI does not create a process boundary inside one Windows logon identity. Machine scope is weaker because any user on the machine may decrypt machine-scoped data, so Saki forbids it.

## Decision

A generic `credentials-windows-dpapi` Service Provider implements `ctx.credentials` and remains eligible for contribution to upstream DSH. The Saki bundle composes it; Saki does not create a product-specific account vault. The Provider stores managed values only as DPAPI current-user ciphertext and never falls back to plaintext YAML, `.env`, or machine-scoped DPAPI for a reference that Saki classifies as a managed high-value credential.

The credential seam reports a provider-defined Credential Protection Level in both safe description metadata and each resolved result. Saki requires `local-user-trust` for Codex and Kimi refresh tokens and the Saki Product GitHub App private key. A missing value or a value resolved from an ambient or plaintext source fails authorization or dispatch instead of silently weakening the requirement.

Only privileged Host Providers resolve raw values. The control plane, Web API, Projections, Agent tools, Session events, logs, and diagnostics receive `CredentialRef`, protection and health observations, and provider identity only. This is an architectural restriction inside the trusted plugin composition, not a claim that the OS prevents every installed same-user plugin from calling the credential service.

Installation export and Host migration exclude plaintext values and DPAPI ciphertext. A replacement Host reauthorizes device-code accounts and re-imports non-OAuth private material through a Host-only flow. Before Saki lets organization members consume Host-supplied accounts, it must adopt a Credential Broker running under a distinct OS security identity or an external secret manager and verify that Agent execution cannot recover raw values.

## Considered options

**Keep `credentials-local`.** References would continue to limit accidental propagation, but high-value values would remain plaintext at rest and deliberately readable by a same-user Agent. That is too weak for unattended subscription and GitHub App credentials.

**Describe DPAPI or Windows Credential Manager as Agent isolation.** Both operate in the current user's security context. They improve storage handling but do not separate a same-user Agent process from the Host's credential authority, so this would overstate the protection.

**Use machine-scoped DPAPI.** Easier service migration within one computer would grant decryption to other users on that machine and weaken the accepted boundary.

**Require a passphrase after every restart.** This could add a separately held secret, but it would block unattended recovery and automation, and the passphrase would still need a secure runtime path. Version 0.1.0 accepts the local-user limitation instead.

**Build the Credential Broker in 0.1.0.** A separate identity is the right prerequisite for shared organization use, but it adds process isolation, IPC authentication, deployment, recovery, and provider-operation design before the single-operator product needs it. The organization-sharing gate preserves that requirement without pretending it is already implemented.

## Consequences

Credential data is machine- and user-bound rather than portable. Backup and export retain references and safe metadata only, so Host replacement requires explicit reauthorization or re-import. UI and diagnostics must name `local-user-trust` and its limitation instead of presenting a generic secure badge.

The DSH credential seam gains safe protection metadata, while the Windows Provider remains independent of Saki account routing. Tests must prove ciphertext-at-rest, current-user scope, rejection of plaintext and machine-scope fallback for protected references, absence of values from product surfaces and exports, and fail-closed behavior when protection metadata is missing or too weak.
