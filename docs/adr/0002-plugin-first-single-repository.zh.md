---
status: accepted
---

# 优先在单一 Saki 仓库内使用 DSH 插件

[English](0002-plugin-first-single-repository.md) | 中文

Saki 特有行为使用 DSH bundle、Service Definition、Provider 和 Consumer 扩展点，但当前产品阶段的相关 package 保留在 Saki 仓库。运行时模块接口和 Git 仓库边界是两个不同决定；DSH 接口仍在演进时，单仓库允许原子重构和兼容性更新。

## 考虑过的方案

为每项功能建立仓库看似隔离，却会在接口和用户尚未独立时引入版本错位、跨仓库 CI 和协调发布成本。把 Saki 语义直接写入 DSH core 则会增加上游冲突，并让通用 harness 依赖一个产品。

## 影响

只有插件形成稳定 DSH 接口、独立用户或维护者、独立发布节奏，或者不同部署与安全生命周期时才拆分仓库。通用能力改进仍可贡献上游；Saki Project 语义由 Saki 拥有。
