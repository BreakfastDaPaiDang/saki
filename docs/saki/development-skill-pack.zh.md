# Saki Development Skill Pack

[English](development-skill-pack.md) | 中文

Saki Development Skill Pack 是一套由仓库拥有的 agent（智能体）指令，用于规划、实现、审阅和 handoff。DSH 从项目根目录的 `.dsh/skills` 发现这套 skill（技能），因此全新 checkout 无需依赖用户全局安装的 skill，也能获得相同指令。

## 包含的工作流

| skill | 用途 |
| --- | --- |
| `ask-matt` | 选择下一个工作流和适合的会话边界。 |
| `grill-with-docs` | 在维护领域与决策文档的同时细化设计。 |
| `grilling` | 在实现之前压力测试计划。 |
| `domain-modeling` | 维护领域上下文和架构决策。 |
| `to-spec` | 发布已达成共识的产品规格。 |
| `to-tickets` | 把已接受的规格拆成可独立执行的 Work Item。 |
| `triage` | 分类 tracker 条目并准备为 agent 可执行状态。 |
| `implement` | 实现已接受的规格或 Work Item。 |
| `tdd` | 对行为变更应用测试驱动开发。 |
| `code-review` | 根据仓库约定与证据审阅变更。 |
| `handoff` | 在 `.scratch/handoffs/` 下写出可移植的实现 handoff。 |

## 发现与验证

DSH 的文件系统 skill 提供方从活动工作目录向上查找项目根目录，并发现 `.dsh/skills`。仓库 skill 使用常规 `project-dsh` 优先级；这套 skill 不会把指令复制到 `.agents`、`.codex` 或用户主目录。

离线校验器检查冻结的 skill 集合、适配后输出 hash、来源 blob 声明、补丁 hash、资源链接、许可证、兼容性元数据和符号链接禁令。发现测试在 DSH home 与 Agents home 都隔离的全新项目中加载真实文件系统提供方。

```sh
pnpm run verify-saki-skill-pack
pnpm run test:saki-skill-pack
```

## 兼容性预检

每个纳入的 `SKILL.md` 都在 frontmatter 中声明所需 DSH 能力、替代能力、可选能力、宿主命令和变更类别，并在 `DSH compatibility preflight` 下重复面向用户的检查。所需能力或命令缺失时，skill 必须在任何变更之前停止并给出可操作诊断。tracker 工作流运行 `gh auth status` 等非仓库作用域命令时不传 `-R`，每条仓库作用域 `gh` 命令都显式传入 `-R BreakfastDaPaiDang/saki`。

## 更新固定版本

更新器只接受完整的 40 字符 commit，且默认执行 dry-run。它从 `mattpocock/skills` 获取该精确 commit，拒绝已审阅来源与忽略文件允许列表之外的增删，应用签入仓库的逐 skill 补丁，把精确 commit 写入每个适配 skill 的来源元数据，并离线校验完整候选项。dry-run 会在不修改仓库的情况下报告有变化的输出。

```sh
pnpm run update-saki-skill-pack -- --ref <40-character-commit>
pnpm run update-saki-skill-pack -- --ref <40-character-commit> --write
```

`--write` 还要求 `.dsh/skills` 和 `.dsh/skill-pack` 目录树保持 clean。它暂存当前 `.dsh` 目录，只替换其中已校验的 skill 与来源记录子树，再通过同一文件系统内的目录事务发布结果；发布失败时恢复原目录树。提交之前根据签入仓库的补丁逐项审阅所有重写的指令，然后运行校验器、发现测试、装配快照和文档检查。

## 来源记录

[`.dsh/skill-pack/manifest.json`](../../.dsh/skill-pack/manifest.json)记录上游仓库、精确 commit 与日期、选中和忽略的上游 Git blob、适配补丁 hash、输出 hash 与能力声明。[保留的 MIT 许可证](../../.dsh/skill-pack/LICENSE.mattpocock-skills)与[第三方声明](../../THIRD_PARTY_NOTICES.md)覆盖嵌入的指令。补丁是上游文件与仓库拥有的 DSH 变体之间可审阅的差异。
