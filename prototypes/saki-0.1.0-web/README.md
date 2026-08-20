# Saki 0.1.0 Web low-fi interactive prototype (K0 / issue #42)

English | [中文](README.zh.md)

A clickable, keyboard-operable low-fidelity prototype for the two new Saki 0.1.0 top-level pages (「工作」 and 「项目」). It proves that with the shipped DSH shell preserved (Conversation, New Session, Settings), a Host Operator and a beginner can both complete the 0.1.0 task flows on desktop and constrained viewports.

This is not production code: fixture fields express the [frontend contract](../../../docs/saki/architecture/0.1.0-frontend-contract.zh.md) and are not final wire types; layout, density, and color are not acceptance criteria. The scenario tool bar at the bottom is K0-only tooling and does not carry into production.

## Run

```sh
npm ci
npm run dev        # http://localhost:5242
npm run build      # tsc --noEmit + vite build
node validation/validate.mjs   # Playwright + axe checklist against the production build
```

Deep link a scenario with `?scenario=<id>`, e.g. `http://localhost:5242/?scenario=board-conflict`.

## How to read this prototype

- The amber bar at the bottom is **prototype tooling** (not product UI): switch between the twelve named scenarios or open the scenario index, also kept as a document in [SCENARIOS.md](SCENARIOS.md).
- The app talks to a simulated control plane (`src/fixtures/engine.ts`) exposing exactly the contract's three operations: `query` (complete Projection + revision), `submit` (typed Intent + expected revision → one stable receipt id from pending to terminal), and `onChanged` (invalidation → full re-query). A stale expected revision is rejected as a conflict. Components never join backend records or infer buttons from Work Item Status; every Action Offer and its plain-language reason come from the Projection.
- Keyboard: Tab reaches every control; board cards open details with `Enter`, move columns with `Alt+←/→` or the 移动… menu (drag-equivalent); dialogs and the drawer close with Escape and return focus to the invoking control.
- Desktop and constrained viewport (<720px) both complete every flow without requiring multiple panes at once: the sidebar becomes a drawer, the board shows one status column at a time behind a column selector, the item drawer goes full screen, and Sessions shows either list or detail with a back path.

## Layout

- `src/contract/` — Projection / Intent / Action Offer / view-address / state-semantics types mirrored from the contract
- `src/fixtures/` — simulated control plane + named scenarios; each scenario declares the Projections it simulates, the Intents it accepts, and the outcomes it demonstrates
- `src/client/` — snapshot store, navigation (typed `SakiViewAddress`, hash + localStorage persistence), React bindings
- `src/shell/` — AppFrame / sidebar stand-ins (DSH-owned elements preserved) + the prototype tool bar
- `src/pages/` — bootstrap, 「工作」, the six internal 「项目」 sections, inherited Conversation / New Session stand-ins, and the Settings dialog (Model Supply section)
- `validation/` — the Playwright + axe checklist and its results

## Repo gates

The prototype sits outside the pnpm workspace globs, so package-scoped gates (knip, publint, workspace constraints, per-file coverage) do not apply to it. Repo-wide staged gates still do: this README keeps a bilingual pair, staged sources pass lint and whitespace checks, and the K0 Agent Note passes note format and translation-pairing gates.

## Deliverables

- Scenario index: [SCENARIOS.md](SCENARIOS.md)
- Affordance → Projection/Intent mapping: [AFFORDANCES.md](AFFORDANCES.md)
- Open product questions: [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md)
- Validation record: [VALIDATION.md](VALIDATION.md)
