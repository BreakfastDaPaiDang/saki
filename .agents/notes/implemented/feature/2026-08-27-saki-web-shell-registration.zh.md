# Agent Note: Saki Web 壳层登记（K1a）

Status: implemented

[English](2026-08-27-saki-web-shell-registration.md) | 中文

## Problem

Saki 0.1.0 需要真实 bundle 提供浏览器产品：完成本地 bootstrap 后，操作者从已有目录登记首个 Development Project，并落到它的 Development Workspace；reload 与 Host 重启后回到同一位置。[projection 驱动的 Web 客户端提案](../../proposed/architecture/2026-08-18-saki-projection-driven-web-client.zh.md)与[前端契约](../../../../docs/saki/architecture/0.1.0-frontend-contract.zh.md)负责产品框架：两个 Saki 页面加入 DSH 壳层而不取而代之。开放问题在于机制——哪些壳层增量承载 Saki 页面、私有 bundle 如何组合客户端栈、浏览器如何跨越挂载时序、reload 与重启。

## Decision

两个通用的、与产品类型无关的壳层增量承载 Saki 页面。`packages/client/ui-layout` 声明 `main.surface`：根作用域 chain slot，渲染在中央列，以内置的 `conversation` 条目作为回退；回退保持挂载，使 conversation 状态在接管后存活。选举货币是纯字符串 token：`ctx.layout.requestSurface(key)` 写入 layout store；在框架挂载前发出的请求缓冲在 `LayoutController` 上，待面板 actions 挂载时冲刷；传入 `null` 则把中央列交还回退。`packages/client/ui-sidebar` 声明 `sidebar.primary.action`：根作用域 list slot，渲染在 New Session 正下方，条目接收列的展开状态。移除所有接管登记即可还原普通 conversation 回退与侧边栏，无残留状态；任何 DSH 包都不 import Saki 类型。

Saki bundle 在 `cordis.patch.yml` 中组合浏览器栈：DSH 客户端服务注入所需的 Typert registry/loader、API gateway 与 commands；客户端模块系统（`modules`、`api-remotes`、`client-runtime`）；壳层花名册（theme、locale、layout、renderer、sidebar、settings、conversation、workspace、official brand）；`saki-web-ui` 插件；以及 `saki-web-runtime` 胶水插件——通过 `dsh-host-frontend-static` 在 webserver fallback 座上提供构建好的 `@deepseek-ai/dsh-web-frontend` dist。动态 client/host runner 链被明确排除：动态插件包不属于 0.1.0 的表面范围。

`@breakfastdapaidang/saki-web-ui` 按提案要求保持单一客户端插件。它拥有持久化在 `saki.navigation` localStorage 键下的导航 store（surface、选中与最近 Project id）；选中 conversation 会话会清除 Saki surface，导航到 surface 的 effect 通过 `requestSurface` 发布 token。Access 门在被选中的 Saki surface 内渲染，交换启动器打印的 bootstrap secret；登记使用键入的目录路径而非浏览对话框，因为登记要求规范路径加服务端证据确认，选择器集成属于后续打磨切片。workspace 视图渲染已确认 projection，并区分 loading、refreshing、stale、not-found、denied、unavailable 与 offline 状态。控制面的持久 Browser Session 能跨越 Host 重启：持有 cookie 的浏览器不经新交换直接回到持久化地址；无 cookie 的浏览器则必须用重启后新签发的 secret 完成 session-required 交换。

按决策明确排除：binding 检测、rebind、退役与历史迁移（[#26](https://github.com/BreakfastDaPaiDang/saki/issues/26)）；Project Settings、自动化策略与 budget（K7）；Conversation 回退 `/api` 背后的 agent 栈（后续切片——回退照常渲染，但会话创建不可用，控制台会出现 `/api` 重连噪音）。

## Alternatives considered

**复用 `shell.overlay` 或合成 Session 承载 Saki 页面。** 提案已否决：overlay chrome 与 Session 作用域状态各有属主，页面导航会继承错误的生命周期。

**按组件标识选举 surface。** 让登记项在激活时自行渲染会把壳层耦合到条目标识。纯字符串 token 使壳层不含产品类型，回退规则也只是一次比较。

**对挂载前的 `requestSurface` 直接报错。** 插件 apply 顺序是正当组装细节，严格的 face 会迫使每个功能插件感知时序。缓冲单个请求既保住调用方意图，也不引入队列契约。

**启用动态插件 runner。** 动态加载链是尚未了结的基础设施，提案要求 Saki 走已发布插件路径；静态组合不依赖它即可交付同样页面。

**登记使用原生目录选择器。** 选择器笔记（[2026-07-27](./2026-07-27-native-workspace-directory-picker.zh.md)）覆盖的是 workspace 选择；登记必须拿规范路径与 Host 检查结果核对，键入输入让该契约保持显式且可测试，选择器之后可以不改 Intent 直接补上。

## Consequences

bundle 通过 `node packages/saki/bundle/lib/bin.js` 启动为可用的浏览器产品；`pnpm run saki` 从源码提供同一界面。产品级证据是 `packages/saki/bundle/tests/web-registration.e2e.ts`：它在随机端口、全新 Installation 上启动构建产物，驱动 Chromium 完成 bootstrap、两次登记、一次必须完成的重复登记、reload 地址还原、持久会话存活的重启，以及无 cookie 的重新认证；每个交互都有上界，服务端停滞会让对应步骤失败而不是挂住。该 e2e 的存在也源于一次教训：早先的手工验证曾把占用固定调试端口的残留进程误判为服务端挂起；harness 规则（随机端口、全新 home、有界等待、强制拆除）把这类伪证据挡在门外。

壳层增量是可累加且通用的，后续 DSH 特性无需了解 Saki 即可复用这两个 slot。在后续切片组合 `/api` 之前，Conversation 回退在无 agent 栈的情况下渲染；重连噪音只出现在控制台，并记录在 bundle README。「工作」页在其 projection seam 落地前，以诚实的不可用占位形式发布。
