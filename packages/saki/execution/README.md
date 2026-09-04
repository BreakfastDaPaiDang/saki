# `@breakfastdapaidang/saki-execution`

English | [中文](README.zh.md)

The private Saki Host Execution Service Definition registers `ctx.sakiHostExecution`. It defines provider-neutral project inspection and Diff values plus the durable Host Operation lifecycle used for structured StageFiles, UnstageFiles, Commit, PushBranch, and Agent Run start effects. The [Saki control plane](../control-plane/README.md) owns authorization, Project policy, write admission, and durable Control Intents. The wider control-plane and execution-plane split is defined by the [Saki backend architecture](../../../docs/saki/architecture/0.1.0-backend.md).

## Project-selection inspection

The request contains a selected Saki Host id and a caller-supplied directory locator. The locator is untrusted input: a provider resolves and inspects it independently on every call, and neither that spelling nor an earlier Projection authorizes a later operation. The required `AbortSignal` binds inspection work to the caller lifetime.

A successful result separates a browser-safe `ProjectSelectionProjection` from `TrustedProjectSelectionObservation`. The safe Projection contains a sanitized non-path display label, bounded Git facts, an optional existing DSH Workspace id, a revisioned fingerprint, and the complete-or-unavailable `InheritedChangeBaseline`; it contains no canonical Host path, Git administrative path, plaintext changed filename, file content, or credential-bearing remote URL. When sanitized HTTPS or SSH remotes name public `github.com/owner/repository` coordinates, the Projection also carries their lowercase, sorted, deduplicated candidate list. A candidate supports user confirmation but is not a Resource Binding or authorization result. The trusted observation retains canonical path identities, opaque same-Host identities for the per-worktree and common Git administrative directories, and the closed Git comparison settings from the same inspection. Its schemas admit only portable structural POSIX, Windows drive, or Windows UNC absolute-path forms; a fresh same-Host provider inspection owns canonical `realpath` and administrative-directory identity, and a retained durable path never authorizes an effect by itself. Strict schemas recompute baseline entry, aggregate, and complete-inspection digests from retained evidence, including an explicit present-or-absent Workspace observation. Inspection never creates a Workspace or Resource Binding.

The baseline schemas distinguish a complete capture, including a clean zero-entry result, from an unavailable capture that carries only a bounded reason and observed limits. Consumers must not treat unavailable evidence as a partial complete baseline.

## Bound project status

`inspectProject` accepts an `ActiveHostProjectBinding` containing its stable id and revision, literal active health, Host and Workspace identities, the accepted registration inspection, and the registration-time inherited-change baseline. Strict schemas require the Host and baseline identity to agree with that registration evidence. The registration inspection may predate Workspace creation, so a Service Provider revalidates the current repository and Workspace relation before it returns status; retained paths and fingerprints never authorize a read.

A successful `ProjectGitStatusObservation` contains branch, HEAD, upstream, canonical index and worktree digests, and a complete UTF-8-byte-ordered list of changed repository-relative paths. Each change has an opaque observation-scoped `ProjectGitChangeId` and distinguishes tracked, untracked, or conflicted state; staged and unstaged facts; and inherited, subsequent, mixed, or unknown registration provenance. Before full row parsing or fingerprint validation, the strict status schema rejects a raw changes array above the protocol row limit and rejects an aggregate UTF-8 path-byte overflow while scanning at most the admitted row count. Strict schemas then rebuild the id-free whole-status seed, every change id, and the final versioned fingerprint. They also reject traversal, NUL, invalid Unicode, duplicate or noncanonical path order, impossible untracked flags, inconsistent Git object widths, and mismatched fingerprints. Failure is one closed path-free reason: `binding-stale`, `missing`, `malformed`, `limit`, `invalid-path`, `ambiguous`, or `unavailable`; caller cancellation rejects through the required `AbortSignal` rather than returning partial status.

`inspectProjectCommit` revalidates an active Binding and accepts only an exact object id whose width matches the repository format. It confirms that the local object is a Commit and returns the same id, or distinguishes stale Binding, missing Commit, and unavailable Host evidence without accepting an arbitrary revision, ref, or path.

## Bound project Diff

`readDiff` accepts an active Binding, exact status fingerprint, opaque change id, staged, unstaged, or conflict layer, and optional continuation cursor. The Service Provider resolves the file internally and returns one bounded `ProjectGitDiffPage`; the patch fingerprint binds every page to the same complete patch, while line and byte ranges make truncation explicit. The request contains no caller-selected path or Git command. Stale observations or cursors, missing or ambiguous rows, unsupported untracked, conflict, or binary content, invalid UTF-8, and resource limits return closed path-free reasons instead of partial output.

