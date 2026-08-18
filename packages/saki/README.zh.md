# saki/ — 私有产品包

[English](README.md) | 中文

Saki 专属产品语义位于 `packages/saki/<pkg>`，并使用 `@breakfastdapaidang/saki-<pkg>` 命名空间。这些包保持私有，同时接受与 DSH 包相同的 TypeScript、Cordis、invariant、文档、依赖图、catalog 和许可证门禁。[治理参考](../../docs/saki/package-governance.md)负责命名空间与发布规则。

| 包 | 职责 | ctx key |
| --- | --- | --- |
| [`bundle/`](bundle/README.md) | Saki 组合根与仓库本地就绪启动器 | 挂载 `saki-readiness` |

只有当一个产品切片具有可独立验证的职责时才新增包。通用 Harness 能力继续位于现有 DSH 组中；规划中的 Saki 包不得提前创建占位目录。
