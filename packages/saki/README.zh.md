---
description: "查找组装 Saki 的私有包，涵盖本地项目操作、GitHub 同步、Agent Run 和操作员干预。"
kind: "package-group"
---

# saki/ — 私有产品包

[English](README.md) | 中文

## 概述

查找组装 Saki 的私有包，涵盖本地项目操作、GitHub 同步、Agent Run 和操作员干预。

[Saki 子系统](../../docs/subsystems/saki.zh.md) 描述这些服务及其所有权。

## 目录

- [使用本包](#use-this-package)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

## 包

Saki 专属产品语义位于 `packages/saki/<pkg>`，并使用 `@breakfastdapaidang/saki-<pkg>` 命名空间。这些包保持私有，同时接受与 DSH 包相同的 TypeScript、Cordis、不变式、文档、依赖图、目录和许可证门禁。[治理参考](../../docs/saki/package-governance.zh.md)负责命名空间与发布规则。

| 包 | 职责 | ctx key |
| --- | --- | --- |
| [`execution/`](execution/README.zh.md) | 与 Host 实现无关的只读项目选择检查 Service Definition | `sakiHostExecution` |
| [`execution-local/`](execution-local/README.zh.md) | 使用本地文件系统、Git、subprocess、storage 与 Workspace index 的 Host 检查和结构化 operation Service Provider | 提供 `sakiHostExecution` |
| [`github/`](github/README.zh.md) | 提供方无关的 GitHub 读取、完整 Project board 扫描、原子 mutation、定向 inspection 与 Provider 约定 | `sakiGitHub` |
| [`github-app/`](github-app/README.zh.md) | 使用 operation 作用域 token、有界完整 scan、mutation 与定向 inspection 的 Saki Product GitHub App Service Provider | 提供 `sakiGitHub` |
| [`control-plane/`](control-plane/README.zh.md) | Installation 置备、本地 Access 权限真源、持久 Project 登记、原子 GitHub Board 发布、可恢复 Work Item mutation，以及受保护产品 Projection | `sakiControlPlane` |
| [`host-api/`](host-api/README.zh.md) | 双侧 `/saki` Host 与浏览器传输适配器 | 浏览器侧提供 `sakiHostClient` |
| [`installation-maintenance/`](installation-maintenance/README.zh.md) | Installation 范围 lease、manifest 所选状态 generation、已验证 Recovery Backup 与离线前向升级 | — |
| [`bundle/`](bundle/README.zh.md) | Saki 组合根与仓库本地 Host 启动器 | 挂载控制面、传输层与 `saki-readiness` |

只有当一个产品切片具有可独立验证的职责时才新增包。通用 Harness 能力继续位于现有 DSH 组中；规划中的 Saki 包不得提前创建占位目录。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
