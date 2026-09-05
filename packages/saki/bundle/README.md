# `@breakfastdapaidang/saki-bundle`

English | [中文](README.zh.md)

The private Saki composition root. Its [`dsh.bundle`](package.json) declaration points at [`cordis.patch.yml`](cordis.patch.yml), which mounts timer scheduling, a JSON default storage backend, inert SQLite routes that the launcher replaces with one manifest-selected generation shared by `saki_control_plane@9`, `saki_host_execution@4`, and `saki_storage_generation@7`, JSONL Session persistence, the provider-neutral LLM, Agent, System Prompt, Tools, Agent Loop, preset, and checkpoint-policy runtime, Workspace, local filesystem and subprocess providers, the sandboxed PowerShell stack, the Local Host execution provider, a loopback Web server, Connection, the Saki control plane, the `/saki` Host API, and `saki-readiness` over an empty [`cordis.yml`](cordis.yml).

The launcher binds the preset roster to the package's absolute `config/agent-presets` path and disables the user preset root. The shipped `development` preset contributes repository instructions, the durable `request_intervention` tool, foreground PowerShell on Windows, and read/write/edit tools over an Agent-isolated sandboxed filesystem; Host operations continue to use the separate local filesystem provider. Production installs no model adapter, and creating or resuming an Agent leaves it idle until the operation that owns the Agent Run supplies durable input.

On Windows the composition also mounts the current-user DPAPI credential Provider and the Saki Product GitHub App Provider; both rows stay disabled on unsupported hosts instead of reporting a weaker credential source as `local-user-trust`. Startup restores every control-plane-validated running Agent from its exact succeeded Host Operation and physical Session evidence before the launcher publishes readiness or the bootstrap handoff. The readiness row provides the stable `{"product":"saki","status":"ready"}` record. The launcher writes it only after `boot()` completes its entry-activation audit; a reporting failure disposes the application and enters the launcher failure path.

From the repository root, run:

```sh
pnpm run saki
```

The command launches the TypeScript source through the repository's ESM hook and path mappings. After `pnpm run build:lib:host`, the artifact-plane equivalent is `node packages/saki/bundle/lib/bin.js`. Both resolve the same package-declared patch and stay alive until `SIGINT` or `SIGTERM`. `SAKI_ONESHOT=1` retains a ready-and-exit mode for assembled smokes and snapshots.

Before composition boot, the launcher takes the Installation-wide exclusive lease, reconciles the exact named recovery metadata, and selects state only through `installation.json` or, when no manifest exists, the exact configured B03 database. A state-free Installation is provisioned directly at current state v9. Any exact retained v2 through v8 Installation fails with `upgrade-required`; keep its Host offline and run the retained maintenance upgrade into v9 before starting the current build. The launcher retains the lease through preparation, serving, and complete teardown, while malformed or unsupported selected state fails closed.

Every non-oneshot start also writes one launcher-handoff JSON line containing `bootstrapPurpose`, `bootstrapSecret`, and the loopback base `url`. The purpose is `initial-bootstrap` before first completion and `local-reauthentication` thereafter. The clear secret is intended only for immediate local sign-in: do not redirect, persist, or publish that line. A restart preserves older unexpired challenges while issuing a fresh one; exchanging any issued challenge consumes it and revokes the others.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `SAKI_DATABASE_PATH` | `dshHomePath('saki', 'control.sqlite')` | Exact manifest-less B03 source path; it never overrides a manifest and `:memory:` is rejected |
| `SAKI_PORT` | `43119` | Loopback HTTP port, an integer from `1` through `65535` |
| `SAKI_ONESHOT` | unset | Set to `1` to print readiness and exit without consuming a bootstrap handoff |

## Model Experience

None, as the local Host composition delegates every model-facing input and request to its mounted packages.

#### KV Cache effect

The base Host installs no model adapter, so starting a Session or restoring an already-running Run makes no model request, wake, or model-visible message. When a model provider is configured, recovery of an accepted but undelivered Intervention answer may append only that exact answer, wake its owning Run, and issue the corresponding request. Other Agent Run input still enters through an explicitly configured route. The `development` preset adds its stable persona and tool-schema prefix, including durable `request_intervention` plus `read`, `write`, `edit`, and Windows `pwsh`; repository instructions and current sandbox/approval facts remain request context, provider-specific cache behavior belongs to the selected route, and an Intervention answer is append-only input after the existing Session prefix.

## Known Limitations and Deferred Work

- **Constrained GitHub mutations** — after the operator installs and configures the Product App, the Windows composition can publish confirmed Board reads, execute recoverable `CreateWorkItem` and `MoveWorkItem` sagas, and create Branch Delivery pull requests from exact Repository, head, base, and Commit identity through a persisted marker. Arbitrary Issue editing, Repository Contents, and Workflow writes remain absent.
- **Bounded Project lifecycle only** — the Host supports local access, existing-directory inspection, initial Development Project registration, Project index and workspace reads, display-safe Changes and bounded Diff reads with canonical Host paths kept private, and direct structured stage, unstage, and Commit operations whose browser requests carry no paths. Branch Delivery Push is composed through the Local Host but remains unavailable under the default unset `pushCredentialHelper`; an operator must select `git-credential-manager` or `git-credential-manager-core`. Resource Binding rebind and retirement, automated dispatch, production model adapters, and rendered Web surfaces are not composed.
- **Fixed Product Agent capabilities** — only the system-owned `development` preset is discoverable. User-authored presets remain outside the Saki Host until their authorization and Project Profile selection semantics are defined.
- **The executable is repository-local** — Saki packages are private and absent from every npm release family.
- **Loopback development Host only** — the fixed local bootstrap flow does not authorize remote browsers or replace the Windows Host wrapper described in [Saki host launcher](../../../docs/saki/host-launcher.md).
