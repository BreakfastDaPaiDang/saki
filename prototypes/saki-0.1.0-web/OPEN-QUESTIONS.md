# 产品决定（K0）

## 已冻结（按产品决定实现，不再开放）

1. **目标 Project**：显式 selector；可以预选最近 Project，但提交前必须可见、可改并由用户确认。— 已在「提交需求」对话框实现。
2. **Generation 入口**：0.1.0 不做独立人工生图入口；由 Agent/skill Consumer 触发。— prototype 只在 Model Supply 展示队列。
3. **Offline**：远端 GitHub Intent 禁用并说明原因，不离线排队后伪装成功；本地 Git/Changes 仅在 Host 与 Binding 可用时继续；ack 不确定进入 reconciliation。
4. **场景工具条**：仅 K0 fixture 工具，K1 替换时删除。
5. **Provider route**：Project 配默认 Agent Profile，Session 记录已解析 route；不做额度耗尽后的静默换号。

## 已确认的推荐默认值

6. **默认落地页**：My Work；0.1.0 不做 Principal preference。
7. **Attention badge 口径**：只计未解决、当前需要人处理或阻塞自动化的记录；info/resolved 不计，页内按原因分组。
8. **窄屏 Board 形态**：一次一个状态列 + 列选择器；移动用显式状态菜单与键盘等效，宽屏保留 drag。
9. **冲突反馈级别**：card-local + page-level `aria-live`；receipt/reconciliation 放详情；只有 project-wide sync/binding 故障用全局 banner。
10. **Intervention 输入形态**：按 kind 结构化——clarification 为文本回答、approval 为批准/拒绝、credential/policy/budget 为修复链接或明确动作；不做万能文本框。
11. **窄屏 Settings 形态**：独立全屏 modal，并保留来源 return address。
