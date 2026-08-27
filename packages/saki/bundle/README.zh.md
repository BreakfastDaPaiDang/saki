# `@breakfastdapaidang/saki-bundle`

[English](README.md) | 中文

Saki 私有组合根。它在 [`dsh.bundle`](package.json) 中声明 [`cordis.patch.yml`](cordis.patch.yml)；该补丁挂载默认 JSON 存储后端、由启动器替换为 manifest 所选 `saki_control_plane` generation 的惰性 SQLite 路由、JSONL Session 持久化、Workspace、本地文件系统与子进程提供方、Local Host 执行提供方、回环 Web 服务器、Connection、Saki 控制面、`/saki` Host API、带壳层花名册与 Saki [`web-ui`](../web-ui/README.zh.md) 插件的 DSH 客户端模块系统、为构建产物 web 前端 dist 提供服务的 fallback 座服务器，以及 `saki-readiness`；以上组合建立在空的 [`cordis.yml`](cordis.yml) 上。在 Windows 上，它还挂载当前用户 DPAPI 凭据 Provider 与只读 Saki Product GitHub App Provider；不支持的平台会禁用这两个配置项，而不会把更弱的凭据来源报告成 `local-user-trust`。就绪配置项提供稳定的 `{"product":"saki","status":"ready"}` 记录。启动器只在 `boot()` 完成配置项激活审计后将其写入 stdout；报告失败时，启动器会对应用执行 dispose（资源释放）并进入失败路径。

在仓库根目录运行：

```sh
pnpm run saki
```

该命令通过仓库的 ESM 钩子与路径映射启动 TypeScript 源码。执行 `pnpm run build:lib:host` 后，对应的产物平面命令是 `node packages/saki/bundle/lib/bin.js`。两者解析同一个由包声明的补丁，并持续运行至收到 `SIGINT` 或 `SIGTERM`。`SAKI_ONESHOT=1` 保留供组装冒烟测试与快照使用的“就绪后退出”模式。

启动组合前，启动器会取得 Installation 全局排他 lease、调和精确具名的恢复元数据，并且只通过 `installation.json` 选择状态；没有 manifest 时才使用精确配置的 B03 数据库。无状态 Installation 会直接配置为当前版本。精确 B03 Installation 会以 `upgrade-required` 闭合失败；启动 B18 前需让 B03 Host 保持离线并执行维护升级。启动器在准备、对外服务和完整 teardown（拆卸）期间始终持有 lease；畸形或不受支持的选中状态也会闭合失败。

每次非一次性启动还会写出一行启动器交接 JSON，其中包含 `bootstrapPurpose`、`bootstrapSecret` 与回环基础 `url`。首次完成前用途为 `initial-bootstrap`，此后为 `local-reauthentication`。明文机密值只供立即执行本机登录使用；不得重定向、持久保存或公开这行内容。重启会保留先前尚未过期的挑战并签发新挑战；交换任一状态为 `issued` 的挑战时会消费该挑战，并撤销其余挑战。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `SAKI_DATABASE_PATH` | `dshHomePath('saki', 'control.sqlite')` | 精确的无 manifest B03 源路径；它绝不覆盖 manifest，且拒绝 `:memory:` |
| `SAKI_PORT` | `43119` | 回环 HTTP 端口，必须是 `1` 至 `65535` 的整数 |
| `SAKI_ONESHOT` | 未设置 | 设为 `1` 时打印就绪记录并退出，且不消费 bootstrap 交接值 |

## 模型体验

无。该本地 Host 组合不会发起模型请求，也不贡献模型可见输入。

#### KV Cache 影响

无；该组合不存在请求前缀。

## 已知限制与延后工作

- **只读 GitHub 基础**：操作者安装并配置 Product App 后，Windows 组合可以检查该 App 并发布已确认的 Board 读取结果；GitHub Issue、Project item、Repository 与 Workflow 修改仍不存在。
- **只支持早期 Project 生命周期**：Host 支持本地访问、已有目录检查、Development Project 首次登记、Project index 与 Development Workspace。尚未组合 Resource Binding 重绑定与退役、仓库修改、agent（智能体）与模型提供方。
- **无 agent 栈的浏览器界面**：组合的壳层会渲染 Saki 页面与 Conversation 回退，但缺少 `/api` agent 服务：会话创建不可用，控制台会出现 `/api` 重连噪音。组合 agent 栈属于后续切片。
- **可执行入口仅供仓库本地使用**——Saki 包保持私有，不属于任何 npm 发布族。
- **仅限回环开发 Host**：固定的本地 bootstrap 流程不会授权远程浏览器，也不替代 [Saki Host 启动器](../../../docs/saki/host-launcher.zh.md)所述的 Windows Host 包装层。
