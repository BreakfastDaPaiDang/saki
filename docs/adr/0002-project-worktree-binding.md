# Development Project 绑定一个 Git worktree

状态：已接受（2026-10-12，合并 `master` 上的 ADR 0003 与 0014）

每个 Development Project 通过一个 Resource Binding 绑定一个 Git worktree。同一仓库的多个 worktree 可以登记为不同 Project。多个 DSH Session 可以共用同一 Project 和 worktree。

## 决定

- **身份是生成的 id。** 路径、分支、remote 和 HEAD 都会变化或在 clone 之间重复，只作为观察结果和人工复核的证据，不作为绑定身份。
- **登记时规范化路径。** 用 `realpath` 解析目录，登记到 Git top level；同一 worktree 的不同拼写不会登记成两个 Project。
- **不自动修复。** 目录丢失或 Git 身份不再匹配时，绑定进入不可写状态，等人确认新位置后 rebind，不靠名字、分支或 remote 相似去猜。
- **不改写历史。** DSH Workspace 路径和 Session 的 cwd 不可变。位置迁移后在新路径创建 Workspace，旧 Session 保留在旧 Workspace 下可读。
- **不独占 worktree。** 不为运行中的 Agent 加锁；需要隔离时由人选择另一个 worktree。并行 Session 可能编辑同一文件并产生冲突，这是接受的代价。
- **Saki 不创建或删除 worktree。** 这些操作交给 git、终端和 Agent。

## 后果

迁移是 Project 的生命周期操作，不是改一个路径字段。绑定的健康状态需要在界面上可见。
