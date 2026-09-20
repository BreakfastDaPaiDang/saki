# Agent Note: GitHub Repository 数据库身份

Status: implemented

[English](2026-09-21-github-repository-database-id.md) | 中文

## 问题

使用 `fullDatabaseId` 的 GitHub Repository GraphQL 查询会在返回任何数据之前失败。如果模拟响应不检查所选字段便返回字符串 id，就可能掩盖这一错误。

## 决策

Product App 读取和变更检查选择文档规定的 Repository `databaseId` 字段，并验证正安全整数。供应商将通过验证的值转换为十进制字符串，用于供应商无关的身份匹配和事实。Issue 与 PullRequest 的字段可用性不决定 Repository 的字段；参见 [GitHub Repository 参考](https://docs.github.com/en/graphql/reference/repos#repository)。

## 考虑过的替代方案

**将 `fullDatabaseId` 别名设为 `databaseId`。** 别名只改变结果键名，无法使 Repository 上不存在的字段有效。

**同时接受数字字符串和整数。** 这会掩盖测试夹具中的线上模式错误。持久化 id 仍为字符串，GraphQL 响应则保留文档规定的数值类型。

## 影响

定向 Issue 读取和依赖 Repository 的交付操作能够使用与完整扫描相同的身份检查。现有持久化身份保持不变。读取测试检查查询字段，并拒绝空值、字符串、小数、非正数及不安全的数值 id。真实 Product App 读取验证 GitHub 上的完整 Issue 详情。
