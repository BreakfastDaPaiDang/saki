# `@breakfastdapaidang/saki-bundle`

English | [中文](README.zh.md)

The private Saki composition root. Its [`dsh.bundle`](package.json) declaration points at [`cordis.patch.yml`](cordis.patch.yml), which mounts a JSON default storage backend, a dedicated SQLite route for `saki_control_plane`, JSONL Session persistence, Workspace, local filesystem and subprocess providers, the Local Host execution provider, a loopback Web server, Connection, the Saki control plane, the `/saki` Host API, and `saki-readiness` over an empty [`cordis.yml`](cordis.yml). The readiness row provides the stable `{"product":"saki","status":"ready"}` record. The launcher writes it only after `boot()` completes its entry-activation audit; a reporting failure disposes the application and enters the launcher failure path.

From the repository root, run:

```sh
pnpm run saki
```

The command launches the TypeScript source through the repository's ESM hook and path mappings. After `pnpm run build:lib:host`, the artifact-plane equivalent is `node packages/saki/bundle/lib/bin.js`. Both resolve the same package-declared patch and stay alive until `SIGINT` or `SIGTERM`. `SAKI_ONESHOT=1` retains a ready-and-exit mode for assembled smokes and snapshots.

Every non-oneshot start also writes one launcher-handoff JSON line containing `bootstrapPurpose`, `bootstrapSecret`, and the loopback base `url`. The purpose is `initial-bootstrap` before first completion and `local-reauthentication` thereafter. The clear secret is intended only for immediate local sign-in: do not redirect, persist, or publish that line. A restart preserves older unexpired challenges while issuing a fresh one; exchanging any issued challenge consumes it and revokes the others.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `SAKI_DATABASE_PATH` | `dshHomePath('saki', 'control.sqlite')` | SQLite control-plane database; `:memory:` is suitable only for tests |
| `SAKI_PORT` | `43119` | Loopback HTTP port, an integer from `1` through `65535` |
| `SAKI_ONESHOT` | unset | Set to `1` to print readiness and exit without consuming a bootstrap handoff |

## Model Experience

None, as the local Host composition makes no model request and contributes no model-visible input.

#### KV Cache effect

None; the composition has no request prefix.

## Known Limitations and Deferred Work

- **First-registration lifecycle only** — the Host supports local access, existing-directory inspection, initial Development Project registration, the Project index, and the Development Workspace. Resource Binding rebind and retirement, repository mutation, GitHub, Agents, model providers, and rendered Web surfaces are not composed.
- **The executable is repository-local** — Saki packages are private and absent from every npm release family.
- **Loopback development Host only** — the fixed local bootstrap flow does not authorize remote browsers or replace the Windows Host wrapper described in [Saki host launcher](../../../docs/saki/host-launcher.md).
