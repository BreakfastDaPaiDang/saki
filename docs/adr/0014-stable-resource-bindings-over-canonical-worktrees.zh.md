---
status: accepted
---

# 让 Resource Binding 身份在 worktree 位置变化后保持稳定

[English](0014-stable-resource-bindings-over-canonical-worktrees.md) | 中文

一个 Development Project 及其所有 Execution Lease 都寻址同一个稳定 Resource Binding id。本地绑定存储其 DSH Workspace 与 Git worktree 位置的带 revision 观察，但路径、分支、remote 或 Git object id 都不会成为绑定身份。登记会规范化可用目录与 Git 管理路径，防止别名创建第二个可写绑定。位置迁移与替换 Host 恢复只能通过带归因的 rebind 操作更新观察结果。

## 决策原因

同一个物理 worktree 可以通过不同盘符大小写、分隔符、junction、symlink 或包含 `..` 的路径访问。若按调用者提供的拼写确定 Execution Lease 键，两个 Development Project 就可能同时写入同一批文件。按分支确定键同样错误，因为 worktree 可以使用 detached HEAD，也可以在不变成另一项资源的情况下切换分支。

Git 通过各 worktree 私有管理数据区分主 worktree 与 linked worktree。`git rev-parse --git-dir` 标识该私有管理位置，而 `--git-common-dir` 标识共享 Repository 家族。这些路径在 worktree 可用时是很强的重复检测证据，但主 Repository 被移动、复制到另一 Host 或从 clone 重建后都可能改变。Git 不提供可供 Saki 作为永久权威使用的可迁移 Repository UUID。

DSH Workspace 已经在一个经 `fs.realpath` 规范化的目录之上提供稳定生成 id，但它的路径不可变。历史 DSH Session 也保留原始 cwd。因此 Saki 不能通过重写其中任何一项来表示位置迁移，也不能假装旧 Session 历史在新路径执行。

## 绑定协议

### 登记与重复检测

0.1.0 版本登记已有目录。它不创建、移动、移除、prune 或 repair Git worktree。Host 使用 `fs.realpath` 解析目录，验证它是目录，并向 Git 查询绝对 top level、每个 worktree 的 Git directory、common Git directory、HEAD、分支或 detached 状态、object format 和 remote。它解析 `git worktree list --porcelain -z`，而不是本地化的人类输出，并确认所选 top level 只属于一个已报告 worktree。

Host 使用 `fs.realpath` 规范化 Git 返回的每个已存在文件系统位置。它不会把路径转换为小写，因为 Windows 目录可能启用区分大小写语义。若候选项的规范 worktree root 或规范的每 worktree Git directory 与同一 Host 上的可用绑定相同，它就与该绑定冲突。Common Git directory 只用于对相关 worktree 分组，不会让它们成为同一绑定。

若所选目录位于 Git top level 之下，登记会展示解析后的 top level 并要求确认，而不会静默改变 scope。Saki 为该规范 top level 创建或复用 DSH Workspace，创建一个稳定 Resource Binding id 和 revision，并把已检查的路径与 Git 事实保存为观察结果。每个 Agent Run 和 Host Operation 都记录自己使用的绑定 revision。

### 健康状态与重新验证

绑定状态为 `active`、`missing`、`repair-required`、`needs-rebind` 或 `retired`。获取 Execution Lease 或启动带 mutation 的 Host Operation 前，Host 会重复规范化与 Git 检查。匹配的观察使绑定保持 active。目录缺失会进入 `missing`；路径存在但 worktree 或管理身份不再匹配会进入 `repair-required`；恢复到另一 Host 的 Installation 从 `needs-rebind` 开始。这些状态都不会通过寻找名称相似的路径、分支、remote 或 commit 自动修复。

稳定 Resource Binding id 而非观察到的位置继续作为 Execution Lease 排他键。绑定 revision 变更会使基于旧观察准备的待定准入失效。所有非 active 状态仍可读取历史，但新可写工作不可用。

### Rebind 与退役

