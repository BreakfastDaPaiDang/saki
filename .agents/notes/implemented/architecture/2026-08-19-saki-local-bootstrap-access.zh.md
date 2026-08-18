# Agent Note: 基于 Connection 的 Saki 本地 bootstrap 访问

Status: implemented

[English](2026-08-19-saki-local-bootstrap-access.md) | 中文

## 问题

Saki 需要在 Development Project 与 GitHub 身份尚不存在时建立第一个已认证 Host Operator。这种访问必须跨普通进程重启保持有效、核验当前 Principal 与 Grant 权限，并确保持久记录不含可复用的原始认证材料。浏览器还需要严格的类型化操作，但不能把 Typert Remote 变成认证框架，也不能在 Connection 旁边再建立第二个 HTTP 载体。

## 决定

**把本地访问收进一个深控制面模块，并让实体独立拥有自身状态。** `@breakfastdapaidang/saki-control-plane` 使用版本化的 `control_state` 置备所有者，在写入任何子记录前先记录稳定引用。采用品牌类型的 Saki Installation、Saki Host、Principal 与 Grant 记录位于按 id 索引的表中，各自拥有独立修订号与生命周期；每个 id 都由类型专属前缀与规范 UUID 文本组成。Installation State Generation 使用 `installation-generation-`，并拒绝另一类存储标识前缀 `storage-generation-*`。Principal 类型采用封闭的 `human | automation` 判别字段。B01 会置备一名人类 Host Operator，并在启动时校验所引用 Principal 的类型；无关的自动化 Principal 是合法记录，但 B01 不会创建自动化 Grant。Installation 选择当前 Installation State Generation 与本地 Saki Host，而不覆盖历史。置备流程按固定顺序创建或校验子记录，只有所有子记录持久化后才把所有者从 `provisioning` 改为 `ready`，因此每个已提交的中断点都能恢复，且不会重新生成引用。其公开 `SakiAccess` 接口负责 bootstrap 与登出；`SakiControlPlaneModule` 接口负责受保护的 Projection 查询、Control Intent 提交与失效通知。一个失效通知 listener 失败时，系统会发出固定且不含凭据的诊断，后续 listener 仍会运行；每项 listener 注册都可独立 dispose（资源释放）。存储表与认证解析器不会进入浏览器入口点。

**用一条版本化 Installation Access 聚合记录更新安全生命周期并支持本机恢复。** Bootstrap Challenge 与 Browser Session 条目各自采用独立品牌类型并带修订号，且位于同一条按 id 索引的记录内。其 id 在所属 Access id 后追加带类型的子段与规范十进制序号。只增不减的序号分配确定性 id，校验摘要绑定这些 id，清理不会降低任何高水位。一次带预期修订号的更新会验证状态为 `issued` 的 Bootstrap Challenge、记录终态 `consumed`、撤销其他状态为 `issued` 的挑战，并插入恰好一个状态为 `active` 的 Browser Session；只有完成该持久提交后，`Set-Cookie` 才可用。第一次成功交换还会写入不可变的完成摘要；详细条目清理后，该摘要仍然保留。并发交换与重放都返回同一种通用不可用结果。响应丢失不会回退已完成的持久提交。服务端时钟判定的过期、登出、Principal 退役和 Installation State Generation 替换只会产生单调终态；清理操作仅在配置的保留期后删除终态条目。

**区分首次完成与可重复的本机重新认证。** 每次启动具备权限的启动器都会签发并显示新挑战，同时保留先前尚未过期且状态为 `issued` 的挑战。不可变完成记录出现前，用途为 `initial-bootstrap`；此后用途为 `local-reauthentication`，但两者使用同一个严格交换操作。Cookie 过期、登出或 `Set-Cookie` 响应丢失后，通过后续启动器提供的挑战恢复，而不会重新开放或重放已消费的首次挑战。重新认证不会撤销其他仍然有效的会话，登出也只撤销当前提交的会话。

**先认证 Principal，再重新评估权限。** Browser Session 绑定 Principal 与 Installation State Generation，但不携带 Grant。每次受保护查询与提交都会重新解析当前 Browser Session、检查当前 Principal 生命周期，并读取当前 Grant 状态与范围。撤销 Grant 会立即拒绝后续受保护工作，但不删除 Browser Session。B01 只发布空 Project-index Projection；可通过声明合并扩展的 `SakiIntentMap` 没有成员，`control/submit` 在认证后始终返回稳定的不可用回执。项目登记功能拥有第一个成功 Intent。

