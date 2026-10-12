# 领域词汇

只收录 Saki 自己拥有的概念。DSH 已有的概念直接用 DSH 的词，不另起同义词。

## Saki 概念

**Project**：围绕一个持续目标组织工作、资源和结果的持久范围。它不是文件夹、仓库或看板的别名。按能力组合分为 Development Project（软件开发）和后续的 Managed System（运行中的业务系统）。

**Resource Binding**：Project 与一项资源之间稳定的关联，资源可以是 Git worktree、GitHub 仓库、部署环境、服务或专用工具。绑定有自己的稳定 id；路径、分支等是可变的观察结果，不是身份。Saki 只保存关联和观察，不复制资源自身的数据。

**Work Item**：具有明确结果和验收条件的一项预期工作。

**Work Item Status**：Work Item 所处的交付阶段：Inbox、Backlog、Ready、In progress、In review、Done、Canceled。独立于任何 Execution 的状态。

**Blockage**：阻止进展但不替代 Status 的条件。不要把 Blocked 当作一种 Status。

**Execution**：Agent、脚本或定时任务的一次可追踪尝试。由 Agent 完成的 Execution 对应一个 DSH Session。Execution 成功退出不等于工作已经验收。

**Outcome Evidence**：证明验收条件或业务结果是否满足的可定位事实，例如 diff、测试结果、commit、PR、CI、部署状态、日志或业务指标。Agent 的成功自报不是 Outcome Evidence。

核心关系：`Project -> Resource Binding`，`Project -> Work Item -> Execution -> Outcome Evidence`。

## 沿用 DSH 的概念

| 需要表达的意思 | 用 DSH 的词 |
| --- | --- |
| Agent 的角色指令、工具、模型配置 | Agent Preset |
| 一次 Agent 工作的会话记录 | Session |
| Agent 工作的目录 | Workspace |
| 仓库内的 Agent 指令 | skill（`.dsh/skills`） |
