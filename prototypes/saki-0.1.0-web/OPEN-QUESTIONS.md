# 未决问题清单（K0，需要产品决定）

以下问题在 prototype 制作过程中浮现，约定文档没有给出明确答案。生产实现前需要产品拍板；prototype 中的临时选择已注明。

1. **「工作」页的默认落地顺序。** 约定说“组织账号出现前，0.1.0 可以先向 Host Operator 提供 My Work”，但没定 Saki 启动后的默认 address。prototype 暂定：有已登记 Project 时默认落在「工作」；需要决定默认落地页是「工作」还是最近会话，以及是否成为 Principal preference（约定提到以后可以，0.1.0 是否包含该偏好设置？）。

2. **Attention 徽标计数口径。** 侧边栏「工作」的计数目前等于 Attention Inbox 条目总数（含 info 级 assignment 通知）。需要决定：只计 action-needed / urgent，还是全部开放条目？info 级条目是否应在「工作」页以不同权重展示？

3. **「提交需求」的目标 Project。** My Work 是跨 Project 的，但 `create-work-item` 需要一个目标 Project。prototype 暂时硬编码到主项目。需要决定：提交需求时是否要求选择 Project（多一步），还是默认“最近使用”并允许事后移动？

4. **受限 viewport 下看板的形态。** prototype 把六列看板在窄屏下纵向堆叠（Inbox→Done 顺序）。备选是“列选择器 + 单列显示”。堆叠保留全局顺序感但滚动长；单列更聚焦但看不到列间关系。需要产品选择，或接受堆叠作为 0.1.0 答案。

5. **Board 冲突的呈现级别。** 现在冲突显示在卡片上（红边 + 文字）并配合 aria-live 播报。需要决定：是否还需要全局横幅或 modal？多人高频冲突场景下卡片级提示是否足够？

6. **Intervention 回答的输入形态。** prototype 使用自由文本 textarea。约定中 Intervention Request 有 kind（输入、审批、凭据授权、验收、冲突解决、对账）。需要决定：审批类是否应为结构化的“批准/拒绝 + 备注”，而不是自由文本？这会影响 Intent 形状。

7. **Generation Job 的入口位置。** Model Supply 分节展示了队列，但“从 Work Item 或 Work Session 发起生图”的入口 prototype 未做（约定把它列为后端研究待稳定区）。需要决定：0.1.0 的生成入口是在会话内（Agent 工具）还是也有手工入口？

8. **离线时可写操作的处理。** 现在离线场景把 Board 设为只读。约定说“绝不伪造远端写入成功”，但允许哪些本地 Intent（例如 commit 是纯本地 Git）排队等重连？需要产品确认“离线可提交、重连后确认”的白话解释边界。

9. **Settings 对话框在窄屏的形态。** DSH 现有对话框是居中的；窄屏下 prototype 让它接近全屏。需要确认与 DSH 壳层一致的响应式行为，还是 Saki 分节单独处理。

10. **prototype 工具条的去留。** 场景切换条是开发工具。需要决定：K1 之后是否保留一个“fixture 模式”开关用于开发/演示（类似现有 `?fixture`），还是完全删除。

11. **账号池 UI 与 0.1.0 非目标的关系。** 0.1.0 非目标排除“以绕过提供方限制为目的的自动轮换”和“共享模型配额”；Model Supply 分节展示多 Profile 与手动选择。需要确认：手动切换默认账号的入口（哪个层级：Installation 默认 / Project 默认 / 启动时选择）在界面上放在哪里——prototype 只在 Profile 卡片上标注了“默认”，切换交互未做。