**通过一个由 Saki 拥有的 Connection 通道传输认证。** `@breakfastdapaidang/saki-host-api` 注册 `/saki`，并拥有 `access/read`、`access/exchange`、`access/logout`、`control/query` 与 `control/submit` 的严格 schema。它在分派或解码前拒绝非空 URL 查询参数，从 Connection 的可信元数据读取 Cookie、Origin 与请求令牌请求头，使用仅供 Host 调用的认证解析器，并在 JSON 之外发送持久提交后不透明的 Cookie 响应头。通道注册要求处理方运行前与运行后的每条路径，以及成功、拒绝和错误响应，都携带 `Cache-Control: no-store`，并用一条固定且不透明的错误替换全部传输或 RPC 故障，因此解析器、请求、异常和内部哨兵细节都不会越过载体。浏览器侧使用同源凭据。Connection 增加通用请求元数据、必需响应头与处理方响应头、可选不透明错误策略，以及客户端调用选项；Typert 只机械适配该通用回复类型，不拥有任何 Saki 认证规则。

**把每种明文认证材料限制在一个具名载体内。** Bootstrap 机密值只存在于启动器交接和指定的交换请求体中。原始 Browser Session 凭据只存在于 `Set-Cookie`、Cookie 与浏览器 HttpOnly Cookie jar 中。配置的 Origin 必须是主机名通过 Connection 共用判定函数的一项准确 HTTP(S) 回环 Origin。已认证 Access 包含由同一个原始 Cookie 通过带版本且经过域分离的 HMAC 派生的请求令牌；状态变更请求要求准确匹配该 Origin，并对令牌执行固定时间比较。持久 Installation Access 只包含经过域分离的 bootstrap 哈希摘要、Cookie 哈希摘要与非秘密派生元数据。业务结果、Projection、错误、fixture（测试前置数据）、事件与快照都不包含原始机密值或 Cookie 凭据。

## 后果

`pnpm run saki` 会启动带 SQLite 持久化的长生命周期回环 Host，并在每次非一次性启动时输出一条启动器交接值。输出会标明挑战用途，并包含唯一一份明文机密值。若进程在交换前停止，原始且尚未过期的交接值与下次启动产生的新交接值都会保持有效，直到一次交换消费选中的挑战并撤销其余挑战。首次 bootstrap 持久提交后，已有 HttpOnly Cookie 能在重启后认证同一个 Principal；若该 Cookie 丢失，仍可使用新的本机重新认证交接值。

该 API 有意只服务一个本地 Host Operator。GitHub OAuth、多用户、远程 Saki Host、非回环部署、只依赖浏览器的恢复 UI 与成功的产品状态变更都是独立决策。源码与构建后组合包的快照通过真实 `/saki` HTTP 传输运行，在不记录任何明文机密值的前提下校验首次启动与重新认证的启动器用途，使用同一个 SQLite 数据库重启，并以原 Cookie 查询空 Project index。

## 已考虑的替代方案

- **把认证放进 Typert Remote**：会把单一产品的 Cookie 与 Grant 语义耦合到通用生成式 RPC 注册表，而且仍需 HTTP 元数据旁路。
- **在 Connection 旁边添加原始 Saki HTTP 路由**：会重复路由信任校验、JSON 限制、请求关联、取消与资源释放，并产生两个竞争的 Host 载体。
- **持久化浏览器持有者凭据、本地密码校验值或独立请求防伪机密值**：会增加可复用机密值的存储与恢复生命周期，而浏览器提供的高熵 Cookie 已足以认证 Browser Session 并派生其请求令牌。
- **把 Bootstrap Challenge 与 Browser Session 保存为独立记录**：无法用存储域的一条记录比较并设置保证同时完成消费与创建。
- **在 Browser Session 中缓存 Grant 权限**：会让旧 Browser Session 在 Grant 撤销或收窄后继续保留权限。
- **虚构一个空操作 B01 Control Intent**：会在任何真实产品动作出现前，使成功状态变更协议看似已经稳定。
