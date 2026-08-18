# `@breakfastdapaidang/saki-bundle`

[English](README.md) | 中文

Saki 私有组合根。它在 [`dsh.bundle`](package.json) 中声明 [`cordis.patch.yml`](cordis.patch.yml)；该补丁在空的 [`cordis.yml`](cordis.yml) 上挂载 SQLite 存储、存储域、回环 Web 服务器、Connection、Saki 控制面、`/saki` Host API 与 `saki-readiness`。就绪配置项提供稳定的 `{"product":"saki","status":"ready"}` 记录。启动器只在 `boot()` 完成配置项激活审计后将其写入 stdout；报告失败时，启动器会对应用执行 dispose（资源释放）并进入失败路径。

在仓库根目录运行：

```sh
pnpm run saki
```

该命令通过仓库的 ESM 钩子与路径映射启动 TypeScript 源码。执行 `pnpm run build:lib:host` 后，对应的产物平面命令是 `node packages/saki/bundle/lib/bin.js`。两者解析同一个由包声明的补丁，并持续运行至收到 `SIGINT` 或 `SIGTERM`。`SAKI_ONESHOT=1` 保留供组装冒烟测试与快照使用的“就绪后退出”模式。

首次启动还会写出一行启动器交接 JSON，其中包含 `bootstrapSecret` 与回环基础 `url`。明文机密值只供立即执行本地 bootstrap 使用；不得重定向、持久保存或公开这行内容。Bootstrap 成功后，后续启动不再输出机密值。若进程在交换前停止，应继续使用先前尚未过期的交接值；普通重启不会撤销其持久 Bootstrap Challenge。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `SAKI_DATABASE_PATH` | `dshHomePath('saki', 'control.sqlite')` | SQLite 控制面数据库；`:memory:` 只适合测试 |
| `SAKI_PORT` | `43119` | 回环 HTTP 端口，必须是 `1` 至 `65535` 的整数 |
| `SAKI_ONESHOT` | 未设置 | 设为 `1` 时打印就绪记录并退出，且不消费 bootstrap 交接值 |

## 模型体验

无。该本地访问组合不会发起模型请求，也不贡献模型可见输入。

#### KV Cache 影响

无；该组合不存在请求前缀。

## 已知限制与延后工作

- **访问是唯一的产品切片**：Host 暴露 bootstrap、登出与已认证的空 Project index；GitHub、Development Project、agent（智能体）、模型提供方与渲染后的 Web 界面通过后续切片加入。
- **可执行入口仅供仓库本地使用**——Saki 包保持私有，不属于任何 npm 发布族。
- **仅限回环开发 Host**：固定的本地 bootstrap 流程不会授权远程浏览器，也不替代 [Saki Host 启动器](../../../docs/saki/host-launcher.md)所述的 Windows Host 包装层。
