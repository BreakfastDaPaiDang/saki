# 验证记录（K0）

验证方式：`npm ci && npm run build && node validation/validate.mjs`。harness（`validation/server.mjs` + `validate.mjs`）用 Playwright 驱动 `vite preview` 服务的生产构建：唯一空闲端口、readiness 轮询、early-exit 检测、完整进程树 teardown 并 await。原始结果存于 `validation/results/results.json`；失败时自动截图。最近一次运行：**52 项检查，0 失败**。

## 覆盖（desktop 1440×900 与受限 viewport 480×840 双路，除标注 desktop-only 项）

**My Work**：四分组齐全；等待验收在“等你处理”；Done/Canceled 无验收操作；处理中条目无 mutation offer（“打开”是导航）；需要关注区按原因分组且每项可回到所属对象；axe 无严重违规。

**Action Offer 协议**：交给 Agent 预提交复核展示 Profile/Route/权限/Binding/继承变更/限制；pending 与 confirmed 的 toast 携带同一个稳定 receipt id；pending 期间重复点击被禁用挡住或由控制面按相同在途 Intent 去重为同一 receipt，只确认一次。

**看板**：乐观 overlay 在 pending 时从源列移除并插入目标列（断言目标列 DOM 与“等待确认”标记，不只是最终 toast）；冲突后恢复已确认快照并显示卡片级 conflict 文案；真实拖拽与 Alt+←/→ 键盘等效均验证；窄屏一次一列 + 列选择器，键盘移动在窄屏同样可达。

**区段与导航**：六个内部区段往返 aria-selected 正确翻转；drawer Enter 打开、Esc 关闭、焦点返回发起卡片；地址序列化覆盖 item/session/run/milestone/file/board filter，reload 后 drawer 仍在；Settings 从项目页打开后返回项目页（不固定回 My Work）；Project 切换保留当前区段。

**CreateWorkItem**（唯一入口在「工作」页）：完整字段（标题、预期结果、验收条件、显式 Project selector、expected Project revision 与 expected GitHub mapping revision 可见）；confirmed 后新卡出现在对应 Project 的 Inbox；partial（Issue 已创建未加入 Project）与 ack 丢失（reconciliation-required）时对话框不关，对账检查后安全重试，同名重交幂等确认。desktop 与窄屏双路。

**Project Settings（K7 owner 流）**：默认 Agent Profile 编辑；Automation Policy 的触发方式/动作/类型化预算 field-scoped 编辑；同步配置保存后激活链 saved → revalidating → scanning → checkpointed → activated 逐步推进且明示“保存成功不等于已启用”；Resource Binding 与 GitHub 映射只读并链接到各自 owner 流程。

**恢复与状态语义**：binding 修复从 Projects 页带归因确认；mapping 修复后看板恢复读写；预算例外高风险确认标明 Project 与 24 小时过期；离线时看板只读且 看板写入 unavailable 文字可见、本地区段仍可用；重连恢复出现“需要对账”并可回到所属对象；三种 Empty（首次扫描未完成 / 不存在 / 筛选排除）分别断言；刷新中保持已确认值可读。

**Model Supply**：多 Profile（Codex/Kimi）、Usage Snapshot 三态、local-user-trust 保护等级、Context Policy、Generation Job 取消与重试（取消确认后等待新 revision 再重试）；axe 无严重违规。

**多项目隔离**：Saki 暂存文件后官网改版的 Changes 保持不变（断言对方无暂存行）。

**bootstrap**：secret 用后即清（返回上一步输入框为空）；登记流程走完并进入 Development Workspace。

## GIF

`k0-prototype-demo.gif` 从本分支最终 head 的生产构建（`vite preview`）重录，覆盖：「工作」→ 交给 Agent 复核 → 看板 → Work Item drawer → 会话与运行 → 看板冲突 → Model Supply。fixture 驱动的 prototype 录制，不替代后续生产 PR 从真实 Saki server/model flow 录制的 GIF；场景工具条仅属 K0。

## 历史

首轮 harness（48 项）曾通过；本轮按返工要求重建 harness（可靠 server helper、无固定 sleep 作为状态证明、进程树 teardown）并扩充到 52 项双 viewport 断言。过程中修复的真实缺陷：drawer 未处理 Esc 与焦点回收、drawer/对话框打开时 Enter 误触关闭按钮（焦点延后到手势结束）、紫色 chip 与主色按钮对比度、tablist 角色与 list 语义、Attention 按钮 label-in-name、prototype 工具条遮挡侧边栏设置入口、CreateWorkItem 第二入口、处理中条目伪装的 claim offer、receipt id 不稳定、多项目串写。
