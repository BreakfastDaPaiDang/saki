# Agent Note: 仓库拥有的开发 skill 包

Status: implemented

[English](2026-08-19-repository-owned-development-skill-pack.md) | 中文

## 问题

Saki 依赖可重复的规划、实现、审阅和 handoff 实践，但用户全局安装的 skill（技能）可变，而且不同机器并不一致。从本地 Codex 安装复制指令会掩盖来源与许可证，直接消费上游分支则会让已审阅行为在没有仓库 diff 的情况下发生变化。上游指令还会假设 DSH 不一定提供的工具、路径、tracker 默认值和调用行为。

## 决策

仓库拥有放在 [`.dsh/skills`](../../../../.dsh/skills) 下的一组 11 个适配 skill。DSH 现有文件系统提供方以 `project-dsh` 发现此位置，因此这套 skill 使用常规插件能力，不增加第二套 skill loader，也不向用户主目录安装文件。

[manifest（元数据清单）](../../../../.dsh/skill-pack/manifest.json)固定一个完整的 `mattpocock/skills` commit，并记录每个选中的来源 blob、明确忽略的上游文件、适配补丁、输出 hash、兼容性声明以及保留的 MIT 许可证。每个 skill 都有一份仓库拥有的补丁，使 DSH 特有变更可被审阅，同时不会把本地安装冒充为来源。冻结集合包含 `ask-matt`、`grill-with-docs`、`grilling`、`domain-modeling`、`to-spec`、`to-tickets`、`triage`、`implement`、`tdd`、`code-review` 和 `handoff`；`codebase-design` 与别名包装器不在其中。

每份指令声明其所需、替代和可选能力、宿主命令与变更类别。缺少所需设施时，其兼容性预检会在变更前停止。tracker 工作流运行 `gh auth status` 等非仓库作用域命令时不传 `-R`，每条仓库作用域 `gh` 命令都传入 `-R BreakfastDaPaiDang/saki`；handoff 工作流只写入 `.scratch/handoffs/`。

更新命令要求完整 commit，默认执行 dry-run，校验当前 skill 包，只获取具名上游 revision，拒绝已审阅允许列表之外的上游文件清单，并重新应用签入仓库的补丁。它把所请求的 commit 写入每个适配 skill，并离线校验完整候选项。发布过程暂存当前 `.dsh` 目录，只替换其中由本功能拥有的 skill 与来源记录子树，再以回滚保护交换该目录。`--write` 拒绝 dirty 的 skill 包目录树；候选项被拒绝时不会改变 checkout 中的 skill 包。

## 验证

可移植的离线校验器拒绝来源记录漂移、输出或补丁改变、意外文件、符号链接、失效资源链接、不一致的兼容性元数据以及不等于冻结 11 项的 skill 集合。聚焦测试从隔离的全新项目和隔离的 home 目录加载真实文件系统 skill 提供方。无密钥的装配 ACP（Agent Client Protocol）快照覆盖规划到 handoff 的流程，也覆盖缺少所需 shell 能力时给出可操作预检失败。第三方声明披露固定来源和保留的许可证。

## 考虑过的替代方案

**依赖用户全局 Matt skill。** 这可以避免把指令纳入仓库，但行为会依赖可变的机器状态，而且全新 checkout 无法复现开发工作流。

**在运行时加载上游仓库或分支。** 这减少签入的文件，但会在 agent（智能体）行动时引入网络可用性、移动来源和未审阅指令风险。

**复制本地 Codex 安装。** 这在一台机器上很方便，但无法证明上游来源，还可能纳入本地编辑或安装特有元数据。

**引入 Saki 特有的 skill loader。** 现有 DSH 文件系统提供方已经用明确优先级发现仓库 skill，因此再建一个 loader 会重复生命周期与发现行为。

## 后果

skill 变更成为普通仓库变更，并具有可审阅来源记录、双语运维文档、许可证披露和无密钥证据。checkout 可以在 Linux、macOS 与 Windows 上发现同一套 skill，无需外部凭据。

更新上游固定版本有意要求严格审阅：上游文件清单改变需要显式允许列表决定，补丁冲突会停止更新，适配输出改变需要新的 hash 与快照。这套 skill 无法承诺每个 skill 都能在每种 DSH 组合中运行；显式预检会在变更前把能力缺失转化为诊断。
