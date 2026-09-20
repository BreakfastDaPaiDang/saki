---
description: "Keep subscription accounts separately addressable and activate only the selected account route."
kind: "package-reference"
---

# `@breakfastdapaidang/saki-model-account`

English | [中文](README.zh.md)

## Summary

Keep subscription accounts separately addressable and activate only the selected account route.

## Table of Contents

- [Use this package](#use-this-package)
- [Implementation](#implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

The [Saki bundle](../bundle/README.md) mounts this service beside an account Provider. The [control plane](../control-plane/README.md) owns durable Profiles, authorization Intents, and operator choices.

This plugin has no configuration fields. Activation requires matching protected credentials and account identity; a known exhausted request allowance prevents activation.


<a id="implementation"></a>
## Implementation

<details>
<summary>Implementation internals</summary>

`ModelAccountProvider` supplies authorization, inspection, configuration resolution, and an account-specific LLM adapter. The registry owns adapter registration and disposal; it never selects another account.

A route identifies one Profile configuration revision. Removing a Provider withdraws its routes. Reauthorization retains the Profile identity while allocating a fresh credential address and route revision.

</details>

<a id="model-experience"></a>
## Model Experience

### Account routing

#### What the model sees

Nothing directly. `ctx.sakiModelAccounts` adds no prompt, tool, or message content.

#### Token effect

Zero direct tokens.

#### KV Cache effect

Account routing does not rewrite the conversation prefix. Provider cache behavior remains provider-owned.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Explicit selection** — no account pooling, failover, or automatic model substitution.
- **Observed eligibility** — unavailable usage is not a zero allowance or a confirmed entitlement.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

No invariant companion is published because runtime registration and withdrawal share the same effects and this package maintains no independent persistent registry.

</details>
