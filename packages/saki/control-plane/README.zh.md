# `@breakfastdapaidang/saki-control-plane`

[English](README.md) | 中文

Saki 私有控制面模块拥有本地 Installation 置备流程、Installation Access 和第一个受保护 Projection。它注册 `ctx.sakiControlPlane`；调用方使用收窄的 `SakiAccess` 与 `SakiControlPlaneModule` 接口，而不访问存储表。仅供 Host 使用的 `./host` 入口把传输凭据解析为可信的进程内 `SakiAuthenticationContext`，面向浏览器的 `./fixtures` 入口则发布经过脱敏的 B01 状态。

## 持久记录

版本化的 `control_state` 置备所有者只记录稳定的子记录引用，以及 `provisioning` 或 `ready` 阶段。`installations`、`hosts`、`principals` 与 `grants` 表按品牌类型 id 保留各自带修订号的实体生命周期和历史。每个实体 id 均由类型专属前缀与规范 UUID 文本组成；Installation State Generation id 必须使用 `installation-generation-`，并拒绝另一类存储标识前缀 `storage-generation-*`。Principal 类型采用封闭的 `human | automation` 判别字段。B01 会置备一名人类 Host Operator，并在每次启动时校验所引用 Principal 的类型；无关的自动化 Principal 是合法记录，但 B01 不会创建自动化 Grant。Installation 选择当前 Installation State Generation 与本地 Saki Host，而不覆盖历史实体。首次启动只生成一次全部引用，按固定顺序创建或校验子记录，并在所有子记录持久化后才把所有者标记为 `ready`；重启会从任一中断步骤继续。

`installation_access` 是一条版本化聚合记录，包含带修订号的 Bootstrap Challenge 与 Browser Session 条目。其 id 在所属 Access id 后追加 `:challenge:<ordinal>` 或 `:session:<ordinal>` 与规范十进制序号。只增不减的挑战序号和会话序号生成确定性条目 id，每个校验摘要都绑定其条目 id。每次成功交换都会执行一次带预期修订号的更新：消费选中的挑战、撤销其他状态为 `issued` 的挑战，并插入恰好一个会话。即使详细终态条目已经清理，该聚合仍保留不可变的首次 bootstrap 完成摘要；清理不会降低两类序号的高水位。

只有经过域分离的 bootstrap 哈希摘要与 Cookie 哈希摘要会持久化。原始 bootstrap 机密值、原始 Cookie 凭据、派生请求令牌和独立的请求防伪机密值都不会进入存储。Bootstrap Challenge 与 Browser Session 条目的终态转换保持单调，且只有经过 `terminalRetentionMs` 后才会删除。

## 访问与控制操作

`SakiAccess` 读取封闭的 Access Projection、交换启动器机密值，并登出当前 Browser Session。Bootstrap 与登出只能修改 Installation Access。主模块暴露稳定的 Installation 与 Host 身份标识、受保护的空 Project-index 查询、带稳定不可用回执的空 B01 Intent 映射，以及持久提交后的 Projection 失效通知。一个失效通知 listener 失败时，系统只发出固定且不含凭据的诊断，不会阻止后续 listener 运行；每项注册仍可独立 dispose（资源释放）。

每个受保护操作都会重新解析状态为 `active` 的 Browser Session，并检查当前 Installation State Generation、Principal 生命周期，以及当前 Grant 的修订号与范围。撤销 Grant 会阻止后续查询，但不会删除 Browser Session；替换 Installation State Generation 或退役 Principal 会使绑定的 Browser Session 失效。

每次启动具备权限的启动器都会签发新挑战。首次交换完成前，其用途为 `initial-bootstrap`；此后为 `local-reauthentication`。先前尚未过期且状态为 `issued` 的挑战继续有效，直到一次交换以原子方式消费选中的挑战并撤销其余挑战。首次 bootstrap 完成后不会重新开放；Cookie 过期、登出或 `Set-Cookie` 响应丢失后，操作员使用后续启动器提供的新挑战重新登录。本机重新认证建立新会话时不会撤销其他仍然有效的会话，登出也只撤销当前提交的会话。

## 浏览器会话安全

Bootstrap 交换要求准确匹配配置的回环 Origin。配置只接受主机名通过 Connection 共用回环判定函数的规范 HTTP(S) Origin。持久提交成功后，系统只允许通过不透明的一次性 Host 交接发送一条 `HttpOnly; SameSite=Strict; Path=/saki` Cookie 响应头；HTTPS Origin 还会加入 `Secure`。认证会计算浏览器所提供原始 Cookie 的哈希摘要并执行固定时间比较，随后使用带版本且经过域分离的 HMAC，从同一个原始 Cookie 派生请求令牌。此后的每个状态变更请求都要求准确匹配 Origin，并对请求令牌执行固定时间比较。

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| `origin` | 必填 | 不带路径的准确回环 HTTP(S) 浏览器 Origin |
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
- **只支持启动器恢复**：B01 通过重新启动具备权限的本机启动器恢复访问，不提供只依赖浏览器的凭据恢复流程。
