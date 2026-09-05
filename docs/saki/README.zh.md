# Saki

[English](README.md) | 中文

本目录拥有 Saki 特有的产品与运维文档。通用 DeepSeek Harness 架构和用户文档保留在现有上游位置。

## 产品

- [产品需求](product-requirements.zh.md)定义长期定位、领域抽象、原则和阶段边界。
- [0.1.0 实现规格](versions/0.1.0.zh.md)定义第一阶段首个可用切片及其发布条件。
- [0.1.0 后端架构](architecture/0.1.0-backend.zh.md)定义其 Module、capability seam、持久化所有权和故障语义。
- [0.1.0 前端约定](architecture/0.1.0-frontend-contract.zh.md)定义客户端状态、导航、Projection 消费、Intent 交互与验证，但不确定视觉方向。
- [0.1.0 Web UI 接入基线](architecture/0.1.0-web-ui-baseline.zh.md)记录要保留的 DSH 页面、分开的 Saki 页面、小白页面和少量壳层增量。
- [领域上下文](../agents/domain.zh.md)定义规范语言，[ADR](../adr/0004-control-and-execution-planes.zh.md)保存已接受的架构决定。

## 运维

- [维护](maintenance.zh.md)定义依赖评审、工作归属及可恢复的 Agent 检查点。
- [Host 启动器](host-launcher.zh.md)定义已签入仓库的 Windows 启动入口和代理行为。
- [上游同步](upstream-sync.zh.md)定义 Saki 如何跟踪 DeepSeek Harness，同时不继承不适用的 workflow。
- [开发 skill 包](development-skill-pack.zh.md)定义仓库发现、兼容性预检、固定来源记录和已审阅更新流程。
