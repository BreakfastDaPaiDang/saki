---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-19-saki-message-sources

English | [中文](2026-09-19-saki-message-sources.zh.md)

## Summary

Imports the three pre-existing Saki message-source variants into the persistence-type history.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-19-saki-message-sources
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-14-image-offload"
    after: "3bf1f018545e4a456dc441c96fbe30cd396d1068dd3c9aed12f60ef7fa92f66f"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-14-image-offload"
    after: "b7db8b7a915c06cec46b3cbdb97c048a65bdd9aa8e88648d6d9d8ec8ce8710fa"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-14-image-offload"
    after: "78da26327c11f64e2c6689e3eb3004e87e7af0524c486429ef173ba67549b2df"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Saki already writes saki-agent-run, saki-intervention-answer, and saki-agent-run-wake through the merge-extensible MessageSourceMap. This integration preserves their fields and Session format 3. The upstream history did not include the private Saki composition; three exact before/after schema digest pairs acknowledge that existing fork vocabulary without changing released data or rewriting the upstream records. Any other transition remains subject to the ordinary version rules.

<a id="verification"></a>
## Verification

The built Saki Agent Run and Delivery expected-output tests passed. Both saki-skill-pack SDK replays passed; their retained Session JSONL files are unchanged. All 38 persistence-history tests passed, including rejection of changed predecessors, changed payloads, and reverse transitions for each sealed root.

<a id="dev-note"></a>
## Dev Note

None.
