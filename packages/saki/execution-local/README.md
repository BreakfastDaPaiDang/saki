# `@breakfastdapaidang/saki-execution-local`

English | [中文](README.zh.md)

The private Local Host Service Provider implements [`ctx.sakiHostExecution`](../execution/README.md) over `ctx.fs`, `ctx.subprocess`, `ctx.workspaceRegistry`, and same-host filesystem metadata. It inspects an untrusted local directory selection and returns detached evidence; it owns no Project policy, Resource Binding, Workspace creation, or durable product record.

## Inspection behavior

- **Filesystem identity** — filesystem-only discovery walks from the selected directory to an ordinary `.git` directory or gitfile, validates linked-worktree reciprocity or a local separate-Git-directory layout, and resolves the selected top level, per-worktree Git directory, and common Git directory through `realpath`. Ordinary, linked, detached, and local separate-Git-directory worktrees are supported. A selection below the Git top level is accepted only when its canonical target is contained by that top level; returned worktree, Workspace, and display evidence use the top level. The provider captures an opaque same-Host filesystem identity for each Git administrative directory in both observation rounds, compares paths without lowercasing them, and rejects missing, non-directory, bare, prunable, malformed, escaping, or ambiguous selections. A direct reparse locator, `.git` marker, resolved administrative directory, object directory, or configured worktree is rejected instead of canonicalized as an alias.
- **Private Git control** — each observation copies the admitted common config, an enabled `config.worktree`, HEAD, the current loose or packed ref, index, and repository-local exclude and attribute files into a private control directory. Explicit `git config --file ... --no-includes` queries audit the copied config before repository-aware commands run. Those commands use a fixed read-only argv set against the private config, HEAD, refs, and index, so they do not reopen the source copies during that observation. A pre-existing source object alternate or HTTP alternate rejects inspection; the private control directory instead contains one generated alternate to the admitted live source object database.
- **Bounded Git execution** — the provider requires Git 2.45 or newer. One raw-byte runner invokes it with structured argv, an explicit working directory, required cancellation, process-tree settlement, a controlled locale, non-interactive credential settings, `--no-lazy-fetch`, `--no-replace-objects`, and fixed pager, fsmonitor, hook, diff, attribute, and configuration settings. Before inventory commands can consult the worktree, the provider rejects every repository- or worktree-scoped `include.path` and `includeIf.*.path` directive without following it, then reads `core.fsmonitor` from those scopes. An absent or explicit `false` fsmonitor value is accepted, while a program, `true`, malformed value, or unreadable scope rejects inspection without launching the configured monitor. Per-command and observation-round stdout, stderr, and time bounds reject the complete operation instead of exposing truncated data or child diagnostics.
- **Exact observation** — closed NUL-framed `ls-tree`, tagged staged `ls-files`, untracked `ls-files`, and `check-attr --all` inventories retain exact path bytes in memory. The provider compares raw regular-file, symlink, and gitlink evidence without invoking check-in filters; it does not claim equivalence to filter-normalized porcelain status. An initialized gitlink exposes its nested HEAD but not staged, unstaged, or untracked membership inside the nested repository, so every initialized gitlink is conversion-ambiguous and blocks automatic mutation. Unknown well-formed attributes are excluded from durable evidence, while malformed records reject. On Windows, an alternate-data-stream component is not an ordinary path identity and cannot produce an automatic-mutation-eligible baseline.
- **Safe evidence** — remote observations remove userinfo, query, and fragment material. Sanitized HTTPS and SSH remotes that name public GitHub repositories produce a lowercase, sorted, deduplicated candidate list without turning the candidate into a binding or authority result. Fingerprints retain only allowlisted Git facts and versioned digests. A lookup may report an already registered DSH Workspace id, but inspection does not create or mutate that Workspace.
- **Inherited-change baseline** — changed paths are ordered and represented by exact NUL-framed path digests plus allowlisted index, conflict, submodule, symlink, absence, and bounded raw-content evidence. A clean worktree returns a complete zero-entry baseline. An incomplete repository inventory rejects the inspection. After changed membership is exact, a path-local capture or retention failure and any independent baseline bound return the unavailable baseline arm without partial entries or a fabricated complete digest.

