# Agent Note: Saki 0.1.0 low-fi prototype as a standalone fixture-driven app

Status: implemented

English | [中文](2026-08-19-saki-k0-lowfi-prototype-standalone-app.zh.md)

## Problem

K0 (issue #42) requires a clickable, keyboard-operable low-fi prototype that proves the two new top-level pages before K1–K7 split production frontend work. The shipped DSH web client boots only inside the dsh host (host-injected boot data, cordis plugin tree, built `lib/` bundles), and the two shell slots Saki needs (`main.surface`, `sidebar.primary.action`) do not exist yet — embedding the prototype in the real client would pull K1 shell work into K0. At the same time, the prototype must faithfully demonstrate the frontend contract (complete Projections with revisions, typed Intents with expected revisions, Action Offers as projection facts, text-first view-state semantics), not a free-form mockup.

## Decision

The prototype lives at `prototypes/saki-0.1.0-web/` as a standalone Vite + React + TypeScript app with its own npm lockfile. It sits outside the pnpm workspace globs, so package-scoped gates (knip, publint, workspace constraints, per-file coverage) do not apply; repo-wide staged gates still do — the README keeps a bilingual pair, staged sources pass lint and whitespace checks, and this note passes note-format and translation-pairing gates. The app is product-representative, not production code: CSS Modules over DSH-dark-inspired tokens, Chinese product copy, and the same props-down component discipline as `packages/client/*`.

A fixture control plane (`src/fixtures/engine.ts`) implements the contract's three control-plane operations with real protocol behavior: `query` returns complete Projections with monotonic revisions; `submit` validates the caller's expected revision against the subject Projection (stale means conflict and the handler never runs), mints one stable receipt id that survives from pending to terminal, dedupes identical in-flight Intents, and blocks duplicate submission while pending; `onChanged` invalidates keys and always triggers a full re-query. Twelve named scenarios (`src/fixtures/scenarios.ts`) declare the Projections they simulate, the Intents they accept, and the outcomes they demonstrate — including partial CreateWorkItem results, acknowledgement loss with reconcile-then-safe-retry, board fingerprint conflicts with optimistic overlay rollback, and the sync `saved → revalidating → scanning → checkpointed → activated` chain in Project Settings. Project fixtures are fully separated per project; handlers resolve the owning project from the intent and never hardcode one.

Navigation owns typed `SakiViewAddress` values covering Work Item, Work Session, Agent Run, Milestone, file, and Board filter state, serialized to the URL hash and persisted to localStorage; the Settings dialog records its owning address and returns there. Validation is a Playwright + axe-core checklist against the production build (`validation/validate.mjs`), and the deliverables (scenario index, affordance→Projection/Intent mapping, open questions, validation record) are the markdown files beside the app.

The prototype gates K1–K7: K1 (shell, auth, Project registration/rebind), K2 (My Work and production CreateWorkItem), K3 (Board, Work Item, Milestone/Release, mapping repair), K4 (Changes, Agent Run, Trace, PR/CI delivery), K5 (Model Supply, Context, Generation Job), K7 (Project Settings as the sole editable owner), then K6 (recovery, narrow viewport, keyboard, accessibility closure). None of them starts from prototype fixtures; each waits for its own backend Projection/Intent fixtures.

## Alternatives considered

**Embed the prototype in the real DSH client as `packages/saki/web-ui` with a fixture transport.** This is K1 scope: it needs the two shell slots added first and a bootable host, so the IA review would block on shell engineering — exactly the ordering K0 exists to avoid. The production implementation in K1+ still follows this path; the prototype's component structure is designed to port.

**A workspace package under `apps/`.** Every workspace member inherits the hygiene, typecheck, coverage, and knip registration surfaces; a review artifact whose purpose is to be replaced should not register in those gates. The prototype stays one directory that a later PR deletes without package-gate edits; it still honors the repo-wide staged gates that apply to any committed file.

**Static HTML or a Figma-style clickthrough.** The contract's keyboard-equivalence, focus-return, optimistic-conflict-rollback, and state-semantics requirements are behavioral; a static artifact cannot demonstrate them truthfully.

**Build the wire types first and share them with the prototype.** K0 explicitly forbids freezing fixture fields into final API shape; the prototype mirrors contract vocabulary in its own `src/contract/types.ts` and labels every fixture as non-authoritative.

## Consequences

The IA review proceeds with keyboard, a11y, and constrained-viewport evidence attached. The fixture engine enforces the contract's preconditions (expected revisions, remote fingerprints, eligibility), so several production UI decisions (optimistic overlay derived from the confirmed snapshot with insertion into the target column, focus deferral on dialog open, attention grouped by reason on My Work, field-scoped Project Settings edits with the sync activation chain) are tested behaviors rather than open design.

The cost is duplication: tokens, primitives, and a mock shell mirror DSH instead of reusing it, and the prototype is deleted or superseded when K1 lands the real `main.surface` path — including the prototype-only scenario tool bar, which production does not inherit. The standalone app also relies on its own `npm run build` and `validation/validate.mjs` as its only quality fence beyond the repo-wide staged gates — acceptable for a review artifact, wrong for anything that ships.
