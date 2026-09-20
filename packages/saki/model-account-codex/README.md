---
description: "Authorize a Codex subscription account, inspect its allowance, and send text requests through its protected credential."
kind: "package-reference"
---

# `@breakfastdapaidang/saki-model-account-codex`

English | [中文](README.zh.md)

## Summary

Authorize a Codex subscription account, inspect its allowance, and send text requests through its protected credential.

## Table of Contents

- [Use this package](#use-this-package)
- [Implementation](#implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

The Windows [Saki bundle](../bundle/README.md) mounts this Provider with DPAPI credentials, DSH authorization, Sessions, and the [account registry](../model-account/README.md). Account configuration is resolved per Profile; this plugin has no separate Cordis configuration.

Device-code and browser authorization use pi-ai. The protected record stores the refreshable grant; ambient environment keys and external credential files are not imported.

`baseURL` defaults to `https://chatgpt.com/backend-api`; optional `models` restricts the maintained catalog. `timeoutMs`, `streamIdleTimeoutMs`, and `usageTimeoutMs` default to 120000, 300000, and 15000 milliseconds.


<a id="implementation"></a>
## Implementation

<details>
<summary>Implementation internals</summary>

The integration pins pi-ai 0.85.1 for OAuth and Codex SSE and the public usage helper from dsh-codex-subscription 2.1.2. It composes the DSH PiAiAdapter without loading the subscription bundle or copying its transport.

Protected record transactions serialize refresh. The request captures its account, Session, and durable turn before asynchronous preparation; response turn state is retained only for that active turn. Final HTTP headers preserve Harness attribution and the selected account.

Allowance observations retain units, source, time, and reset facts. Failed or empty reads remain unavailable. The catalog describes model capabilities and does not establish subscription entitlement.

</details>

<a id="model-experience"></a>
## Model Experience

### Account routing

#### What the model sees

The adapter sends the existing `GenerateOptions.messages` and tool declarations; it adds no account-management instructions.

#### Token effect

Input and output usage comes from the maintained transport. Authorization and allowance reads add no model tokens.

#### KV Cache effect

Same-turn HTTP state is account-local. Ending a turn or disposing its Session prevents state reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Text-only SSE** — image attachments and WebSocket transport are not advertised.
- **Protected Host required** — the shipped Provider is enabled only on Windows with local-user-trust credentials.
- **Live subscription acceptance** — keyless tests execute maintained authorization and transport with controlled responses; real entitlement and endpoint access require an operator-authorized account.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

No invariant companion is published: request state is private to each adapter and credential ownership is checked on every protected record access.

</details>
