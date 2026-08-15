# 分诊标签

[English](triage-labels.md) | 中文

工程 skill 使用五种规范分诊角色。每种角色映射到一个 GitHub 标签，并在适用时映射到一个 Work Item Status。

| 规范角色 | GitHub 标签 | Work Item Status | 含义 |
| --- | --- | --- | --- |
| `needs-triage` | `needs-triage` | `Inbox` | 维护者必须评估该 Work Item |
| `needs-info` | `needs-info` | `Inbox` | 报告者必须补充信息 |
| `ready-for-agent` | `ready-for-agent` | `Ready` | agent 可以认领规范完整的 Work Item |
| `ready-for-human` | `ready-for-human` | `Ready` | Work Item 需要人工实现或判断 |
| `wontfix` | `wontfix` | `Canceled` | Work Item 不交付并关闭 |

一个 Work Item 最多应用一个分诊标签。应用新分诊标签时移除原有分诊标签。

认领 Ready Work Item 时移除其 Ready 标签，并将状态改为 `In progress`。Pull Request 评审把状态改为 `In review`。验收把状态改为 `Done`。

阻塞不取代 Work Item Status。单独记录阻塞，让 Work Item 保留其交付阶段。
