---
status: accepted
---

# 分离 Principal 身份、Grant 权限与 Actor 归因

[English](0008-principals-grants-and-actor-attribution.md) | 中文

Saki 用三个不同概念表示安全身份、持久权限和操作归因。Principal 是可以认证并接收权限的持久主体；Grant 是允许某个 Principal 在资源范围内执行具名操作的版本化授权；Actor 是 Saki 接受 Control Intent 时派生的不可变归因快照。认证、外部凭据、Automation Policy 和 Agent 执行状态都不能替代这三个概念中的任何一个。

## 决策原因

0.1.0 只有一个 Host Operator，但同一个开发闭环已经包含多种身份：使用 Web client 的人、Project 自动工作、一次性 Agent Run、未来持久 Agent Identity、GitHub App installation、Git 使用的凭据以及 Commit author。如果把当前操作者视为所有这些身份，历史归因就会依赖临时的单用户部署，后续多用户系统也将被迫重新解释已有记录。

认证回答谁建立了 session，授权回答该身份可以做什么，归因回答谁为某次已接受操作行使了权限。这些事实在不同时间变化。用户可以关联另一种登录方式而不增加访问权限，Grant 可以被撤销而不改写历史操作，自动操作也可以使用外部 App credential，而不假装是该 App 决定了工作。

Automation Policy 的职责也不同于 Grant。Grant 建立安全上限：允许的操作、资源范围、有效期和委派范围；Automation Policy 决定何时具备工作资格、适用哪些预算与证据，以及何时必须暂停。两者都满足后才能执行，可防止 Project 配置、Signal 或模型输出自行创造权限。

Actor 必须在可信控制面内构造。接受调用方提供的 Actor，或从浏览器 payload、Session lineage、Agent object、GitHub 组织成员身份或凭据持有情况推断权限，会把来源信息变成授权依据，使非升权无法执行。

第一个本地认证 transport 必须确定哪个 Principal 正在使用 loopback Web client，但不能成为另一套权限系统。一次性 launcher secret 后接由服务端拥有的 Browser Session，可以证明持有本地 bootstrap、避免把持久 bearer 材料放入浏览器存储、支持撤销与重启，并且不依赖外部 identity provider。它适合一个本地 Host Operator，但明确不声称可以认证远程用户或多个用户。

## 考虑过的方案

**用一个用户或账号记录同时表示身份、权限和归因。** 这适合第一个 Host Operator，却无法表示自动工作、委派、关联身份、外部执行凭据，或权限后来被撤销的历史操作。

**把 Automation Policy 作为授权记录。** Policy 可以决定何时行动，但允许它自行产生权限，会使编辑触发条件等同于授予 Host 或 Project 访问。Policy 必须在 Principal 已获权限内运行。

**为每个 Agent Run 创建新 Principal。** 一次性 Run 没有独立的持续身份，这会制造大量无意义安全记录。一次性 Run 应使用受限委派 Grant，并出现在 Actor 链中；持久 Agent Identity 才可以由 Principal 支撑。

**根据 GitHub 组织成员身份直接授予访问。** 成员身份是有用的身份事实，也可为管理 policy 提供输入，但它不表达对本地 Host、私有 Project、模型账号或执行预算的访问。关联 GitHub identity 因而只认证 Principal，不直接产生 Host authority。

**信任 client 或 adapter 提供的 Actor。** 浏览器、Agent、webhook 或外部 adapter 将可以冒充其他身份或省略委派链。控制面必须根据已认证上下文和当前 Grant 派生 Actor。

**要求使用 GitHub OAuth 建立第一个本地 session。** 这会让本地管理与恢复依赖网络和外部身份，并促使系统把 GitHub membership 误当成 Host authority。GitHub 登录继续作为后续 identity link，而不是初始 Host Operator Grant 的来源。

**保存本地密码或持久浏览器 bearer token。** 密码会为单个机器本地操作者增加持久 verifier、重置路径与 credential 管理界面。浏览器存储中的 bearer 可以被 client script 访问，也容易被复制到 log 或 export。短期 bootstrap secret 与可撤销 HttpOnly session 避免这些义务，并为后续认证保留明确升级边界。

**在 0.1.0 构建完整角色层级或通用 policy language。** 第一版需要有范围、可版本化的 Grant 和显式委派，不需要第二套通用 IAM 产品。具名角色以后可以展示或配置 Grant 集合，但不会成为另一套权限引擎。

## 影响

Principal 是稳定的 Saki 安全主体。初始 Principal 形式包括人类、持久 Agent Identity，以及每个启用自动模式的 Project 所拥有的一个 Project Automation Principal。Host identity 仍是独立的机器认证；外部提供方账号或 GitHub App installation 仍是凭据身份，不是产品决策者。

