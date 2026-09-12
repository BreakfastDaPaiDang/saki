# Agent Note: Build dependency security containment

Status: implemented

English | [中文](2026-09-12-build-dependency-security-containment.zh.md)

## Problem

Desktop runtime preparation needs one executable from the Windows Node.js ZIP, but general archive extraction exposes filesystem behavior for every entry. Website tooling can also retain vulnerable transitive dependencies after direct dependencies receive compatible security patches.

## Decision

[Windows runtime preparation](../../../../apps/desktop/scripts/prepare-runtime.ts) verifies the upstream archive checksum, selects the exact release-and-architecture `node.exe` entry through `fflate`, and writes its bytes to a caller-owned path with exclusive creation. Archive paths and symbolic-link metadata never determine filesystem destinations. The existing executable version check verifies the resulting runtime. The [desktop packaging decision](../architecture/2026-08-25-electron-desktop-packaging-and-updates.md) owns runtime isolation and release integrity.

[Workspace overrides](../../../../pnpm-workspace.yaml) select patched Vite 6 only beneath stable VitePress 1.6.4; the website declares the same Vite version range. This exception remains scoped to that parent version and requires a successful website build and fragment-link verification. Dependency updates preserve the [maintenance quarantine policy](2026-09-05-saki-maintenance-work-ownership.md).

## Alternatives considered

**Keep general ZIP extraction.** Desktop needs no directories, npm payload, or symbolic links from the Windows archive. Selecting bytes removes those extraction semantics and the vulnerable `extract-zip` dependency without owning a ZIP parser.

**Move website tooling to a prerelease VitePress major.** A major migration expands compatibility work beyond the dependency repair. The stable VitePress and Vue plugin build with patched Vite 6; a parent-qualified override records that limited compatibility decision.

## Consequences

ZIP selection buffers the selected executable in memory and deliberately cannot unpack a complete Node.js distribution. Tests verify missing and malformed archives, refusal to overwrite existing output, and preservation of files outside the destination despite traversal, absolute-path, and symbolic-link entries. The Windows runtime smoke executes bundled Node.js and pnpm and checks their versions. A VitePress update requires re-evaluating its Vite dependency instead of carrying a global Vite override forward.
