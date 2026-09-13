# Agent Note: 带保留请求的显式浏览器交付

Status: implemented

[English](2026-09-14-saki-explicit-browser-delivery.md) | 中文

## 问题

浏览器需要在第一个 Branch Delivery 存在之前取得当前选择前提。它也需要区分创建 PR 与关联已有 PR，以及当前 CI 健康状态与保留的成功证据。Push 或 PR 响应丢失后，浏览器无法推断副作用是否发生；替换该请求可能重复工作，或使操作者的确认与副作用脱离。

## 决策

交付页面通过一个安全的 Host 查询取得当前选择修订、已配置的凭据管理器身份、完整 PR 查询结果、保留的交付来源与建议操作可用性。提交仍由 [Branch Delivery 机制](2026-08-18-saki-branch-delivery-and-milestone-release-evidence.zh.md)负责，重新检查当前权限、上下文、准确 Commit、远端分支、PR 和 CI。Changes 提供用于选择 Commit 的本地 Git 观察。

Host 为相同目标和交付修订保留 PR 查询结果，使缓存失效读取可以保留该结果，同时不让浏览器自行推断创建资格。每次交互读取先丢弃此前查询结果再发起查询；失败不会恢复旧结果。Provider 卸载会清空缓存。较旧交付修订的迟到结果不能替换较新的缓存结果。

每次选择、Push、创建或关联 PR、进入评审及人工验收均有显式确认。浏览器将显示的目标和原请求固定在按 Principal 隔离的 Project 持久状态中。一个未完成的交付请求会跨该 Project 内的 Work Item 阻止替换操作；Changes 的待定请求也会阻止新的交付操作。Pending、reconciliation 与无回执响应会保留请求用于准确恢复。只有持久终态回执允许确认并清除。因此，非终态 Branch Delivery Intent 的临时不可用返回 pending 回执。

页面显示 Git 凭据管理器 id，但不解析账户；PR 操作显示 GitHub App Installation，验收显示 Saki 操作者。保留的 CI 事实与当前来源健康状态相互独立。验收记录与当前工作项状态分别显示，因为可恢复的 Done 与关闭 Issue 子操作可能在验收记录后仍未解决。

## 考虑过的替代方案

**从已有交付推断首次选择。** 流程开始时没有交付。Host 查询提供当前安全前提，不分配占位记录，也不暴露私有 Installation 配置。

**在任何错误响应后清除操作。** 传输失败或非终态回执无法证明副作用未发生。保留并重放原请求能够保持操作者确认与已有恢复所有权。

**从浏览器 CI 行计算转换可用性。** 原始行不包含当前 Host 权限与修订检查。Host 拥有建议可用性，并独立重新检查每次提交的转换。

## 结果

操作者能够完成从 Commit 到验收的手动流程，同时保持每个远端副作用可归因、可恢复。不确定的请求会阻止替换工作，直到恢复建立终态结果。自动领取、合并与完成不属于此 UI。已有交付和[结构化 Git](../architecture/2026-08-28-saki-recoverable-structured-git-operations.zh.md)决策保留独立的持久性与安全理由；本记录负责浏览器确认和请求保留。
