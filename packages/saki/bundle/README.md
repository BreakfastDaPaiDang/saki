# `@breakfastdapaidang/saki-bundle`

English | [中文](README.zh.md)

The private Saki composition root. Its [`dsh.bundle`](package.json) declaration points at [`cordis.patch.yml`](cordis.patch.yml), which inserts the single `saki-readiness` startup row over an empty [`cordis.yml`](cordis.yml). The row provides the stable `{"product":"saki","status":"ready"}` record. The launcher writes it to stdout and requests clean exit only after `boot()` completes its entry-activation audit; a reporting failure disposes the application and enters the launcher failure path.

From the repository root, run:

```sh
pnpm run saki
```

The command launches the TypeScript source through the repository's ESM hook and path mappings. After `pnpm run build:lib:host`, the artifact-plane equivalent is `node packages/saki/bundle/lib/bin.js`. Both resolve the same package-declared patch. Neither command reads credentials, starts a server, calls a model, or replaces the Windows host wrapper described in [Saki host launcher](../../../docs/saki/host-launcher.md).

## Model Experience

None, as the empty composition makes no model request and contributes no model-visible input.

#### KV Cache effect

None; the empty composition has no request prefix.

## Known Limitations and Deferred Work

- **Readiness is the only product behavior** — persistence, identity, GitHub, Agents, model providers, and Web surfaces join through later independently tested slices.
- **The executable is repository-local** — Saki packages are private and absent from every npm release family.
- **Readiness intentionally exits** — a long-lived Saki process begins only when a later surface replaces or extends this empty composition.
