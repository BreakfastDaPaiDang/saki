---
status: accepted
---

# 分离 Work Session 与 subagent 谱系

[English](0002-work-sessions-and-subagent-lineage.md) | 中文

Saki 把 Work Session 建模为与 Work Item 关联的持久、用户可见会话，不受 DSH 将其作为顶层 Session 还是可继续 subagent 运行的方式限制。Project Coordinator 是责任跨越可替换 Coordination Session 持续存在的 Agent Identity；DSH `parentSession` 谱系记录执行来源和运行时权限，而非永久产品归属。

## 考虑过的方案

把一个 Work Item 等同于确切一个 Session，会让重试、专项审阅和重新指派覆盖或挤入同一段对话。把 Project Coordinator 等同于一个永久父 Session，会使委派工作在该 Session 重启或被替换后失去归属，并使不断增长的聊天上下文成为 Project 的事实来源。把每个 Work Session 固定为 subagent，也会阻止用户创建或外部执行的工作复用同一产品模型。

## 影响

一个 Work Item 可以拥有多个 Work Session，但最多把其中一个指定为主要会话；Automation Policy 决定非主要专项 Session 是否可以并发运行。Work Session 可以跨 Agent Run 和协调者替换保持可寻址；人类直接输入和协调者消息保留不同的来源标记。需要父子协调时，DSH 可继续 subagent 是首选初始适配器，一次性或嵌套 subagent 则仍是 Work Session 内部的执行细节。Saki 保存 Work Item、指派、主要会话和协调关系；DSH session id 与 `parentSession` 保持为运行时引用和来源证据。
