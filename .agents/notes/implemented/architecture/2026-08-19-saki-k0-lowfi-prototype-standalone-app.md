# Agent Note: Saki 0.1.0 low-fi prototype as a standalone fixture-driven app

Status: implemented

English | [中文](2026-08-19-saki-k0-lowfi-prototype-standalone-app.zh.md)

## Problem

K0 (issue #42) requires a clickable, keyboard-operable low-fi prototype that proves the two new top-level pages before K1–K6 split production frontend work. The shipped DSH web client boots only inside the dsh host (host-injected boot data, cordis plugin tree, built `lib/` bundles), and the two shell slots Saki needs (`main.surface`, `sidebar.primary.action`) do not exist yet — embedding the prototype in the real client would pull K1 shell work into K0. At the same time, the prototype must faithfully demonstrate the frontend contract (complete Projections with revisions, typed Intents with expected revisions, Action Offers as projection facts, ten view-state semantics), not a free-form mockup.

## Decision

The prototype lives at `prototypes/saki-0.1.0-web/` as a standalone Vite + React + TypeScript app with its own npm lockfile, outside the pnpm workspace globs, so knip/publint/constraints/coverage gates do not apply to a throwaway-decision artifact. It is product-representative, not production code: CSS Modules over DSH-dark-inspired tokens, Chinese product copy, and the same props-down component discipline as `packages/client/*`.

A fixture control plane (`src/fixtures/engine.ts`) implements exactly the contract's three control-plane operations — `query` returning complete Projections with monotonic revisions, `submit` returning stable receipts for typed Intents, and `onChanged` as a post-commit invalidation that always triggers a full re-query. Eleven named, switchable scenarios (`src/fixtures/scenarios.ts`) each document the Projections they simulate, the Intents they accept, and the outcomes they demonstrate; one scripted override (first-move board conflict) delegates back to the default handler after firing. Components never join records or infer buttons from Work Item Status; My Work renders the projection's presentation groups and at most one offer per item.

Navigation owns typed `SakiViewAddress` values serialized to the URL hash and persisted to localStorage, proving reload and Project-switch preservation without a router. Validation runs as Playwright + axe-core against the production build (`validation/validate.mjs`, 48 checks), and the deliverables (scenario index, affordance→Projection/Intent mapping, open questions, validation record) are the four markdown files beside the app.

## Alternatives considered

**Embed the prototype in the real DSH client as `packages/saki/web-ui` with a fixture transport.** This is K1 scope: it needs the two shell slots added first and a bootable host, so the IA review would block on shell engineering — exactly the ordering K0 exists to avoid. The production implementation in K1+ still follows this path; the prototype's component structure is designed to port.

**A workspace package under `apps/`.** Every workspace member inherits the hygiene, typecheck, coverage, and knip registration surfaces; a review artifact whose purpose is to be replaced should not register in those gates. The prototype stays one directory that a later PR deletes without gate edits.

**Static HTML or a Figma-style clickthrough.** The contract's keyboard-equivalence, focus-return, optimistic-conflict-rollback, and state-semantics requirements are behavioral; a static artifact cannot demonstrate them truthfully.

**Build the wire types first and share them with the prototype.** K0 explicitly forbids freezing fixture fields into final API shape; the prototype mirrors contract vocabulary in its own `src/contract/types.ts` and labels every fixture as non-authoritative.

## Consequences

The IA review can start immediately, with keyboard, a11y, and constrained-viewport evidence attached. The fixture engine's intent handlers encode the contract's preconditions (expected revisions, remote fingerprints, eligibility), so several production UI decisions (optimistic overlay with confirmed-value rollback, focus deferral on dialog open, attention-inbox surfacing on My Work) are already tested behaviors rather than open design.

The cost is duplication: tokens, primitives, and a mock shell mirror DSH instead of reusing it, and the prototype must be deleted or superseded when K1 lands the real `main.surface` path. The standalone app also sits outside repo gates, so its own `npm run build` and `validate.mjs` are the only quality fence — acceptable for a review artifact, wrong for anything that ships.
