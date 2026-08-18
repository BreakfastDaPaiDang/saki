# `@breakfastdapaidang/saki-bundle`

[English](README.md) | 中文

私有 Saki 组合根。它在 [`dsh.bundle`](package.json) 中声明 [`cordis.patch.yml`](cordis.patch.yml)，该 patch 在空的 [`cordis.yml`](cordis.yml) 上插入唯一的 `saki-readiness` 启动配置项。该配置项提供稳定的 `{"product":"saki","status":"ready"}` 记录。启动器只在 `boot()` 完成配置项激活审计后将其写入 stdout 并请求正常退出；报告失败时，启动器会对应用执行 dispose（资源释放）并进入失败路径。

在仓库根目录运行：

```sh
pnpm run saki
```

该命令通过仓库的 ESM 钩子与路径映射启动 TypeScript 源码。执行 `pnpm run build:lib:host` 后，对应的产物平面命令是 `node packages/saki/bundle/lib/bin.js`。两者解析同一个由包声明的 patch。它们都不会读取凭据、启动服务器、调用模型，也不会替代 [Saki 宿主启动器](../../../docs/saki/host-launcher.md)所述的 Windows 宿主包装层。

## 模型体验

无，因为空组合不会发起模型请求，也不贡献模型可见输入。

#### KV Cache 影响

无；空组合不存在请求前缀。

## 已知限制与延后工作

- **就绪是唯一的产品行为**——持久化、身份、GitHub、agent（智能体）、模型提供方与 Web 界面通过后续可独立验证的切片加入。
- **可执行入口仅供仓库本地使用**——Saki 包保持私有，不属于任何 npm 发布族。
- **就绪流程会主动退出**——只有后续界面替换或扩展该空组合时，Saki 才进入长生命周期进程。
