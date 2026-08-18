# Agent Note: Provision CI pnpm via pnpm/action-setup

Status: implemented

English | [中文](2026-07-26-pnpm-action-setup-for-symmetric-ci-caching.zh.md)

## Problem

Outside `landlock-run.yml`, each workflow that installed pnpm hand-provisioned it with `corepack enable`, and five of them further repeated a hand-rolled cache setup — `pnpm store path --silent >> $GITHUB_OUTPUT`, then `actions/cache@v4` keyed on `pnpm-lock.yaml`: `e2e.yml`, `docs-pages.yml`, `pi-ai-provider-e2e.yml`, `build-exe-for-python-sdk.yml`, and the node-compat, serial-linux, and benchmark jobs of `ci.yml`. The maintained equivalent — `pnpm/action-setup@v4` (reads `packageManager` from package.json) plus `actions/setup-node` with `cache: pnpm` — was already proven in-repo in `landlock-run.yml`, and corepack's removal from newer Node distributions made every `corepack enable` a known future break.

## Decision

`pnpm/action-setup@v4` is the only pnpm provisioning mechanism in CI: no workflow runs `corepack enable`. The root dev dependency on `@yarnpkg/cli-dist` separately supplies the modern Yarn CLI exercised by the generated-project e2e; package-manager coverage therefore does not inherit the runner image's Yarn Classic. Caching remains per-job policy on top of pnpm provisioning, in three deliberate shapes:

- **Symmetric cache** (restore and save): `actions/setup-node` with `cache: pnpm` — `e2e.yml` on manual dispatch, `docs-pages.yml` on version tags or manual dispatch, `pi-ai-provider-e2e.yml`, `build-exe-for-python-sdk.yml`, and the node-compat and two benchmark jobs of `ci.yml`. The larger-runner benchmark keeps its store cache Linux-only through a conditional `cache:` input; the consolidated benchmark caches on both platforms.
- **Restore-only** (hand-rolled `actions/cache/restore` steps): the three required ready-pull-request Linux jobs restore without saving, keeping cache compression and upload off their latency-sensitive paths — an asymmetry `setup-node`'s cache cannot express. Each configures a store outside the action's replaceable install directory and accepts a compatible prefix cache when one exists. Saki has no automatic default-branch producer, so cache absence or eviction must remain a supported cold-install path.
- **Run-scoped or cache-less**: the Wine-based required Windows job may save its dependency archives only for reruns of the same pull-request ref; the manual native Windows suite and release-bound `sandbox.yml` use a cold or runner-local pnpm store. Extracting the many-file pnpm store can cost more than a clean Windows install, so native Windows does not transfer one.

## Alternatives considered

- **Keep the hand-rolled steps.** They worked, but they were drifting copies of setup boilerplate, and the corepack dependency was a known future break.
- **Convert the enterprise jobs' caching to `cache: pnpm`.** Rejected: the restore-only asymmetry is a documented latency decision in `ci.yml`'s comments; erasing it to unify tooling inverts the priority.
- **Add an automatic default-branch cache producer.** Rejected for Saki: a master-push producer spends minutes after every merge without contributing a merge verdict. Restore-only jobs must remain correct when no compatible cache exists; a future producer requires separate cost evidence.
- **Stop at the cache-bearing workflows and leave the other `corepack enable` sites.** Rejected: provisioning and caching are separable concerns, and leaving corepack in the cache-less jobs kept the future break and two provisioning idioms for no benefit.
- **Rely on the runner image's Yarn.** Rejected: the hosted image exposes Yarn 1.22 after Corepack is removed, while the generated-project e2e requires Yarn 2 or newer. A locked root dev dependency makes that coverage independent of runner image contents.
- **A composite action wrapping action-setup + setup-node.** Rejected for now: the remaining per-job variation (node-version matrices, per-platform conditional caching, the restore-only pairing) is deliberate policy, not boilerplate — a wrapper would grow mirroring inputs or flatten a real asymmetry, and the two-line pair is already near the floor.

## Consequences

- The corepack dependency is gone from CI entirely; pnpm arrives via the pnpm team's official action everywhere, and the version pin stays single-sourced in `package.json`'s `packageManager` field.
- The generated-project e2e runs the root-pinned Yarn 4 CLI instead of inheriting or silently skipping the runner image's Yarn version.
- The cache-key format changed once for converted lanes; one cold run repopulated it, after which hit rates match the old steps. The built-in key spans platform, arch, and the lockfile hash but not the Node version, so the node-compat matrix legs share one store entry — safe, because the pnpm store is Node-version-independent.
- `setup-node`'s built-in pnpm cache restores by exact key only, with no `restore-keys` prefix fallback: a `pnpm-lock.yaml` change starts a converted lane from a cold store instead of seeding from the previous entry.
- `pnpm/action-setup` deletes its install directory on every run and places the default store beneath the resulting `PNPM_HOME`. Linux jobs with restore-only caches therefore set `PNPM_CONFIG_STORE_DIR` to `$HOME/.local/share/pnpm/store`, outside the action directory, and resolve the stable path used by any compatible existing cache.
