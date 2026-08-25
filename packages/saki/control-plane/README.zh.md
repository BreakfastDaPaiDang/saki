# `@breakfastdapaidang/saki-control-plane`

[English](README.md) | 中文

Saki 私有控制面模块拥有本地 Installation 置备、Installation Access、Development Project Registry，以及可恢复的项目登记 Intent。它要求维护层先发布固定且已经验证的 `ctx.sakiInstallationState`，其中包含活跃 Installation 与 storage generation 标识，再注册 `ctx.sakiControlPlane`；调用方使用收窄的 `SakiAccess` 与 `SakiControlPlaneModule` 接口，而不访问存储表。仅供 Host 使用的 `./host` 入口把传输凭据解析为可信的进程内 `SakiAuthenticationContext`，面向浏览器的 `./fixtures` 入口则发布经过脱敏的访问、检查、登记、Project-index 与 Development-Workspace 状态。

## 持久记录

版本化的 `control_state` 置备所有者只记录稳定的子记录引用，以及 `provisioning` 或 `ready` 阶段。其 Installation id 必须与维护层验证的活跃 Installation 相同；被中断的置备恢复前也会执行这项校验。`installations`、`hosts`、`principals` 与 `grants` 表按品牌类型 id 保留各自带修订号的实体生命周期和历史。每个当前标识均由类型专属前缀与规范 UUID 文本组成；物理 storage generation 使用 `storage-generation-`。只有精确的 v2 迁移输入会保留历史 `installation-generation-` 字段。Principal 类型采用封闭的 `human | automation` 判别字段。置备流程会创建一名人类 Host Operator，并在每次启动时校验所引用 Principal 的类型；无关的自动化 Principal 是合法记录，但置备流程不会创建自动化 Grant。Installation 只选择当前本地 Saki Host，不拥有 storage generation 的选择权。启动时会先以纯读取方式校验全部置备、访问、Project、Binding 与 Intent 记录；只有完整库存均有效，系统才会协调或恢复任何状态。

`installation_access` 是一条版本化聚合记录，包含带修订号的 Bootstrap Challenge 与 Browser Session 条目。其 id 在所属 Access id 后追加 `:challenge:<ordinal>` 或 `:session:<ordinal>` 与规范十进制序号。只增不减的挑战序号和会话序号生成确定性条目 id，每个校验摘要都绑定其条目 id。每次成功交换都会执行一次带预期修订号的更新：消费选中的挑战、撤销其他状态为 `issued` 的挑战，并插入恰好一个会话。即使详细终态条目已经清理，该聚合仍保留不可变的首次 bootstrap 完成摘要；清理不会降低两类序号的高水位。

`development_project_registry` 是一条带修订号的聚合记录，包含 Project、Resource Binding、按所属 Host 划分的规范工作树与逐工作树 Git 目录索引，以及已提交的 Intent 映射。`registration_intents` 保留不可变的浏览器确认内容、接受时 Actor 归因、完整登记检查、与阶段对应的 Workspace 证据，以及确定性的回执身份。登记按 Intent id 串行执行，在 dispatch 前持久化 `prepared`，在 Registry 比较并交换前记录可能已发生的 Workspace effect，并能识别先于 Intent 阶段推进而提交的映射。同一 payload 的重放会收敛到同一回执；同一 Host 上的 payload 变化或路径身份重复会产生冲突，且不会复用该回执。不同 Host 上相同的规范路径文本不代表同一资源。

每次被接受的检查都包含面向浏览器的安全 Git 事实和继承变更 baseline；其中明文路径与文件内容会替换为精确摘要和有界元数据。采集时间与耗时仍作为证据保留，但不会造成 baseline 身份漂移。每次执行 Workspace 列举、创建或恢复前，控制面都会把保留的规范 worktree 路径作为不可信 locator 交给新的 Host 检查，并比较所需的 Git、规范路径、Git 管理目录文件系统对象与 Workspace 证据。因此，在同一路径替换 clone 或 Git 管理目录会使 Binding 进入 `repair-required`；先前保留的 Projection 或可信路径观察本身绝不授权后续 effect。

只有经过域分离的 bootstrap 哈希摘要与 Cookie 哈希摘要会持久化。原始 bootstrap 机密值、原始 Cookie 凭据、派生请求令牌和独立的请求防伪机密值都不会进入存储。Bootstrap Challenge 与 Browser Session 条目的终态转换保持单调，且只有经过 `terminalRetentionMs` 后才会删除。

## 访问与控制操作

`SakiAccess` 读取封闭的 Access Projection、交换启动器机密值，并登出当前 Browser Session。Bootstrap 与登出只能修改 Installation Access。主模块暴露稳定的 Installation 与 Host 身份标识；只读的项目选择检查、Project-index 与 Development-Workspace 查询；持久化的 `register-development-project` Intent；以及提交后的 Projection 失效通知。仅写入 Intent 阶段不会使 Project 视图失效；Registry 提交会让索引与详情视图各失效一次。一个失效通知 listener 失败时，系统只发出固定且不含凭据的诊断，不会阻止后续 listener 运行；每项注册仍可独立 dispose（资源释放）。

每个受保护操作都会重新解析状态为 `active` 的 Browser Session，并检查其 storage generation id 是否等于 `ctx.sakiInstallationState.storageGenerationId`，同时检查 Principal 生命周期，以及当前 Grant 的 action 与 scope。保留的登记 Actor 可以为历史归因引用更早的合法 storage generation，但只有维护层选择的活跃 storage generation 拥有当前权限。Intent 接受时保留的 Actor 修订号是不可变归因，而不是授权快照：Principal 或 Grant 的良性修订变化不会阻止恢复；退役、storage generation 替换、scope 收窄或撤销会阻止尚未开始的 effect。一旦 Workspace dispatch 可能已经完成，恢复流程可以接纳其精确的持久 Workspace 身份，而不会启动第二次 effect。

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

- **只支持一个本地 Host Operator**：尚未实现 GitHub 登录、组织成员关系、多用户、远程 Host 或非回环部署。
- **只支持登记**：尚未实现 Resource Binding 重绑定与退役、Execution Lease、后继 Session、仓库自动变更和人工接管。预期 revision CAS 的失败方会保留已创建或接纳的可复用 DSH Workspace，而不创建 Saki Project 或 Resource Binding；控制面不会删除本次登记可能并非独占的 Workspace。
- **只支持启动器恢复**：本地访问恢复需要重新启动具备权限的启动器，不提供只依赖浏览器的凭据恢复流程。