The application bootstrap environment is the authority for the Git executable and ordinary inherited process variables. The provider removes repository- and browser-controllable Git execution variables; it is not a child-process sandbox for a compromised parent environment. Filesystem metadata cancellation follows the FileSystem provider's cooperative pre/post-probe contract, while regular-file content streams are destroyed by cancellation and provider disposal waits for every call to settle.

## Configuration

Every field resolves to a positive integer. These limits govern observation only; product policy remains in the control plane.

| Field | Default | Purpose |
| --- | --- | --- |
| `gitCommandTimeoutMs` | `10000` | Wall-clock limit for each Git process |
| `gitTerminationGraceMs` | `250` | Grace between process-tree termination and forced kill |
| `maxGitStdoutBytes` | `4194304` | Complete stdout byte limit for each Git process |
| `maxGitStderrBytes` | `65536` | Complete stderr byte limit for each Git process |
| `inventoryMaxEntries` | `100000` | Path-membership limit for one complete repository observation |
| `inventoryMaxPathBytes` | `16777216` | Exact path-byte limit for one complete repository observation |
| `inventoryMaxGitOutputBytes` | `16777216` | Shared raw stdout-plus-stderr limit across one observation round |
| `inventoryMaxFileBytes` | `67108864` | Retained raw evidence limit for one inventory path |
| `inventoryMaxTotalFileBytes` | `536870912` | Raw content and stability-read limit across one inventory |
| `inventoryMaxCaptureMs` | `30000` | Wall-clock limit for one Git, filesystem, and Workspace observation round |
| `baselineMaxEntries` | `10000` | Inherited-change entry limit for a complete baseline |
| `baselineMaxPathBytes` | `4194304` | Sum of exact Git path bytes allowed in a complete baseline |
| `baselineMaxGitOutputBytes` | `16777216` | Allowlisted Git evidence limit for a complete baseline |
| `baselineMaxFileBytes` | `16777216` | Retained raw evidence limit for one changed path |
| `baselineMaxTotalFileBytes` | `67108864` | Retained raw evidence limit across one complete baseline |
| `baselineMaxCaptureMs` | `30000` | Wall-clock limit covering inventory capture and baseline construction |

## Model Experience

### Local Host inspection

#### What the model sees

Nothing. `ctx.sakiHostExecution` supplies Host-side Saki projections and trusted observations but registers no model-facing input.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of model requests: inspection neither assembles nor changes a request prefix.

## Known Limitations and Deferred Work

- **Local execution world only** — this provider requires the selected directory, filesystem metadata, system Git executable, Workspace registry, and subprocess runtime to describe the same Host. Remote Hosts require another Service Provider.
- **No mutation fallback** — an unavailable inherited-change baseline remains valid read-only evidence, but this provider does not infer missing entries or weaken bounds to make automatic mutation eligible.
- **Live data plane** — the admitted worktree and source object database remain live while Git reads them. Independent observation rounds and source-control manifests reject changes they observe, but they do not prevent every transient same-user race or make the provider an operating-system sandbox.
- **Reparse scope** — the provider rejects direct locator aliases and final Git marker, administrative, control-file, object-directory, and configured-worktree reparse entries. The current FileSystem capability does not prove that every ancestor component was opened without following a reparse point.
- **Unsupported control layouts** — non-files ref storage such as reftable and an ordinary `.git` directory that redirects through `commondir` are unavailable. A split index whose `sharedindex.*` file is absent from the private control directory also becomes unavailable. A source repository that already uses object alternates is rejected rather than reproduced inside the snapshot.
