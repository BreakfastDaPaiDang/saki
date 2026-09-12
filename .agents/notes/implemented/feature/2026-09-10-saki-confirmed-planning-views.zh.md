# Agent Note: Saki 已确认规划视图

Status: implemented

[English](2026-09-10-saki-confirmed-planning-views.md) | 中文

## 问题

Project 规划将完整 GitHub Board 与独立刷新的 Issue 正文、执行记录和 Release 证据组合起来。若浏览器关联原始 Provider 事实，或在扫描失败时替换完整 Board，就可能呈现未经确认的规划状态。响应丢失后重新提交移动，也可能丢失用户当时看到的准确远端修订。

## 决策

[Web 客户端](../../../../packages/saki/web-ui/README.zh.md) 在 React 外使用一个规划控制器，拥有经认证的查询缓存、可取消的失效轮询及准确 pending Intent；组件接收普通快照与手势回调。完整 Board 结果保持为基线，服务端确认的定向 overlay 携带更新的准确 Work Item 事实，乐观位置只改变展示。拖拽在开始时捕获卡片指纹；键盘对话框在打开时捕获指纹。两者提交相同 MoveWorkItem 操作，并保留用户看到的选中前驱指纹。Status 与位置阶段根据捕获的源状态和已确认的 Issue-state 前缀确定预期 Issue 状态，因此可显式归类和排序已关闭的 Issue，无需重新打开。前驱指纹在新的位置 effect 前保护其捕获状态。

未确认 Intent 在提交前按 Principal 与 Project 持久化。重新加载与切换 Project 保留准确载荷；显式恢复使用当前 request token 重放原始 Intent。终态确认或冲突会清除 pending 载荷。Principal 变化会取消受保护读取并清空业务缓存。传输失败保留确认值并停止轮询，直到刷新或 Connection 重置使其恢复。读取期间刷新操作保持可用；用户再次请求刷新时，控制器会替代前一个 Board 请求。缓存失效读取不会取消正在执行的用户远端刷新。

[Host API](../../../../packages/saki/host-api/README.zh.md) 提供不包含产品事实的经认证长轮询游标。扫描准入、完整发布、失败及 Provider 挂载变化，在其状态可读后使相关 Board 失效。提交变更会替换游标；心跳与 Host 重启促使浏览器重新读取完整且经授权的 Projection。Host 在等待前及返回前检查 Browser Session 权限，处置会释放所有计时器与监听器。该机制保留完整读取的权威，同时不增加第二套传输。

控制面从持久记录以及当前完整或定向确认的 Board 事实组装 Work Item 详情。正文失败独立于执行与交付证据。字段发现是一项完整、Provider 无关的读取，会验证 Project 归属而不要求旧 Status 字段仍然存在。显式映射变更仍仅在完整扫描成功后激活。Milestone 列表分页列出现有 Saki delivery 记录，并将其阶段与 Work Item Status 分开展示。

异步 Provider 读取在等待后比较所属 Consumer 挂载。Cordis 连续读取同一 Service 属性时可能返回不同的可追踪代理对象，因此 Service 包装对象身份不能证明挂载连续性。除该生命周期检查外，仍需检查准确 Project、Issue、配置及确认指纹。

本决策实现更广泛的 [Projection 驱动客户端提案](../../proposed/architecture/2026-08-18-saki-projection-driven-web-client.zh.md)中的 Project 规划。[壳层登记](2026-08-27-saki-web-shell-registration.zh.md)、[可恢复 Work Item mutation](../architecture/2026-08-16-saki-recoverable-github-work-item-mutations.zh.md) 与[完整 GitHub 同步](../architecture/2026-08-18-saki-polling-first-github-synchronization.zh.md)仍保留独立所有权及理由。Work 提交页与通用 Project Settings 仍是独立工作流。

## 考虑过的替代方案

**在 React 重建 Board 或执行关联。** 组件会复制后端映射与授权关系，独立到达的响应也可能看起来像一次完整确认。

**响应丢失后使用最新指纹重试。** 新指纹授权的是另一项操作，并会隐藏远端并发变更。准确 Intent 重放让已有持久 saga 检查自身 effect 历史。

**发现字段前要求 Status 映射有效。** 删除已配置字段会导致其修复 UI 无法进入。完整原始字段发现不依赖失效字段 id。

**另加 WebSocket 或发布变更增量。** 已有 Connection 请求载体支持有界取消与同源认证。失效游标不需要第二套事件协议或浏览器增量重建。

**读取缓存事实时禁用刷新。** 失效通知可能在指针按下与松开之间禁用按钮，使交互式请求根本没有发出。完整 Board 随后保持不变，直到下一次已安排的轮询。控制器已经拥有请求替代逻辑，按钮可用性无需再维护一套请求生命周期。

## 后果

浏览器能在独立失败期间保留有用确认值，而不会把乐观位置提升为权威。代价是保留按 Project 隔离的查询状态、失效后的完整重读，以及传输是否送达未知时的显式恢复手势。近期活动限定为 32 条引用；Milestone 列表只包含已配置 delivery 记录，不发现任意 GitHub Milestone。Provider 读取测试、规划对象测试、Host 认证测试和真实 bundle 浏览器流程覆盖对应所有权及失败场景。

规划浏览器回归在指针按下与松开之间挂起由失效通知触发的缓存请求，观察交互式请求，并要求新建 Issue 出现在完整 Board 中。[诊断产物](../../../../packages/saki/bundle/README.zh.md#planning-browser-diagnostics)保留浏览器请求、Host 响应、Provider 扫描及发布观察结果。该测试无需依赖调度时机，即可复现 [Issue 107](https://github.com/BreakfastDaPaiDang/saki/issues/107) 所报告的请求缺失及未来轮询状态。
