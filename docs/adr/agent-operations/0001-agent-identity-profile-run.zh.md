---
status: accepted
---

# 分离 Agent Identity、Agent Profile 和 Agent Run

[English](0001-agent-identity-profile-run.md) | 中文

Saki 把持久 Agent 主体、可复用执行配置和单次尝试分别建模为 Agent Identity、Agent Profile 和 Agent Run。合并三者会使配置变更改写身份、重试覆盖历史，或让持续责任依赖某一 Session。

## 影响

一个 Agent Identity 可以随时间使用不同 Agent Profile，一个可版本化 Agent Profile 也可以被多次 Agent Run 复用。每次 Agent Run 都记录实际 Profile 版本；一次性工作没有持久主体承担时，Agent Run 可以不引用 Agent Identity。长期责任与记忆属于 Agent Identity，执行指令属于 Agent Profile，尝试状态、输入、授权、成本与证据属于 Agent Run。
