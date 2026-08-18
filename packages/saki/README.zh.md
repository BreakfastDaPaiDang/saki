# saki/ — 私有产品包

[English](README.md) | 中文

Saki 专属产品语义位于 `packages/saki/<pkg>`，并使用 `@breakfastdapaidang/saki-<pkg>` 命名空间。这些包保持私有，同时接受与 DSH 包相同的 TypeScript、Cordis、不变式、文档、依赖图、目录和许可证门禁。[治理参考](../../docs/saki/package-governance.md)负责命名空间与发布规则。

| 包 | 职责 | ctx key |
| --- | --- | --- |
| [`control-plane/`](control-plane/README.md) | Installation 基础记录、本地 Access 权限真源与受保护产品 Projection | `sakiControlPlane` |
| [`host-api/`](host-api/README.md) | 双侧 `/saki` Host 与浏览器传输适配器 | 浏览器侧提供 `sakiHostClient` |
| [`bundle/`](bundle/README.md) | Saki 组合根与仓库本地 Host 启动器 | 挂载控制面、传输层与 `saki-readiness` |

只有当一个产品切片具有可独立验证的职责时才新增包。通用 Harness 能力继续位于现有 DSH 组中；规划中的 Saki 包不得提前创建占位目录。
