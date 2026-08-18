# Saki Development Skill Pack

English | [中文](development-skill-pack.zh.md)

The Saki Development Skill Pack is a repository-owned set of agent instructions for planning, implementation, review, and handoff. DSH discovers the pack from `.dsh/skills` at the project root, so a clean checkout supplies the same instructions without relying on a user's global skill installation.

## Included workflows

| Skill | Role |
| --- | --- |
| `ask-matt` | Select the next workflow and the appropriate Session boundary. |
| `grill-with-docs` | Refine a design while maintaining domain and decision documents. |
| `grilling` | Stress-test a plan before implementation. |
| `domain-modeling` | Maintain domain contexts and architecture decisions. |
| `to-spec` | Publish an agreed product specification. |
| `to-tickets` | Split an accepted specification into independently executable Work Items. |
| `triage` | Classify and prepare tracker items for an Agent. |
| `implement` | Implement an accepted specification or Work Item. |
| `tdd` | Apply test-driven development to behavioral changes. |
| `code-review` | Review a change against the repository's contracts and evidence. |
| `handoff` | Write a portable implementation handoff under `.scratch/handoffs/`. |

## Discovery and verification

DSH's filesystem skill provider finds `.dsh/skills` by walking from the active working directory to the project root. Project-owned skills take their ordinary `project-dsh` precedence; the pack does not copy instructions into `.agents`, `.codex`, or a user home directory.

The offline verifier checks the frozen skill set, adapted output hashes, source blob declarations, patch hashes, resource links, license, compatibility metadata, and symbolic-link prohibition. The discovery test loads the real filesystem provider from an isolated clean project with isolated DSH and Agents homes.

```sh
pnpm run verify-saki-skill-pack
pnpm run test:saki-skill-pack
```

## Compatibility preflight

Every included `SKILL.md` declares the required DSH capabilities, alternative capabilities, optional capabilities, host commands, and mutation class in frontmatter and repeats the user-facing check under `DSH compatibility preflight`. A skill must stop with an actionable diagnostic before mutation when a required capability or command is absent. Tracker workflows name `BreakfastDaPaiDang/saki` explicitly in every `gh` command.

## Updating the pin

The updater accepts only a full 40-character commit and performs a dry run by default. It fetches the exact commit from `mattpocock/skills`, rejects additions or removals outside the reviewed source and ignored-file allowlists, applies the checked-in per-skill patches, and reports changed outputs without modifying the repository.

```sh
pnpm run update-saki-skill-pack -- --ref <40-character-commit>
pnpm run update-saki-skill-pack -- --ref <40-character-commit> --write
```

`--write` also requires clean `.dsh/skills` and `.dsh/skill-pack` trees. Review every rewritten instruction and patch before committing, then run the verifier, discovery test, assembled snapshots, and documentation checks.

## Provenance

[`.dsh/skill-pack/manifest.json`](../../.dsh/skill-pack/manifest.json) records the upstream repository, exact commit and date, selected and ignored upstream Git blobs, adaptation patch hashes, output hashes, and capability declarations. [The preserved MIT license](../../.dsh/skill-pack/LICENSE.mattpocock-skills) and [third-party notices](../../THIRD_PARTY_NOTICES.md) cover the embedded instructions. The patches are the reviewable difference between the upstream files and the repository-owned DSH variants.
