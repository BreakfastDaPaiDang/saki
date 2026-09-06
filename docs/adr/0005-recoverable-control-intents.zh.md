---
status: accepted
---

# 使用可恢复的 Control Intent 协调外部副作用

[English](0005-recoverable-control-intents.md) | 中文

除 bootstrap exchange 与 logout 外，Saki 把每个产品 mutation 持久化为幂等 Control Intent，并通过可恢复的生命周期推进它。两个 access 操作只通过专属认证协议修改单一 Installation Access aggregate。带版本的领域记录拥有当前事实，每条 Execution Dispatch 拥有自身准入，产品 View 读取显式投影。0.1.0 使用 DSH `storageDomain` 保存这些记录，不引入完整事件溯源或独立事务数据库。

## 为什么这样决定

开始工作不是一次数据库写入。它可能需要创建 Agent Run 和 Work Session 关联、启动 DSH Session、修改 GitHub Work Item，并在之后接收模型提供方或 GitHub 的结果。DSH `storageDomain` 会串行执行写入，并在发布变更通知前持久化一条记录，但它明确不提供跨记录事务。部分写入可能留下虚假的 In progress Work Item、缺少归因的 Run，或同一输入的重复交付。

关系型事务可以让多个本地数据行原子提交，却无法把 Git、DSH 运行时、GitHub 或模型提供方纳入同一原子操作。Saki 仍然必须为外部副作用实现幂等、持久进度、补偿和对账。0.1.0 增加第二套持久化抽象会重复 DSH 存储，却没有解决决定性的分布式失败问题。

Control Intent 让未完成操作成为显式状态。Saki 在派发前记录请求动作与 Actor，通过 capability seam 时使用 Intent id 作为幂等键，并随着外部事实可观察而记录进度。重启恢复会继续或对账未完成 Intent，而不是根据不完整投影猜测成功。UI 因而能区分等待、失败和需要对账的工作，不会把乐观状态展示为已确认事实。

每条 Dispatch 通过对当前 claim 与 revision 的原子 compare-and-set 准入一项精确 Host Operation。不同 Agent Run 可以共享 Resource Binding，并保留独立 Session。其他记录通过 Intent 生命周期逐步收敛，无需伪装成共享同一事务。

## 考虑过的方案

**依次写入每条记录并调用每个 Provider。** 这种方案初始代码最少，却没有持久记录说明哪一步已经提交。重试可能重复创建 Run 或远端修改，而进程内锁会在最需要重启恢复时消失。

**把整个 Development Project 存成一个聚合记录。** 单记录原子性可以覆盖更多本地事实，但互不相关的 Work Item、Run 历史、提供方状态和生成产物会争用并反复重写一个持续增长的文档，而且仍无法让外部副作用原子化。

**增加 Saki 专用、支持多行事务的关系型存储。** 这能改善本地多记录提交，但 Saki 将额外拥有一套持久化生命周期、schema 演进、备份路径和测试矩阵，同时仍需为每个外部系统实现 saga。只有实测查询、规模或多 Host 需求超过 `storageDomain` 时才重新考虑，不能用它回避恢复设计。

**对所有控制面状态使用完整事件溯源。** 仅追加事实源可以重建投影并保存历史，但在产品命令与读模型尚未稳定时，0.1.0 还要同时承担事件排序、重放、schema 演进、投影重建和外部副作用去重。持久生命周期记录与已有 DSH Session 事件能以更少的不可逆基础设施提供所需可追溯性。

## 影响

控制面把用于 Access、bootstrap exchange 与 logout 的 `SakiAccess` 和用于 Intent 提交、受保护 Projection query 与 invalidation 的 `SakiControlPlane` 并列暴露。Bootstrap 与 logout 无法触及产品或外部副作用状态。提交后的通知只用于使投影失效；它不是第二条持久事件流，也不能授权外部工作。

每个外部 adapter 必须接受稳定 Intent 标识，并支持幂等派发或显式对账。adapter 返回稳定标识与普通数据，不返回活进程句柄或凭据内容。无法自动确定结果的 Control Intent 保持可见，并标记为需要对账。

Saki 0.1.0 不承诺跨记录 ACID 事务。每条权威记录都标识自己的拥有者与 revision，每个准入不变量只由一条记录拥有。恢复测试在持久阶段后中断操作、重新打开存储，并证明 Saki 保留归因且对每项请求操作去重。
