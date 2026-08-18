# `@breakfastdapaidang/saki-control-plane`

[English](README.md) | 中文

Saki 私有控制面模块拥有本地 Installation 基础记录、Installation Access 和第一个受保护 Projection。它注册 `ctx.sakiControlPlane`；调用方使用收窄的 `SakiAccess` 与 `SakiControlPlaneModule` 接口，而不访问存储表。仅供 Host 使用的 `./host` 入口把传输凭据解析为可信的进程内 `SakiAuthenticationContext`，面向浏览器的 `./fixtures` 入口则发布经过脱敏的 B01 状态。

## 持久记录

`saki_control_plane` 存储域包含两条单例记录。`foundation` 保存各自采用独立品牌类型的 Saki Installation、Saki Host、Installation State Generation、人类 Principal 与 Host Operator Grant 身份标识。`installation_access` 是一条版本化聚合记录，包含带修订号的 Bootstrap Challenge 和 Browser Session 条目。每次成功的 bootstrap 交换都会执行一次带预期修订号的记录更新，消费匹配的 Bootstrap Challenge 并插入恰好一个 Browser Session。

只有经过域分离的 bootstrap 哈希摘要与 Cookie 哈希摘要会持久化。原始 bootstrap 机密值、原始 Cookie 凭据、派生请求令牌和独立的请求防伪机密值都不会进入存储。Bootstrap Challenge 与 Browser Session 条目的终态转换保持单调，且只有经过 `terminalRetentionMs` 后才会删除。

## 访问与控制操作

`SakiAccess` 读取封闭的 Access Projection、交换启动器机密值，并登出当前 Browser Session。Bootstrap 与登出只能修改 Installation Access。主模块暴露稳定的 Installation 与 Host 身份标识、受保护的空 Project-index 查询、带稳定不可用回执的空 B01 Intent 映射，以及持久提交后的 Projection 失效通知。

每个受保护操作都会重新解析状态为 active 的 Browser Session，并检查当前 Installation State Generation、Principal 生命周期与 Grant。撤销 Grant 会阻止后续查询，但不会删除 Browser Session；替换 Installation State Generation 或退役 Principal 会使绑定的 Browser Session 失效。普通重启会保留尚未过期且状态为 issued 的 Bootstrap Challenge，以及状态为 active 的 Browser Session。因此，启动器只在新建 Bootstrap Challenge 时输出明文 bootstrap 交接值；若 bootstrap 被中断，先前尚未过期的交接值仍是有效凭据。

## 浏览器会话安全

Bootstrap 交换要求准确匹配配置的 Origin。持久提交成功后，系统只允许通过不透明的一次性 Host 交接发送一条 `HttpOnly; SameSite=Strict; Path=/saki` Cookie 响应头；HTTPS Origin 还会加入 `Secure`。认证会计算浏览器所提供原始 Cookie 的哈希摘要并执行固定时间比较，随后使用带版本且经过域分离的 HMAC，从同一个原始 Cookie 派生请求令牌。此后的每个状态变更请求都要求准确匹配 Origin，并对请求令牌执行固定时间比较。

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| `origin` | 必填 | 不带路径的准确 HTTP(S) 浏览器 Origin |
| `challengeTtlMs` | 15 分钟 | Bootstrap Challenge 生命周期 |
| `sessionTtlMs` | 12 小时 | Browser Session 生命周期 |
| `terminalRetentionMs` | 7 天 | 清理终态记录前的最短保留期 |
| `cookieName` | `saki_session` | 仅供 Host 提取 Cookie 的名称 |

## 模型体验

无。该模块拥有本地访问与产品 Projection，但不注册模型可见输入。

#### KV Cache 影响

无；该模块既不组装也不发送模型提供方请求。

## 已知限制与暂缓事项

- **只支持一个本地 Host Operator**：B01 不包含 GitHub 登录、组织成员关系、多用户、远程 Host 或非回环部署。
- **不存在成功的 Control Intent**：`SakiIntentMap` 为空，提交返回 `intent-unavailable`；第一个 Intent 属于项目登记功能。
- **没有凭据恢复 UI**：未过期的 Bootstrap Challenge 会跨进程重启保留，因此在其过期并由后续启动签发替代值之前，仍须使用原启动器交接值。
