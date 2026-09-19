---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-19-saki-message-sources

[English](2026-09-19-saki-message-sources.md) | 中文

## 概述

将 Saki 已有的三种消息来源变体纳入持久化类型历史。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

Saki 已通过可合并扩展的 MessageSourceMap 写入 saki-agent-run、saki-intervention-answer 和 saki-agent-run-wake。本次集成保留它们的字段与 Session 格式 3。上游历史未包含私有的 Saki 组合；三个精确的前后 schema 摘要对确认这一既有分支词汇，不改变已发行数据，也不重写上游记录。其他转换仍受通常的版本规则约束。

<a id="verification"></a>
## 验证

基于构建产物的 Saki Agent Run 和 Delivery 预期输出测试通过。两个 saki-skill-pack SDK 回放通过；保留的 Session JSONL 文件未改变。 全部 38 项持久化历史测试通过，其中逐一验证每个封存根的改变后前驱、改变后载荷及反向转换仍要求版本升级。

<a id="dev-note"></a>
## 开发备注

无。
