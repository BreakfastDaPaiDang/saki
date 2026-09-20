---
description: "Import a configured API connection into an independently protected Saki account route."
kind: "package-reference"
---

# `@breakfastdapaidang/saki-model-account-api`

English | [中文](README.zh.md)

## Summary

Import a configured API connection into an independently protected Saki account route.

## Table of Contents

- [Use this package](#use-this-package)
- [Implementation](#implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

The Windows [Saki bundle](../bundle/README.md) mounts this Provider with protected credentials, DSH Models settings, and the [account registry](../model-account/README.md). This plugin has no separate Cordis configuration.

In Settings → Models, configure a connection with an explicit protocol, endpoint, credential reference, and model list. Model Accounts offers that connection for explicit import. Import captures its configuration and copies its key into a separate protected record. Later source edits require another explicit import; they do not change a retained account revision.

DSH model discovery supplies candidates for the editable model list. An unsuccessful discovery does not replace confirmed configuration. Discovery does not establish entitlement, capacity, or available credit.

<a id="implementation"></a>
## Implementation

<details>
<summary>Implementation internals</summary>

The Provider composes the public DSH PiAiAdapter and pins pi-ai 0.85.1. Each adapter owns an immutable configuration collection and reads only its protected credential record. The source connection name preserves installed catalog defaults; the public route remains account-specific.

The API identity identifies a local Profile, not a verified remote account. Authentication means a protected key is configured; endpoint health and entitlement remain unknown until separately observed. Provider registration changes reconcile retained activation choices without repeating login.

</details>

<a id="model-experience"></a>
## Model Experience

### API routing

#### What the model sees

The existing `GenerateOptions.messages` and tool declarations reach the selected protocol. Account management adds no instructions.

#### Token effect

Usage comes from the transport response. Import and model discovery consume no model tokens.

#### KV Cache effect

The adapter preserves the conversation prefix. Provider cache behavior follows the captured connection configuration.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Text input** — imports reject image declarations; the adapter advertises text input only.
- **Protected Host** — the shipped Provider requires Windows local-user-trust credentials.
- **Headers and URLs** — imports reject custom headers and endpoint user information, query strings, or fragments; credentials belong in the credential service.
- **Quota** — usage inspection reports unsupported. TeamoRouter documents a billing endpoint, but this Provider has no verified quota adapter for it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

No invariant companion is published because adapters are registered through the account registry's owned effects and this Provider maintains no independent persistent registry.

</details>