`RebindDevelopmentProject` 在所属 Host 上选择已有目录，并在 Host Operator Actor 下记录新旧观察。它要求没有仍可能修改旧位置的活动可写 Agent Run、terminal、未接受 Host Operation 或未解决 dispatch。每 worktree Git directory 完全连续时，可以直接认定为位置迁移。替换 clone、移动的主 worktree、修复后的管理目录或替换 Host 无法通过路径证明身份；Saki 展示 Repository、remote、HEAD lineage、dirty state 和 GitHub binding 证据后，operator 必须明确确认新资源。该确认只改变位置，不改变历史归因。

由于 DSH Workspace 路径和 Session cwd 不可变，位置变化会在新规范路径创建或复用 Workspace，并推进 Project 的 Workspace 引用。现有 DSH Session 仍关联历史 Workspace，并可供读取。继续一个 Saki Work Session 时，会在新位置打开后继 DSH Session，而不是重写旧 Session。

`RetireDevelopmentProject` 阻止新的执行与 mutation，同时保留 Project 身份、Work Session、证据、GitHub 关联和审计记录。它要求与 rebind 相同的执行完全停稳状态，并且不会删除目录、Git worktree、DSH Workspace 登记、Session 日志、分支或远端资源。0.1.0 版本不存在把仍可执行的 Project 与其 worktree 分离的独立操作。

### 已有变更

登记与 rebind 会捕获 staged、unstaged、untracked、branch 和 HEAD 观察。自动模式要求 clean worktree。Dirty worktree 会创建 Intervention Request，且不能由自动化接管。手动 Host Operator 可以提交明确的 takeover Intent，把有界指纹与 diff 摘要记录为既有输入证据；随后 Run 与所有 Changes view 会继续把这些修改标为继承。若 Saki 无法把后续修改与该 baseline 区分开，自动 staging 或 completion 仍不可用。

## 考虑过的方案

**把规范路径作为持久绑定 id。** `fs.realpath` 能在目录存在时防止别名，但无法跨越位置迁移、替换 Host 恢复或重建 clone。生成 id 允许位置观察变化，而无需重新解释历史。

**使用 Repository remote、branch 或 HEAD 作为身份。** Clone 可以共享这三项；branch 与 HEAD 在日常工作期间会变化；detached worktree 没有 branch。这些值可辅助 operator 复核，但不能拥有 lease。

**使用 Git common directory 作为 worktree 身份。** 所有 linked worktree 都共享它，因此并行 worktree 会被折叠成一个绑定。可用时，每 worktree Git directory 可区分它们。

**移动后重写 DSH Workspace 与 Session 路径。** 这些值描述历史执行发生的位置，并参与 DSH 自身成员关系规则。重写会破坏历史含义与跨包所有权。

**让 Saki 在 0.1.0 中管理物理 worktree 创建和删除。** 安全创建、分支选择、dirty 移除、submodule、lock、repair 与删除需要更大的 Git 产品功能。Terminal、PowerShell 7、Git 和 Agent 继续作为 fallback，而 Saki 拥有登记、rebind、退役与执行安全。

**允许自动工作继承 dirty tree。** 后续 commit 可能包含无法可靠归因到 Actor 或 Work Item 的变更。手动 takeover 保留明确决策；自动模式停止。

## 后果

位置迁移是 Project 生命周期操作，而不是路径编辑。UI 必须展示绑定健康状态、观察位置、绑定 revision、Git 事实、继承变更，以及恢复可写执行前所需的操作。它不得把推测出的移动显示为已修复。

Host 测试覆盖盘符大小写别名、分隔符、`..`、symlink、junction、共享一个 common directory 的 linked worktree、detached HEAD、缺失路径、移动的主 worktree 和 linked worktree、Git repair、替换 clone、dirty 登记、重启、陈旧绑定 revision、rebind 完全停稳状态，以及保留的历史 Session。Git 机制遵循官方 [git-worktree](https://git-scm.com/docs/git-worktree) 和 [git-rev-parse](https://git-scm.com/docs/git-rev-parse) 接口。
