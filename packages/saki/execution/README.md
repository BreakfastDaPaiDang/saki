# `@breakfastdapaidang/saki-execution`

English | [中文](README.zh.md)

The private Saki Host Execution Service Definition registers `ctx.sakiHostExecution`. It defines Host-neutral inspection values and one read-only operation, `inspectProjectSelection(request, signal)`, while the [Saki control plane](../control-plane/README.md) owns authorization, Project policy, and durable product records. The wider control-plane and execution-plane split is defined by the [Saki backend architecture](../../../docs/saki/architecture/0.1.0-backend.md).

## Project-selection inspection

The request contains a selected Saki Host id and a caller-supplied directory locator. The locator is untrusted input: a provider resolves and inspects it independently on every call, and neither that spelling nor an earlier Projection authorizes a later operation. The required `AbortSignal` binds inspection work to the caller lifetime.

A successful result separates a browser-safe `ProjectSelectionProjection` from `TrustedProjectSelectionObservation`. The safe Projection contains a sanitized non-path display label, bounded Git facts, an optional existing DSH Workspace id, a revisioned fingerprint, and the complete-or-unavailable `InheritedChangeBaseline`; it contains no canonical Host path, Git administrative path, plaintext changed filename, file content, or credential-bearing remote URL. When sanitized HTTPS or SSH remotes name public `github.com/owner/repository` coordinates, the Projection also carries their lowercase, sorted, deduplicated candidate list. A candidate supports user confirmation but is not a Resource Binding or authorization result. The trusted observation retains canonical path identities, opaque same-Host identities for the per-worktree and common Git administrative directories, and the closed Git comparison settings from the same inspection. Its schemas admit only portable structural POSIX, Windows drive, or Windows UNC absolute-path forms; a fresh same-Host provider inspection owns canonical `realpath` and administrative-directory identity, and a retained durable path never authorizes an effect by itself. Strict schemas recompute baseline entry, aggregate, and complete-inspection digests from retained evidence, including an explicit present-or-absent Workspace observation. Inspection never creates a Workspace or Resource Binding.

The baseline schemas distinguish a complete capture, including a clean zero-entry result, from an unavailable capture that carries only a bounded reason and observed limits. Consumers must not treat unavailable evidence as a partial complete baseline. The merge-extensible `SakiHostExecutionOperationMap` does not declare mutation placeholders.

The Service Definition has no configuration. Each Service Provider owns its execution-world mechanism and required resource bounds.

## Model Experience

### Host inspection values

#### What the model sees

Nothing. `ctx.sakiHostExecution` provides detached values to Host-side Saki Consumers and registers no tool, prompt section, or session event.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of model requests: the service does not assemble or change a request prefix.

## Known Limitations and Deferred Work

- **Read-only operation set** — the service defines only project-selection inspection. Binding-scoped mutation, worktree management, repair, and retirement are outside this operation set and require their own Consumer operations rather than passing authority through this request.
