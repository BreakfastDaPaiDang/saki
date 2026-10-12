# 待办

工作项的权威来源（GitHub Issue 还是 Saki 自己）定下来之前，先记在这里。按优先级排列。

## 1. 远程页面可写设置

**问题**：DSH 0.2.0-rc.2 只在页面主机名是 loopback 时持久化设置。通过 `saki.dapaidang.org` 打开时，设置页显示 "settings are unavailable in this browser"，只能经 SSH 隧道从 `localhost:3080` 修改。

**依据**：

- `dsh-client-ui-settings` README 的已知限制："Non-loopback pages get no durable settings"。
- `dsh-client-connection` 用 `isLoopbackHostname(pageLocation.hostname)` 计算 `isLoopback`，设置客户端据此关闭 Host 持久化。
- 服务端没有按方法区分 loopback：所有 RPC 只校验 browser session cookie，`trustedHosts` 已经负责 Host/Origin 信任。所以限制只在客户端。

**目标**：写一个 Saki 插件，让 `trustedHosts` 中登记过的主机名也能持久化设置；非信任主机保持原行为。不修改 DSH 包本身。

**验收**：经 `saki.dapaidang.org` 打开设置 → 模型，能保存并在刷新后保留；未登记的主机名仍然只读。
