# Agent Note: Saki 手动 Work 交互

Status: implemented

[English](2026-09-10-saki-manual-work-interactions.md) | 中文

## 问题

需求可能已经创建 GitHub Issue，浏览器却还没有收到结果。Agent（智能体）提出持久问题时，用户也可能离开「工作」页。若根据当前表单字段或组件生命周期重建这些操作，可能重复创建 Issue、改变预期修订号，或丢失返回执行证据的路径。

## 决策

[Web 客户端](../../../../packages/saki/web-ui/README.zh.md)在 React 之外拥有 Work 交互，并复用规划控制器的 Access 身份。My Work 分组与建议操作来自后端。创建候选来自授权 Project 索引及各 Project 的 Board，包括写入可用性，以及精确的 Project、同步与映射修订号。一个 Project 读取失败时保留其自身确认值，不影响其他 Project。显式刷新和创建完成会请求 Board 扫描；失效通知读取保持 cached，避免形成扫描反馈循环。My Work 读取尚未完成时，已显示的操作保持启用，直到新 Projection 或读取失败到达；提交仍保留原始修订号检查。

需求草稿、回答文本与已提交的原始 Intent 按认证 Principal 持久保存。客户端先保存 Intent 再发送。响应丢失时保留其 id 和完整 payload；显式恢复使用当前请求权限重放该 payload，不会另行分配 Issue 创建 Intent。部分创建显示已知 Work Item，并遵循后端恢复操作。需要对账的结果保持可检查，且不能关闭。关闭成功创建的结果会清除对应已提交草稿。Principal 或请求权限替换会取消旧读取和请求、清除确认缓存，并防止迟到响应改变新身份的视图。

手动 Give-to-Agent 建议包含严格且面向浏览器的安全启动摘要：Agent Profile id 与版本、精确 provider/model 路由、Resource Binding id 与修订号、显示标签及继承变更数量。确认保留建议中的 Project 修订号与 Issue 指纹。Intervention 回答保留建议中的请求修订号及惰性文本。提交通过现有[手动分派](2026-08-18-saki-manual-give-to-agent-dispatch.zh.md)与[持久回答](2026-08-18-saki-durable-intervention-answer.zh.md)所有者重新验证。浏览器操作不会绕过这些所有者，也不会直接插入模型输入。

Work Item 详情同时接受已回答、已解决的 Intervention 历史和未处理问题；My Work 仅保留可处理的 Intervention 状态。新建 Inbox Issue 在 Project Board 中打开。Ready 建议出现在 My Work；改变 Status 不会启动 Agent。卡片打开现有 Work Item 视图，其 Session 操作恢复继承的 Conversation。Work 与 Project 交互 store 在导航和浏览器重新加载后保留各自输入与地址。Saki bundle 挂载 Chat target、Tool 渲染及其资源与详情侧栏依赖，以渲染持久 Session 消息。

本决策实现[投影驱动客户端提案](../../proposed/architecture/2026-08-18-saki-projection-driven-web-client.zh.md)中的手动 Work 部分。该提案仍保留自动领取、预算暂停、完成、Settings 与更广泛的集成工作。[已确认规划视图](2026-09-10-saki-confirmed-planning-views.zh.md)、[可恢复 Work Item 变更](../architecture/2026-08-16-saki-recoverable-github-work-item-mutations.zh.md)、手动分派及持久回答仍拥有各自独立的职责与理由。

## 考虑过的替代方案

**响应丢失后根据最新表单或建议重建请求。** 新 id 或修订后的 payload 授权的是另一项操作。持久后端只能对账原请求的副作用。

**在 React 中连接执行状态或推导 eligibility。** 后端记录、Grant 与操作条件可以独立变化。完整 My Work 结果及单项建议操作保留其现有权威。

**将 Ready 视为执行许可。** Status 是规划状态。手动执行需要明确确认；自动分派属于独立的策略与预算工作流。

## 后果

Planning 与 Work 浏览器 fixture 为 Project 登记请求提供 240 秒期限。登记依次执行三次检查，每次包含两个具有 30 秒产品预算的仓库观察阶段，随后完成 Workspace 与持久 registry 写入。fixture 的登记期限覆盖这些工作的总预算；单次 RPC 与浏览器操作的期限独立设置。

用户可以通过组合后的产品创建需求、规划任务、授权 Run、回答其问题并检查 Session。后端与浏览器测试覆盖启动摘要校验、身份替换、独立读取失败、精确重放、原生对话框操作及延迟确认。真实 bundle 浏览器用例拥有临时 Git 仓库与独立 Installation，仅替换外部 GitHub 和 LLM（大语言模型）Provider，并在手动流程中检查只创建一个 Issue。自动领取、预算暂停、自动 Done、生产模型供给及通用恢复仍属独立工作。
