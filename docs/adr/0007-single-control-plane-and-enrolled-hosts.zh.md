---
status: accepted
---

# 采用一个活动 Saki Installation 与登记 Host

[English](0007-single-control-plane-and-enrolled-hosts.md) | 中文

Saki Installation 是一个活动控制面的稳定、可迁移身份与产品命名空间。一个 Installation 可以登记多个 Saki Host，但 0.1.0 只支持一个活动控制面写入者和一个同进程的 Local Host。共置是一种部署选择，不表示身份合并：Installation 与 Host 分别保留稳定标识、记录和职责。

## 决策原因

Saki 从一台 Windows 机器起步，但 Project 状态必须能在换机后继续使用，并在未来把工作派发到远程机器或服务器。如果把当前进程、文件系统根目录、设备和产品身份视为同一对象，本地路径与凭据就会渗入控制面记录。此时迁移会变成复制一个仍在活动的系统，而增加远程执行器会迫使每项 Project 与授权规则理解传输细节。

控制面与执行面的信任职责也不同。控制面拥有产品 policy、指派、恢复和持久 Projection；Host 拥有机器本地的 capability Provider、资源、活动进程和原始凭据解析。浏览器 client、GitHub 用户、组织成员、仓库内容、模型输出和外部事件 payload 不会仅因能够访问任一平面就自动成为可信主体。

Cordis 生命周期管理可以回滚通过其上下文产生的 effect，但它不是 Host 进程内代码的沙箱。已安装的 Cordis 或 npm plugin 可以使用该 Host 进程与操作系统提供的权限。因此，模型动态生成的 plugin 在经过明确的操作者审查与安装步骤前，不能从一次性执行材料提升为持久 Host plugin。

活动—活动控制面需要分布式主节点选举、fencing、持久 lease、冲突解决和外部副作用协调，而 Saki 目前还没有第二个部署目标。这些机制无法改善第一个本地开发闭环。单一活动写入者现在提供确定的所有权，同时让 Installation 身份独立于当前运行它的机器。

## 考虑过的方案

**把当前机器或进程作为 Saki 身份。** 初期最简单，但会让备份恢复、换机和远程执行变得含糊，并诱使 Host 路径与凭据泄漏到可迁移记录中。

**运行多个活动控制面副本。** 只有 Saki 拥有分布式 fencing 与一致性机制后，这才能改善可用性。缺少这些机制时，两个副本可能同时领取一个 worktree、重复外部 mutation，或让 policy 状态分叉。

**把每个浏览器或用户设备当作 Host。** client 可以请求和观察工作，但不会因此拥有已登记执行环境、capability inventory 或凭据边界。混淆两者会让 UI 可达性变成资源权限。

**把 plugin 当作隔离扩展。** Cordis 约束生命周期和依赖访问，但不能阻止同进程任意代码调用 Node 或操作系统 API。把已安装 plugin 描述为不可信，会承诺一个并不存在的安全边界。

**立即把两个平面拆成网络服务。** 在第二个 Host 出现前，这会提前引入登记传输、认证、投递和局部网络故障。稳定身份与 Host Execution seam 已保留未来选项，无需过早增加部署复杂度。

## 影响

控制面持久化稳定 Installation identity 和 Host registry。每个 Host 拥有稳定 Host id、登记与信任状态，以及可重新验证的 capability inventory。Resource Binding 和 Host operation 标识其所属 Host，不把隐式本机或绝对路径当作全局身份。

原始 secret 保留在 Host 上的 capability Provider 内。控制面可以持久化不透明 credential reference、capability 与 health 状态、带来源的 usage 和 routing 决策，但不保存 secret value。因此，迁移 Installation 需要明确的 backup、restore 与 Host 重新登记流程；复制数据目录不会让两个活动写入者自动成为受支持模式。

可迁移路径是 [ADR 0012](0012-forward-migrations-and-installation-maintenance.zh.md) 定义的加密 Installation Export，而不是活动数据目录副本。替换 restore 保留 Installation id、创建新 Host id，并要求在自动工作恢复前完成资源重新绑定、凭据重新授权、未解决 operation 对账与旧 Host 退役。

0.1.0 默认把 Web surface 绑定到 loopback，并引导一个本地 Host Operator。仅增加 GitHub 登录或开放端口不会获得多用户安全性。Principal identity、grant、浏览器 session 安全和主动启用非 loopback 部署仍是独立决策。

已安装的 Host plugin 是有特权的可信代码。模型动态生成的 plugin 保持为一次性执行材料，除非操作者通过常规安装路径审查并提升它。仓库内容、模型输出、浏览器 payload 和外部事件即使由可信 plugin 处理，也仍是不可信输入。

初始 Installation、控制面与 Local Host 仍可运行在同一进程和同一个 plugin composition 中。该决定建立的是逻辑所有权与持久身份，不是微服务。未来远程节点通过经过认证的 Host Execution Provider 加入为已登记 Host；活动—活动控制面需要新的 ADR。
