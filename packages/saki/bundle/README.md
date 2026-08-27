# `@breakfastdapaidang/saki-bundle`

English | [中文](README.zh.md)

The private Saki composition root. Its [`dsh.bundle`](package.json) declaration points at [`cordis.patch.yml`](cordis.patch.yml), which mounts a JSON default storage backend, inert SQLite routes that the launcher replaces with one manifest-selected generation shared by `saki_control_plane@5`, `saki_host_execution@1`, and `saki_storage_generation@3`, JSONL Session persistence, Workspace, local filesystem and subprocess providers, the Local Host execution provider, a loopback Web server, Connection, the Saki control plane, the `/saki` Host API, and `saki-readiness` over an empty [`cordis.yml`](cordis.yml). On Windows it also mounts the current-user DPAPI credential Provider and the read-only Saki Product GitHub App Provider; both rows stay disabled on unsupported hosts instead of reporting a weaker credential source as `local-user-trust`. The readiness row provides the stable `{"product":"saki","status":"ready"}` record. The launcher writes it only after `boot()` completes its entry-activation audit; a reporting failure disposes the application and enters the launcher failure path.

From the repository root, run:

```sh
pnpm run saki
```

The command launches the TypeScript source through the repository's ESM hook and path mappings. After `pnpm run build:lib:host`, the artifact-plane equivalent is `node packages/saki/bundle/lib/bin.js`. Both resolve the same package-declared patch and stay alive until `SIGINT` or `SIGTERM`. `SAKI_ONESHOT=1` retains a ready-and-exit mode for assembled smokes and snapshots.

Before composition boot, the launcher takes the Installation-wide exclusive lease, reconciles the exact named recovery metadata, and selects state only through `installation.json` or, when no manifest exists, the exact configured B03 database. A state-free Installation is provisioned directly at current state v5. Any exact retained v2, v3, or v4 Installation fails with `upgrade-required`; keep its Host offline and run the maintenance upgrade before starting the current build. The launcher retains the lease through preparation, serving, and complete teardown, while malformed or unsupported selected state fails closed.

Every non-oneshot start also writes one launcher-handoff JSON line containing `bootstrapPurpose`, `bootstrapSecret`, and the loopback base `url`. The purpose is `initial-bootstrap` before first completion and `local-reauthentication` thereafter. The clear secret is intended only for immediate local sign-in: do not redirect, persist, or publish that line. A restart preserves older unexpired challenges while issuing a fresh one; exchanging any issued challenge consumes it and revokes the others.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `SAKI_DATABASE_PATH` | `dshHomePath('saki', 'control.sqlite')` | Exact manifest-less B03 source path; it never overrides a manifest and `:memory:` is rejected |
| `SAKI_PORT` | `43119` | Loopback HTTP port, an integer from `1` through `65535` |
| `SAKI_ONESHOT` | unset | Set to `1` to print readiness and exit without consuming a bootstrap handoff |

## Model Experience

None, as the local Host composition makes no model request and contributes no model-visible input.

#### KV Cache effect

None; the composition has no request prefix.

## Known Limitations and Deferred Work

- **Read-only GitHub foundation** — the Windows composition can inspect the Product App and publish confirmed Board reads after the operator installs and configures the App. GitHub Issue, Project-item, Repository, and Workflow mutations remain absent.
- **Bounded Project lifecycle only** — the Host supports local access, existing-directory inspection, initial Development Project registration, Project index and workspace reads, path-free Changes and Diff reads, and direct structured stage, unstage, and Commit operations. Resource Binding rebind and retirement, automated dispatch, Agents, model providers, push, and rendered Web surfaces are not composed.
- **The executable is repository-local** — Saki packages are private and absent from every npm release family.
- **Loopback development Host only** — the fixed local bootstrap flow does not authorize remote browsers or replace the Windows Host wrapper described in [Saki host launcher](../../../docs/saki/host-launcher.md).
