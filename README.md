# Saki

Saki 是早餐社的 Agent 中枢：站在 DeepSeek Harness（DSH）之上，把多个开发与运营项目收进一个可观察、可让 Agent 直接操作的工作系统。

本分支（`main`）从零开始，不再 fork DSH：

- DSH 作为锁定版本的 npm 依赖，Saki 以插件、skill 和配置的形式装配进去。
- 需要改 DSH 时依次走：现有扩展点、向上游提 PR、`pnpm patch` 最小补丁。
- Saki 的领域层不依赖 DSH 类型，DSH 变动只影响适配层。

旧的 fork 实现保留在 `master` 分支作为档案，产品文档按需挑选迁入。
