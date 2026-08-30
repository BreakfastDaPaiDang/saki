# `@breakfastdapaidang/saki-execution`

English | [中文](README.zh.md)

The private Saki Host Execution Service Definition registers `ctx.sakiHostExecution`. It defines provider-neutral project inspection and Diff values plus the durable Host Operation lifecycle used for structured StageFiles, UnstageFiles, and Commit effects. The [Saki control plane](../control-plane/README.md) owns authorization, Project policy, write admission, and durable Control Intents. The wider control-plane and execution-plane split is defined by the [Saki backend architecture](../../../docs/saki/architecture/0.1.0-backend.md).

## Project-selection inspection

The request contains a selected Saki Host id and a caller-supplied directory locator. The locator is untrusted input: a provider resolves and inspects it independently on every call, and neither that spelling nor an earlier Projection authorizes a later operation. The required `AbortSignal` binds inspection work to the caller lifetime.

A successful result separates a browser-safe `ProjectSelectionProjection` from `TrustedProjectSelectionObservation`. The safe Projection contains a sanitized non-path display label, bounded Git facts, an optional existing DSH Workspace id, a revisioned fingerprint, and the complete-or-unavailable `InheritedChangeBaseline`; it contains no canonical Host path, Git administrative path, plaintext changed filename, file content, or credential-bearing remote URL. When sanitized HTTPS or SSH remotes name public `github.com/owner/repository` coordinates, the Projection also carries their lowercase, sorted, deduplicated candidate list. A candidate supports user confirmation but is not a Resource Binding or authorization result. The trusted observation retains canonical path identities, opaque same-Host identities for the per-worktree and common Git administrative directories, and the closed Git comparison settings from the same inspection. Its schemas admit only portable structural POSIX, Windows drive, or Windows UNC absolute-path forms; a fresh same-Host provider inspection owns canonical `realpath` and administrative-directory identity, and a retained durable path never authorizes an effect by itself. Strict schemas recompute baseline entry, aggregate, and complete-inspection digests from retained evidence, including an explicit present-or-absent Workspace observation. Inspection never creates a Workspace or Resource Binding.

The baseline schemas distinguish a complete capture, including a clean zero-entry result, from an unavailable capture that carries only a bounded reason and observed limits. Consumers must not treat unavailable evidence as a partial complete baseline.

## Bound project status

`inspectProject` accepts an `ActiveHostProjectBinding` containing its stable id and revision, literal active health, Host and Workspace identities, the accepted registration inspection, and the registration-time inherited-change baseline. Strict schemas require the Host and baseline identity to agree with that registration evidence. The registration inspection may predate Workspace creation, so a Service Provider revalidates the current repository and Workspace relation before it returns status; retained paths and fingerprints never authorize a read.

A successful `ProjectGitStatusObservation` contains branch, HEAD, upstream, canonical index and worktree digests, and a complete UTF-8-byte-ordered list of changed repository-relative paths. Each change has an opaque observation-scoped `ProjectGitChangeId` and distinguishes tracked, untracked, or conflicted state; staged and unstaged facts; and inherited, subsequent, mixed, or unknown registration provenance. Before full row parsing or fingerprint validation, the strict status schema rejects a raw changes array above the protocol row limit and rejects an aggregate UTF-8 path-byte overflow while scanning at most the admitted row count. Strict schemas then rebuild the id-free whole-status seed, every change id, and the final versioned fingerprint. They also reject traversal, NUL, invalid Unicode, duplicate or noncanonical path order, impossible untracked flags, inconsistent Git object widths, and mismatched fingerprints. Failure is one closed path-free reason: `binding-stale`, `missing`, `malformed`, `limit`, `invalid-path`, `ambiguous`, or `unavailable`; caller cancellation rejects through the required `AbortSignal` rather than returning partial status.

## Bound project Diff

`readDiff` accepts an active Binding, exact status fingerprint, opaque change id, staged, unstaged, or conflict layer, and optional continuation cursor. The Service Provider resolves the file internally and returns one bounded `ProjectGitDiffPage`; the patch fingerprint binds every page to the same complete patch, while line and byte ranges make truncation explicit. The request contains no caller-selected path or Git command. Stale observations or cursors, missing or ambiguous rows, unsupported untracked, conflict, or binary content, invalid UTF-8, and resource limits return closed path-free reasons instead of partial output.

## Durable structured mutations

`prepareOperation` durably binds one immutable Host request to its Control Intent source before any effect and returns provider-owned acceptance that cannot cross JSON. `startOperation` checks that acceptance and a current same-process Binding Write Admission before planning or publication. `inspectOperation` advances recovery from durable evidence without repeating an ambiguous effect, `cancelOperation` records only the closed durable cancellation reasons, and `onChanged` supplies post-commit wake-ups while snapshots remain authoritative. A caller `AbortSignal` limits one call; it is not durable cancellation.

StageFiles and UnstageFiles carry observation-scoped change ids and fingerprints, never paths. Commit carries the exact status, HEAD, index tree, worktree, inherited-change baseline, and message; the Host derives Git identity and publication target. Commit accepts attached and unborn HEAD states, while detached HEAD remains available for inspection, Diff, stage, and unstage but fails Commit before an effect. Successful results record the Host-resolved paths or the commit id, tree, parent, target, author, and committer; each Commit signature is the exact identity the Service Provider used to create the object after applying any execution-world canonicalization, not an unnormalized configuration input. The lifecycle distinguishes prepared, accepted, planning, publishing, succeeded, proven no-effect failure or cancellation, and `reconciliation-required` when publication evidence is unknown or contradictory.

The Service Definition has no configuration. Each Service Provider owns its execution-world mechanism and required resource bounds.

## Model Experience

### Host execution values

#### What the model sees

Nothing. `ctx.sakiHostExecution` provides detached inspection, Diff, and operation values to Host-side Saki Consumers and registers no tool, prompt section, or session event.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of model requests: the service does not assemble or change a request prefix.

## Known Limitations and Deferred Work

- **Constrained Git operation set** — per-hunk staging, stash, conflict editing, branch management, push, worktree management, repair, and retirement remain outside this service. Commit is hook-free and unsigned; repositories that require hooks, signing, or unsupported external filters need a different explicitly trusted provider.
