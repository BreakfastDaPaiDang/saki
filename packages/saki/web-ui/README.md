---
description: "Register local Projects, plan GitHub Work Items on a confirmed Board, and inspect Issue, execution, Milestone, and Release evidence in the Saki Web client."
kind: "package-reference"
---

# `@breakfastdapaidang/saki-web-ui`

English | [中文](README.zh.md)

## Summary

Register an existing directory as a Development Project, plan its GitHub Work Items, and inspect Issue, execution, and Release evidence. The 「项目」 page preserves the selected Board card, detail, Milestone, or workspace across reloads. Failed reads retain confirmed values with their source health; unacknowledged moves retain the exact original Intent for explicit recovery. All protected reads and writes use `ctx.sakiHostClient`.

## Table of Contents

- [Use this package](#use-this-package)
- [Manage My Work](#manage-my-work)
- [Plan a Project](#plan-a-project)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Mount this plugin in a composition that also carries the shell roster and the `/saki` Host API; the two sidebar entries then open the Saki pages.

- `sidebar.primary.action`: entries `saki-work` and `saki-project` render the two primary destinations under New Session, rail-aware through the owner `wide` flag.
- `main.surface`: one chain entry elects on the generic shell surface token (`saki:work` / `saki:project`); with no election the Conversation fallback renders, and it stays mounted under a takeover so in-progress conversation state survives.
- The navigation store publishes the surface token through `ctx.layout.requestSurface`. The Saki sidebar entries elect their surface; the Conversation fallback renders exactly while no Saki surface is elected.
- A user-driven Session navigation reported by the Workspace navigation face (`uiWorkspace.onSessionNavigation`: a sidebar Session row, New Session, or fork open) clears the surface, handing the center column back to the Conversation; elections with no gesture behind them — the shell's startup Workspace auto-connect and the persisted-selection restore — never evict an elected page, so a restored 项目 page survives them, mid-registration included.

Directory edits supersede pending inspections. Registration disables path edits until the submitted Intent settles; a conflict requires refreshed registry revision and inspection evidence before confirmation becomes available again.

<a id="manage-my-work"></a>
## Manage My Work

The Work page displays the backend's cross-Project groups and one recommended action per card. Select a Project, enter a title, intended outcome, and acceptance criteria, then create the GitHub Issue in Inbox. Plan the Inbox item on its Board; Ready suggestions appear in My Work. The form uses that Project's current revision and Board mapping revisions; an unavailable Project does not hide other Projects or their readable work.

Give to Agent requires explicit confirmation of the projected Agent Profile, model route, binding label, and inherited change count. Submission rechecks the displayed Project revision and Issue fingerprint. Answer a pending Intervention at its displayed revision, then open the Work Item to inspect execution and delivery evidence or return to its inherited Session. These manual gestures do not automatically claim Ready work or mark it Done.

Requirement drafts, answer text, and exact submitted Intents persist under the authenticated Principal. A lost response retains the original payload; Check or resume sends that same Intent with current request authority. Partial creation retains the known Work Item and the backend's recovery action. Reconciliation results remain inspectable; they cannot be dismissed into a duplicate creation. Dismissing a successful creation clears its submitted draft. Principal changes cancel old reads and hide their facts and inputs.

<a id="plan-a-project"></a>
## Plan a Project

Select a registered Project to open its Board. The seven mapped statuses follow the server's confirmed GitHub Project order; Canceled is hidden until selected. Open repository Issues outside the Project have an explicit Inbox marker. Drag a card or use its move dialog to submit the same fingerprint-fenced operation, including an optional predecessor. Pending placement stays separate from the confirmed status. A conflict restores the latest confirmed facts and requires a new gesture.

Open a card for its complete Issue body and acceptance criteria, linked Sessions and Runs, pending Intervention questions, Git/PR/CI and acceptance evidence, Milestones, and recent activity references. Opening a Session uses the inherited Conversation; returning to Project restores its address. Milestone views separate Saki phase from Work Item status and retain independent Release-source confirmations and blockage reasons.

Invalid Status mapping disables Board writes. Authorized users can select an existing GitHub single-select field and seven distinct options in Status mapping; only a successful complete scan re-enables writes. Workspace and inherited Session destinations remain reachable. Project planning has no Issue creation form; incomplete creation facts link to the Work flow that owns submission and recovery.

One planning controller owns protected query caches and cancellable invalidation polling. Notifications trigger complete reads; they never patch a Board. Principal changes clear cached business facts. Persisted state contains Principal-scoped addresses, drafts, and exact unacknowledged Intents, without request tokens or GitHub credentials. A transport failure requires refresh or a connection-reset notification before polling resumes.

<a id="model-experience"></a>
## Model Experience

Indirectly, through confirmed Give-to-Agent and Intervention-answer Intents whose durable Session input, model routing, and execution belong to the Agent runtime.

#### KV Cache effect

Session input and KV-cache effects follow the owning Agent runtime. Reading and refreshing Work or Project views adds no model input.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- **Manual Work only** — automatic claiming, budget suspension, and automatic completion remain separate workflows. The default bundle has no production model adapter, so a usable configured model route is required for Agent execution.
- **Configured Milestones only** — the Milestone destination lists existing Saki delivery records; creating Milestone or Release metadata belongs to its owning workflow.
- **Directory selection is a validated path input** — the browse dialog is not composed in this slice; the backend re-inspects any submitted path before registration.
- **Repair and rebind are read-only here** — binding `missing` / `repair-required` states render with history readable and no repair action; they belong to the Resource Binding slice (#26).

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No runtime invariant companion is published because the package only renders Saki Projections through the shell's additive slots and submits Intents through `saki-host-api`; it emits no cordis events and owns no cross-plugin mutable state, and its slot registrations prove disposal through the HMR-safety spec.

</details>
