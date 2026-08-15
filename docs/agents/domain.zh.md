# 领域文档

[English](domain.md) | 中文

Saki 使用多个领域上下文。根上下文地图标识每个词汇表及其范围。

## 探索之前

1. 阅读 `CONTEXT-MAP.md`。
2. 阅读与当前工作相关的 `CONTEXT.md` 文件。
3. 阅读 `docs/adr/` 下的系统级决策。
4. 阅读 `docs/adr/<context>/` 下的上下文决策。

引用的上下文或 ADR 目录不存在时静默继续。只有术语或决策得到确认后，领域建模才会创建这些目录。

## 布局

```text
/
├── CONTEXT-MAP.md
└── docs/
    ├── agents/
    ├── contexts/
    │   └── work-management/
    │       └── CONTEXT.md
    └── adr/
        └── <context>/
```

## 使用已定义术语

在 Issue 标题、实现简报、假设、测试和文档中使用相关词汇表中的规范术语。不要使用 `Avoid` 下列出的同义词。

当所需概念缺失，或现有定义与请求的行为冲突时，使用领域建模工作流。

## ADR 冲突

明确指出与现有 ADR 的冲突。不要静默覆盖已记录的决策。
