---
status: accepted
---

# 使用 GitHub Projects v2 作为共享 Work Item 权威来源

[English](0001-github-projects-v2-work-authority.md) | 中文

GitHub Projects v2 拥有共享 Work Item Status 和手动排序。Saki 把固定状态映射到所选 Project 的 Status 选项，通过 Board 投影结果，并只在本地保存恢复元数据和缓存。未加入 Project 的开放 Repository Issue 显示在 Inbox，移出时加入 Project；Done 和 Canceled 关闭 Issue，重新打开则恢复最近的非终态。

## 考虑过的方案

Issue label 无法可靠表达有序 Board 状态，Saki 独占数据库会让 GitHub 协作者看不到当前工作。Projects v2 保留 GitHub 协作并支持状态与 item position 修改，代价是字段映射、组织权限、轮询和冲突恢复。

## 影响

GitHub 不可用或字段不再匹配映射时，Board 写入必须明确失败。GitHub 确认前，Saki 不得声称一次乐观本地移动已经成功。