## Durable structured mutations

`prepareOperation` durably binds one immutable Host request to its Control Intent source before any effect and returns provider-owned acceptance that cannot cross JSON. `startOperation` checks that acceptance and a current same-process Binding Write Admission before planning or publication. `inspectOperation` advances recovery from durable evidence without repeating an ambiguous effect, `cancelOperation` records only the closed durable cancellation reasons, and `onChanged` supplies post-commit wake-ups while snapshots remain authoritative. A caller `AbortSignal` limits one call; it is not durable cancellation.

StageFiles and UnstageFiles carry observation-scoped change ids and fingerprints, never paths. Commit carries the exact status, HEAD, index tree, worktree, inherited-change baseline, and message; the Host derives Git identity and publication target. Commit accepts attached and unborn HEAD states, while detached HEAD remains available for inspection, Diff, stage, and unstage but fails Commit before an effect. Successful results record the Host-resolved paths or the commit id, tree, parent, target, author, and committer; each Commit signature is the exact identity the Service Provider used to create the object after applying any execution-world canonicalization, not an unnormalized configuration input. The lifecycle distinguishes prepared, accepted, planning, publishing, succeeded, proven no-effect failure or cancellation, and `reconciliation-required` when publication evidence is unknown or contradictory.

PushBranch binds one exact local Commit and active Resource Binding to one canonical GitHub `nameWithOwner` and `refs/heads/*` target. The request carries no remote URL, credential-helper selection, or caller-supplied remote observation. The Provider observes and freezes the pre-publication remote state during planning, owns transport and credential-helper selection, and returns the exact repository, ref, Commit, previous remote state, and safe helper identity without credential bytes.

The Service Definition has no configuration. Each Service Provider owns its execution-world mechanism and required resource bounds.

## Durable Agent starts

`StartAgentRun` carries an `execution-dispatch` source, exact writable Git precondition, preallocated Agent Run, Work Session, DSH Session and input MessageId, frozen Agent Profile and Model Route, and one complete text-only `UserMessage`. Its payload digest covers that message and either its initial `saki-agent-run` source or attributed `saki-intervention-answer` source. Preparation is inert; start requires the accepted Dispatch mapping and current `agent-run` Binding Write Admission. The stable result repeats all four Run, Work Session, Session, and input identities.

Host success proves that the intended Session and dispatched input are durable, not that the model turn finished. Exact replay reuses one Host Operation. Providers inspect complete Session history before delivery: only absence permits the dispatched input, while canceled, replaced, unknown, or conflicting evidence must not be resent. See the [manual dispatch decision](../../../.agents/notes/implemented/feature/2026-08-18-saki-manual-give-to-agent-dispatch.md).

An Intervention answer uses a new Dispatch and stable MessageId but retains the owning Agent Run, Work Session, and Session. Its source records the Intervention Request, answer Control Intent, and immutable Actor attribution. Delivery uses the ordinary `StartAgentRun` operation and `user/message` event; there is no answer-specific Host effect or direct Session write. `inspectInterventionOpening` separately returns only `absent`, `pending`, exact `confirmed` turn/step evidence, or `conflict` after reading the durable `request_intervention` call, its exact successful model-facing result, and the completed final step and turn. It never exposes or mutates the Session.

`resumeAgentRun` is a startup-only recovery operation for a control-plane-validated running Run and its exact succeeded `StartAgentRun` operation and request. A Provider restores the live Agent handle only when the physical Session header and original input match that request. It adds no input, wake, or model request; missing, unavailable, or conflicting Host, Session, or Agent evidence rejects startup.

## Model Experience

### Host execution values and Agent Run input

#### What the model sees

Inspection, Diff, and structured Git operations add nothing. A started `StartAgentRun` delivers its exact text-only user message through the selected DSH Session; an initial source retains the Dispatch, Agent Run, and Work Session ids, while an answer source additionally retains its Intervention, answer Intent, and Actor attribution.

#### Token effect

Zero direct tokens for inspection, Diff, preparation, and structured Git operations. Starting an Agent may issue the selected model request after the original input becomes durable; its token use depends on the frozen message and assembled Agent context.

#### KV Cache effect

Each initial input or Intervention answer is a new user turn rather than part of the reusable prefix. Recovery-only wake messages are excluded before model assembly.

## Known Limitations and Deferred Work

- **Constrained Git operation set** — per-hunk staging, stash, conflict editing, general branch management, worktree management, repair, and retirement remain outside this service. Commit is hook-free and unsigned; repositories that require hooks, signing, or unsupported external filters need a different explicitly trusted provider.
