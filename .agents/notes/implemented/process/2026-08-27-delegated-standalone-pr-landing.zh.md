# Agent Note: 委托独立 PR 落地

Status: implemented

[English](2026-08-27-delegated-standalone-pr-landing.md) | 中文

## 问题

一个独立产品 PR（Pull Request）可能已经达到稳定、测试全部通过且评审干净的状态，但负责它的 agent（智能体）仍无权合并。此时再要求仓库所有者单独确认，会中断长程工作，却不增加技术证据。把 CI 成功本身视为授权并不安全：检查结果无法确定预期 commit、评审状态、依赖拓扑或正确的合并模式。

## 决策

仓库所有者把符合条件的独立 Saki 产品 PR 落地权限委托给受托 agent。符合条件的 PR 来自同一仓库，直接以受保护的默认分支为 base，不属于实时原生 `stack` 或 `stackEntry`，没有开放 PR 使用其 head 分支作为 base，并且不使用固定的 `automation/upstream-sync` head。

落地前必须立即通过完整的 GitHub 实时查询确定：PR 不是 Draft，处于 `MERGEABLE` 且合并状态干净，并仍具有证据所覆盖的精确 `headRefOid`。受保护的 base 必须声明非空的必需检查集合，而且该 head 的每项必需检查都已经成功。必须穷尽评审线程的每一页，并确认每个线程都已解决；不能留有待处理的评审请求；`reviewDecision` 既不能是 `CHANGES_REQUESTED`，也不能是 `REVIEW_REQUIRED`。只有实时保护规则要求零个批准时，null 决定才可以接受。

所有条件成立后，才不需要额外确认。agent 使用预期 head 匹配进行 squash merge，绝不使用管理员绕过、预先启用的 auto-merge 或合并时一并删除分支。证据缺失、陈旧或无法确定时，操作停止并汇报。

GitHub 报告 `MERGED` 后，agent 再次完整查询使用远端功能分支作为 base 的开放 PR，并要求结果为零；出现任何结果都会停止清理并汇报。ref 不存在表示清理已经完成。如果 ref 仍然存在，`git push --force-with-lease=refs/heads/<branch>:<headRefOid> origin :refs/heads/<branch>` 会以合并前的 head 为预期值，在精确 lease 下删除它；ref 已移动时中止删除。官方堆叠继续使用[覆盖整个堆叠的落地工作流](2026-08-02-native-github-stacks-and-optional-rebases.zh.md)，上游同步继续保留 [merge commit](2026-08-15-saki-upstream-synchronization.zh.md)。

## 曾考虑的替代方案

**每次合并都要求仓库所有者确认。** 这会在全部验收证据已经完备后保留一个决策点，却让无人值守的工作进入空等，而且没有收紧技术条件。

**必需 CI 成功后立即合并。** CI 不能授予权限，也不能证明 Ready 状态、预期 head、评审已解决、独立拓扑或所需的合并模式。

**把委托扩展到所有 PR。** 官方堆叠和上游同步具有不同的顺序、分支生命周期和历史要求；逐 PR squash merge 会违反这些工作流。

## 后果

- 确定性的验收条件满足后，长程产品工作可以立即落地。
- GitHub 状态存在歧义时默认拒绝落地，并把控制权交还仓库所有者。
- 独立 PR 历史保持紧凑；只有确认合并状态、没有依赖 PR 且远端分支仍是合并前的精确 head 后，才删除该分支。
