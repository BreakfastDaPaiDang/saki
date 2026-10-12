# 依赖 DSH 发布包，不 fork

状态：已接受（2026-10-12）

Saki 以锁定版本的 `@deepseek-ai/*` npm 包依赖 DSH，自身以插件、skill 和配置装配进 DSH，不再维护 DSH 的 fork。

## 背景

旧 Saki 是 DSH 的完整 fork，靠每日上游同步、自动合并、冲突 draft 和兼容性 Issue 跟上上游。DSH 的破坏式更新频繁，插件层 Cordis 仍在 rc 阶段，产品代码又直接长在 DSH 内部 API 上，每次上游重构都要重新对账。维护 fork 的成本持续增长，却不产出产品价值。

## 决定

- DSH 版本锁死，由我们决定何时升级，攒一批改动一次升级。
- 需要改变 DSH 行为时依次选择：现有扩展点（preset、skill、hooks、bundle、Service）；向上游提 PR 争取扩展点；最后才用 `pnpm patch` 打最小补丁，补丁清单保持可见、可数。
- 代码分两层。领域层是纯 TS，不 import DSH 或 Cordis 的类型；适配层把领域能力注册为 DSH 的 Service 和 tool。DSH 变动只波及适配层。
- 产品状态不保存工作目录句柄、进程或凭据。执行结果以 Outcome Evidence 回报，不由执行过程直接改写项目状态。

## 后果

DSH 升级成为一次显式、有边界的工作，而不是每日的被动合并。代价是无法随意改 DSH 内部；确实需要时，补丁的数量直接暴露了我们对上游的依赖程度。

旧设计中的控制面/执行面分离（`master` 上的 ADR 0004）不单独保留：单 Host 阶段 DSH 本身就是执行面。出现第二个 Host 时再重新评估。
