---
status: accepted
---

# 每个 Development Project 绑定一个 Git 工作树

[English](0003-development-project-worktree-ownership.md) | 中文

每个 Development Project 把一个 DSH Workspace 绑定到一个 Git 工作树。同一仓库的多个工作树可以登记为不同 Development Project。独立的 Agent Run 与 Session 可以共用同一 Project 和工作树。

## 考虑过的方案

每个工作树对应一个 Project，使命令拥有稳定的位置和仓库身份。Agent 归因属于各自的 Run 与 Session，并不证明文件由其独占创作。贯穿运行期的工作树预留会阻止普通并行对话和手动 Git 操作，却无法阻止编辑器及外部进程写入该目录。Dispatch 幂等性与 Git 操作校验保护各自的副作用，无需施加这种预留。

## 影响

并行 Run 可能编辑同一文件并遇到改动冲突。用户需要隔离时自行选择不同工作树。直接 Git 操作保留预期观察校验、Git 原子发布和操作范围内的恢复。参见[手动分派决策](../../.agents/notes/implemented/feature/2026-08-18-saki-manual-give-to-agent-dispatch.zh.md)。