Grant 记录签发者、目标 Principal、允许操作、资源范围、有效期、委派限制、委派时的父 Grant、revision 和撤销状态。委派只能缩小父 Grant。Host Operator 等角色是面向产品的 Grant 配置方式，不是平行授权系统。

控制面接受 Control Intent 时派生 Actor。Actor 记录 effective Principal、最初发起者、委派链、Grant identifier 与 revision、认证上下文，以及适用的 Automation Policy 或 Agent Run reference。Client 可以请求操作，但不能提供可信 Actor 或 Grant 字段。后续重新关联身份或撤销 Grant 都不会改变历史 Actor 数据。

撤销 Grant 会阻止新 Intent、新委派，以及任何需要该权限但尚未开始的外部副作用。它不会阻止为保障已经可能发生的外部副作用安全所需的检查、取消、对账或补偿。活动 Execution 在 capability 边界检查撤销，而不把准入时快照当作永久权限。

Signal 携带来源但不携带权限。Project Automation Principal 必须同时拥有显式 Grant 且满足 Automation Policy，才能提交 Intent。一次性 Agent Run 只接收其发起 Principal 权限的委派子集，不能为自己或子 Agent 扩权。持久 Agent Identity 可以接收自己的 Grant，但其模型输出不能直接修改 Grant。

0.1.0 持久化一个独立于 Principal 和 Grant 的 Installation Access aggregate。它包含不同的 branded、revisioned Bootstrap Challenge 与 Browser Session entry。一次 expected-revision record update 验证活动 Installation State Generation 中的 `issued` challenge，并原子记录其终态 `consumed` 状态与恰好一个 `active` Browser Session；transport 只能在该 commit 后发出 `Set-Cookie`。响应丢失不能证明 cookie 已送达，不会重新打开 challenge，也不会创建另一个 session。已 commit 的 session 继续遵守普通 expiry 或 revocation。

Challenge 与 session 终态按服务端时钟保持单调。重启只 reconcile 已经过记录 expiry 的 entry，不会缩短 active session。Installation generation 替换与 Principal 退役会使受影响 session 失效，安全保留期后的 cleanup 绝不让 id、digest 或 secret 可复用。启动 handoff 只传递一次明文 bootstrap secret，准确的 exchange POST body 是它唯一的 wire 位置。除这两个位置外，明文 secret 绝不进入持久存储、URL、analytics、log、diagnostic、trace、event、receipt、snapshot、wire payload、Projection、error text、crash artifact、adapter error 或 Installation Export；failure response 不会暴露 challenge 是未知、过期、已消费、已撤销，还是绑定到其他 generation 或 Principal。

Browser Session entry 保存不透明 cookie-token digest、已认证 Principal、Installation State Generation、过期时间、非秘密 request-token derivation version 与 domain metadata，以及撤销状态。Raw cookie 只存在于 scope 为 application、使用 HttpOnly 和 SameSite=Strict，并且在使用 TLS 时标记 Secure 的 cookie 中。对于每个已认证请求，服务端 hash 所呈现的 raw cookie，并与已存 digest 做 constant-time compare，再使用版本化加密 HMAC 或 KDF，通过 domain separation 从同一个 cookie 派生 request token。已认证 Access 返回派生 token；改变状态的请求要求准确配置的 Origin，并把 header 与新派生值做 constant-time compare；bootstrap 要求准确 Origin，但没有预先建立的 session token。Raw cookie 在 wire 上只能出现于 `Set-Cookie` 与 Cookie header，request token 只能出现于已认证 Access 和请求防伪 header；两者都不持久化，也绝不进入 receipt、snapshot、无关 wire payload、URL、analytics、log、diagnostic、trace、event、无关 Projection、error text、crash artifact、adapter error 或 Installation Export。系统不存在独立 verifier secret；稳定非秘密 derivation metadata 允许重启后重新计算。

Session 只认证 Principal，不授予任何操作。`SakiAccess` 拥有未认证 Access、bootstrap exchange 与 logout；exchange 与 logout 是仅有的两个不经过 Control Intent 的产品 mutation，并且只能修改 Installation Access aggregate。每次受保护 Projection query 与 Intent submission 都先由 transport 验证 active session 与 Installation generation，再由控制面验证 Principal lifecycle 以及当前 Grant revision 与 resource scope。控制面为每个已接受 Control Intent 派生 Actor，拒绝不可信 Principal、认证上下文、Actor、Browser Session 或 Grant 权限字段，并在 Principal 或 Grant state 变化时使受影响 Projection 失效。认证前，Access 只暴露所需本地操作与通用重试说明。非 loopback identity、TLS termination 和多用户 session 管理不在该版本范围内。

后续 GitHub 登录把外部身份关联到 human Principal。管理员配置 Grant 时可以评估 GitHub 组织成员身份，但登录本身不授予 Host、Project、模型账号或文件系统权限。外部 mutation 的审计同时保留选择该操作的 Saki Actor，以及实际执行操作的外部 App 或用户凭据。
