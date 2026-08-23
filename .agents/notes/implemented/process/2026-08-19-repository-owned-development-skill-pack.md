# Agent Note: Repository-owned development skill pack

Status: implemented

English | [中文](2026-08-19-repository-owned-development-skill-pack.zh.md)

## Problem

Saki relies on repeatable planning, implementation, review, and handoff practices, but user-global skill installations are mutable and differ between machines. Copying instructions from a local Codex installation would obscure their source and license, while consuming an upstream branch directly would let reviewed behavior change without a repository diff. Upstream instructions also assume tools, paths, tracker defaults, and invocation behavior that DSH does not always provide.

## Decision

The repository owns an adapted 11-skill set under [`.dsh/skills`](../../../../.dsh/skills). DSH's existing filesystem provider discovers this location as `project-dsh`, so the pack uses the ordinary plugin capability and does not add a second skill loader or install files into user homes.

[The manifest](../../../../.dsh/skill-pack/manifest.json) pins one full `mattpocock/skills` commit and records each selected source blob, deliberately ignored upstream file, adaptation patch, output hash, compatibility declaration, and preserved MIT license. A repository-owned patch per skill makes DSH-specific changes reviewable without presenting a local installation as source. The frozen set contains `ask-matt`, `grill-with-docs`, `grilling`, `domain-modeling`, `to-spec`, `to-tickets`, `triage`, `implement`, `tdd`, `code-review`, and `handoff`; `codebase-design` and alias wrappers are outside this set.

Each instruction declares its required, alternative, and optional capabilities, host commands, and mutation class. Its compatibility preflight stops before mutation when a required facility is unavailable. Tracker workflows run non-repository commands such as `gh auth status` without `-R` and pass `-R BreakfastDaPaiDang/saki` to every repository-scoped `gh` command; the handoff workflow writes only below `.scratch/handoffs/`.

The update command requires a full commit, defaults to dry-run, verifies the current pack, fetches only the named upstream revision, rejects upstream inventory outside reviewed allowlists, and reapplies the checked-in patches. It materializes the requested commit in every adapted skill and verifies the complete candidate offline. Publication stages the current `.dsh` directory, replaces only the owned skill and provenance subtrees, and swaps that directory with rollback. `--write` refuses dirty pack trees; a rejected candidate does not change the checked-out pack.

## Verification

The portable offline verifier rejects provenance drift, changed outputs or patches, unexpected files, symbolic links, broken resource links, inconsistent compatibility metadata, and a skill set other than the frozen eleven. The focused test loads the actual filesystem skill provider from an isolated clean project and isolated home directories. Keyless assembled ACP snapshots cover a planning-to-handoff flow and an actionable preflight failure when a required shell capability is absent. Third-party notices disclose the pinned source and preserved license.

## Alternatives considered

**Depend on user-global Matt skills.** This avoids vendored instructions but makes behavior depend on mutable machine state and prevents a clean checkout from reproducing the development workflow.

**Load the upstream repository or branch at runtime.** This reduces checked-in files but introduces network availability, moving-source, and unreviewed-instruction risks at the moment an Agent acts.

**Copy the local Codex installation.** This is convenient on one machine but does not prove upstream provenance and can incorporate local edits or installation-specific metadata.

**Introduce a Saki-specific skill loader.** The existing DSH filesystem provider already discovers repository skills with defined precedence, so another loader duplicates lifecycle and discovery behavior.

## Consequences

Skill changes are ordinary repository changes with reviewable provenance, bilingual operating documentation, license disclosure, and keyless evidence. A checkout can discover the same pack on Linux, macOS, and Windows without external credentials.

Updating the upstream pin is intentionally review-heavy: upstream inventory changes require an explicit allowlist decision, patch conflicts stop the update, and adapted output changes require new hashes and snapshots. The pack cannot promise that every skill runs in every DSH composition; explicit preflight converts a missing capability into a diagnostic before mutation.
