---
status: accepted
---

# 每个 Development Project 绑定一个 Git 工作树

[English](0003-development-project-worktree-ownership.md) | 中文

每个 Development Project 把一个 DSH Workspace 绑定到一个 Git 工作树。同一 Repository 的多个 worktree 可以登记为不同 Development Project，但一个工作树最多只有一个活动可写 Agent Run。

## 考虑过的方案

允许多个 Agent Run 写入同一工作树，会迫使 Saki 事后推断未暂存文件、index 修改、分支移动和冲突的归属。以整个 Repository 作为 Project 也会隐藏哪个 worktree 和 Session 拥有修改。一个 Project 对应一个 worktree 可以明确位置与写入所有权，同时通过 Git worktree 保留 Repository 级并行能力。

## 影响

并行可写 Work Item 必须使用不同 worktree，因此登记为不同 Development Project。只读 Session 可以并存，但第一个可写 Agent Run 结束或迁移到其他工作树前，Saki 必须拒绝第二个可写 Agent Run。
