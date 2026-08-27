# Agent Note: 委托独立 PR 落地

Status: implemented

[English](2026-08-27-delegated-standalone-pr-landing.md) | 中文

## 问题

一个独立产品 PR（Pull Request）可能已经达到稳定、测试全部通过且评审干净的状态，但负责它的 agent 仍无权合并。此时再要求仓库所有者单独确认，会中断长程工作，却不增加技术证据。把 CI 成功本身视为授权并不安全：检查结果无法确定预期 commit、评审状态、依赖拓扑或正确的合并模式。

## 决策

仓库所有者把独立 Saki 产品 PR 的落地权限委托给受托 agent。独立 PR 没有依赖它的开放 PR，并且既不是官方堆叠的条目，也不是上游同步 PR。

只有 GitHub 实时状态能够确定以下事实时，才不需要额外确认：PR 已 Ready 且可合并；其精确 head 与证据覆盖的 OID 一致；每项必需检查都已通过；不存在未解决的评审线程或仍然有效的要求更改决定。agent 使用该预期 head OID 进行 squash merge。证据缺失、陈旧或无法确定时，操作停止并汇报。

GitHub 报告 `MERGED` 后，agent 确认没有开放 PR 使用远端功能分支作为 base，且该 ref 仍指向已经落地的 head，然后删除该 ref。官方堆叠继续使用[覆盖整个堆叠的落地工作流](2026-08-02-native-github-stacks-and-optional-rebases.zh.md)，上游同步继续保留 [merge commit](2026-08-15-saki-upstream-synchronization.zh.md)。

## 曾考虑的替代方案

**每次合并都要求仓库所有者确认。** 这会在全部验收证据已经完备后保留一个决策点，却让无人值守的工作进入空等，而且没有收紧技术条件。

**必需 CI 成功后立即合并。** CI 不能授予权限，也不能证明 Ready 状态、预期 head、评审已解决、独立拓扑或所需的合并模式。

**把委托扩展到所有 PR。** 官方堆叠和上游同步具有不同的顺序、分支生命周期和历史要求；逐 PR squash merge 会违反这些工作流。

## 后果

- 确定性的验收条件满足后，长程产品工作可以立即落地。
- GitHub 状态存在歧义时快速失败，并把控制权交还仓库所有者。
- 独立 PR 历史保持紧凑；只有确认合并状态且没有依赖 PR 后，才删除远端功能分支。
