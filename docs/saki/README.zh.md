# Saki

[English](README.md) | 中文

本目录拥有 Saki 特有的产品与运维文档。通用 DeepSeek Harness 架构和用户文档保留在现有上游位置。

## 产品

- [产品需求](product-requirements.md)定义长期定位、领域抽象、原则和阶段边界。
- [0.1.0 实现规格](versions/0.1.0.md)定义第一阶段首个可用切片及其发布条件。
- [领域上下文](../agents/domain.md)定义规范语言，[ADR](../adr/0004-control-and-execution-planes.md)保存已接受的架构决定。

## 运维

- [Host 启动器](host-launcher.md)定义已签入仓库的 Windows 启动入口和代理行为。
- [上游同步](upstream-sync.md)定义 Saki 如何跟踪 DeepSeek Harness，同时不继承不适用的 workflow。
