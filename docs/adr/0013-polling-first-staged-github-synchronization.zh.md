---
status: accepted
---

# 使用 polling-first 分阶段快照同步 GitHub

[English](0013-polling-first-staged-github-synchronization.md) | 中文

0.1.0 版本通过完整的分阶段扫描同步每个已配置的 GitHub Project 和 Repository。轮询是基线交付机制；未来 webhook 可以请求提前扫描，但绝不直接应用 Project 变更。只有每个必需页面与映射检查均成功后，Saki 才发布新的 Board 投影；扫描不完整时保留上一个已确认投影。

## 决策原因

GitHub 拥有共享 Work Item Status 和手动排序，因此 Saki 不能把乐观客户端状态当作权威状态来恢复。GraphQL cursor 只标识一次分页遍历中的位置；它不是持久变更流 offset，也不能证明遍历页面之外的记录没有变化。Webhook 交付同样不能提供这种证明：GitHub 不会自动重新交付所有失败 webhook，而 Projects v2 webhook 覆盖也不适合作为首个本地产品的发布依赖。

完整扫描对单操作者版本而言成本可控，并给出一条可测试的发布规则。它也保留直接升级路径：webhook 可以通过唤醒同一个扫描器来降低延迟；后续增量读取可以继续作为优化，但周期性完整扫描仍用于修复遗漏的观察结果。

GitHub mutation 不暴露通用的 compare-and-set revision。Saki 可以在 mutation 前通过定向读取发现大多数陈旧本地操作，并在之后确认结果状态，但其他参与者仍可能在这些调用之间修改同一 item。因此本设计承诺可见的冲突检测以及向已确认 GitHub 状态收敛，而不承诺跨 Saki 与 GitHub 的可串行化事务。

## 同步协议

### 检查点与发布

每个绑定存储一条 GitHub Sync Checkpoint，其中包含 Installation、GitHub Project、Repository、映射 revision、本地扫描 generation、最近一次成功完整扫描时间、已确认远端指纹，以及当前 rate-limit 或失败观察。页面 cursor 只存在于一次进行中的扫描内，并在完成或失败时丢弃。

一次 Board 扫描会验证持久 node-id 映射，按 API 顺序读取所有已配置 Project item 页面及其 Status 值，读取关联 Repository 中用于确定 Inbox 成员关系的开放 Issue，并构造候选快照。只有所有页面与不变量均成功后，控制面才原子发布候选快照并推进检查点。部分响应、映射失败、权限失败、取消或 rate limit 都不会改变既有检查点和已确认快照，而会单独暴露新的失败。

活动 Board 默认每 30 秒轮询一次，后台 Project 默认每五分钟轮询一次。启动、手动刷新、本地 mutation、重连和未来 webhook 会请求立即扫描。两个间隔与后台 rate-limit 保留量都是经过验证的 Cordis 插件配置，而不是固定协议常量。

### 乐观 mutation

每个 Board mutation 都携带受影响 Issue 和 Project item 最近一次已确认远端指纹。该指纹覆盖 Project 成员关系、Status option、Issue 开放状态，以及所请求移动涉及的排序邻居。

mutation 前，GitHub 适配器执行定向读取。若已确认远端状态已等于目标状态，Intent 以幂等成功结束。若它等于预期指纹，Saki 提交 mutation，并在提交新的观察结果前再次读取目标。其他状态均为冲突：Saki 不会覆盖远端状态，而是以最新已确认 GitHub 状态替换乐观显示，并将重试作为新 Intent 提供。mutation 响应缺失或超时会先触发检查再重试；沉默绝不证明失败。

确认读取可能观察到更晚发生的并发变更，因此即使它与请求目标不同，也仍然具有权威性。Saki 会记录请求的 mutation 与确认结果，使差异可解释。

### 映射修复与 rate limit

持久化的 Project、field、option、item、Repository 和 Issue node id 是权威映射引用。名称匹配可以建议替代项，但绝不会自动修复缺失或重建的 field。无效映射会使受影响 Board mutation 不可用，直到带归因的修复 Intent 选择或创建替代映射，并且一次完整扫描成功。

每个 GitHub App installation token 使用一条串行 API 队列。mutation 定向读取、mutation、确认读取、登录和手动刷新优先于后台扫描。后台工作会在耗尽可配置保留量前暂停。适配器观察 GraphQL cost 与 reset 事实、REST rate-limit header、`Retry-After` 和 secondary-limit 响应；支持时 REST 读取使用条件请求。影响恢复的退避有上限并持久化，而不是实现为不可观察的进程 sleep。

## 考虑过的方案

**要求 0.1.0 使用 webhook。** Webhook 能降低延迟，但会给本地版本增加公共入口、secret 轮换、交付恢复和不完整交付处理。它不能替代协调扫描，因此未来只作为可选唤醒来源。

**把 GraphQL page cursor 持久化为同步 offset。** Page cursor 可在一个结果 connection 内恢复分页，却不能标识较早扫描之后的全部变更。将其当作变更 cursor 可能发布新旧页面混合状态并遗漏删除。

**把每个已获取页面直接应用到 Board。** 后续页面、权限错误或映射变更会把部分远端世界暴露为已确认状态。分阶段处理需要临时内存，但可以保留单一原子投影 revision。

**不做定向读取而让最后写入者获胜。** 这会静默覆盖本地客户端陈旧期间在 GitHub 上发生的变更，并违背 GitHub 权威性。读取—确认—再读取协议虽不能创建跨系统事务，却能让冲突可见。

**按 option 名称修复映射。** 重命名或重建的 field 可以复用同一个人类可读名称，却具有不同身份或含义。建议很有用，但必须由带归因的修复决策选择新 node id。

## 后果

Board 新鲜度受配置的轮询间隔约束，而非实时交付。UI 始终区分最近一次已确认快照、乐观 overlay、扫描时效与当前同步失败。若 Project 所需映射无效，或其已确认状态对策略而言过于陈旧，自动模式不能领取或完成工作。

GitHub Service Definition 暴露完整扫描、定向读取、mutation、确认和 rate-limit 事实；Saki 控制面拥有 Board 映射、分阶段发布、冲突规则与检查点持久化。测试覆盖多页扫描、移除、不完整页面、映射重建、乐观移动期间的远端编辑、mutation 回复丢失、secondary limit、进程重启，以及只唤醒而不直接应用状态的 webhook。

该协议的外部参考资料是 GitHub 的 [GraphQL 分页](https://docs.github.com/en/graphql/guides/using-pagination-in-the-graphql-api)、[GraphQL rate limit](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api)、[REST API 最佳实践](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)和[失败 webhook 交付行为](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries)。
