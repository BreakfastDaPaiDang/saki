# Saki

Saki 是建立在 DeepSeek Harness（DSH）之上的个人 Agent 中枢，先接管多项目的开发与运营。先读本文，再按任务读取对应文档。

## 工作边界

- 不 fork DSH。DSH 是锁定版本的 npm 依赖，Saki 以插件、skill 和配置装配进去，见 `docs/adr/0001-depend-on-dsh-without-fork.md`。
- 领域代码不 import DSH 或 Cordis 的类型；只有适配层跟随 DSH 变化。
- 文档只写中文，不维护英文版或翻译配对。
- 做减法：只实现当前阶段需要的概念。旧 fork 时代的设计在 `master` 分支存档，遇到真实问题再从那里取回，不预先搬运。
- 运行环境是 Linux。

## 按任务读取

- 产品方向、阶段与原则：`docs/product.md`
- 领域词汇：`docs/glossary.md`
- 架构决定：`docs/adr/`
