# @deepseek-ai/dsh-storage-sqlite

[English](README.md) | 中文

[存储中心](../storage/README.zh.md)的 SQLite 后端：以可配置的名称注册（默认为 `sqlite`），通过一个数据库提供 `kv` facet；该数据库由 `node:sqlite` 操作，可以是单个文件，也可以是 `:memory:`。设计与取舍见[领域 KV 存储 Agent Note](../../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.zh.md)。

## 存储模型

物理 schema v2 每行存储一个文档。每个已声明的单元表都有一个无碰撞的 `u2_<单元名-utf8-hex>_<表名-utf8-hex>` STRICT 表，列为 `(key TEXT PRIMARY KEY, value TEXT NOT NULL)`，因此一个 key 只更新一行。数据库编码必须是 UTF-8；逻辑记录 key 以规范 JSON 字符串文本存储，因此包括内嵌 NUL 和孤立代理项在内的每个 JavaScript 字符串都保持互不混淆。读取时先把 key 与 value 的 TEXT 单元格作为原始字节取出，以不允许替换字符的方式解码 UTF-8，然后才校验 key 或解析 JSON；非法编码、非规范 key、隐藏的 NUL 后缀、重复对象成员以及会被 JavaScript 舍入、下溢或上溢的数字 token 都会作为畸形介质拒绝。权威布局分布在 `units(name, version, has_global)`、`unit_tables(unit, table_name)` 和 `unit_globals(unit, value)` 中。Schema SQL、对象类型、名称与所属表名也会从 `sqlite_schema` 作为原始字节读取，并在 token 或清单检查前严格解码；清单只省略精确匹配的隐式主键索引。文件型普通打开会先通过冻结副本验证完整布局及每个已存 key、value 与 global，再在配置 writer 之前对原连接重复验证，因此拒绝畸形介质不会改变其 journal mode 或源字节。返回实时句柄前，打开单元还要求其版本、全局值能力、声明表集合和物理记录表完全匹配。`PRAGMA user_version` 标识物理 schema；普通打开只接受 v2，绝不就地修补或升级现有介质。

每个普通写入原语都是一条预处理语句，写入顺序仍由调用方负责。已经进入执行的语句一旦抛错，其提交结果便无法确定；后端会永久拒绝继续通过该共享连接读写，但关闭仍会释放连接。关闭单元的物化只允许创建，并在一个事务中提交元数据、记录表和初始内容。`COMMIT` 成功会返回 durable 结果；`COMMIT` 失败时，只有 SQLite 仍报告事务活跃才会回滚并拒绝，否则会返回带作用域内 `readBack()` 的 uncertain 结果并中毒共享连接。文件型关闭读取总是把数据库以及任何非空的 `-wal` 和 `-journal` sidecar 冻结到私有临时副本，把每个复制的恢复文件权限规范为 `0o600`，验证复制期间源数据库及所有 sidecar 均未变化，并且只允许 SQLite 在副本中重放 WAL 或恢复 hot rollback journal。即使源介质只读或后端已有温热 writer，这也能保持源文件字节、权限和文件清单不变。全新 `:memory:` 后端的关闭检查会报告缺失而不初始化或打版本戳；共享连接中毒后没有独立读取视图，因此 uncertain 读回会拒绝。只有文件数据库及其 `-wal`、`-shm` 和 `-journal` 路径全都不存在时，数据库才算缺失；任何孤儿 sidecar（包括空条目或非普通条目）都属于畸形介质，普通操作和关闭操作均不会改变它。相对数据库路径会在后端构造时解析，因此之后工作目录的变化无法把普通访问或关闭访问重定向到其他介质。单元名和表名在 DDL 之前进行验证，十六进制物理名称不包含外部 SQL 语法。缺失目录和数据库文件会以仅所有者可访问的权限创建（`0o700`／`0o600`）。

关闭单元 API 还会仅为迁移读取精确的旧物理 v1 B03 布局：介质必须只包含一个单元、没有全局行，并且只包含描述符对应的旧记录表；描述符必须声明 `hasGlobal: false`。普通服务仍拒绝 v1。

## 配置（schemastery）

```ts
interface Config {
  backend?: string // storage registry name; default `sqlite`
  path: string   // SQLite database file path, or ':memory:' for an in-process DB
  journalMode?: 'wal' | 'delete' | 'truncate' | 'persist'   // journal_mode pragma; default 'wal'
}
```

## 模型体验

### 已存领域记录

#### 模型看到的内容

无。该后端不贡献提示词、工具或 schema；它在 `ctx.storage` 后面持久化非会话领域数据（工作区记录、未来的会话伴随元数据），只供主机侧消费方使用。

#### Token 影响

实时请求 token 为零。

#### KV Cache 影响

无：该后端从不触碰实时请求前缀。

## 已知限制与暂缓事项

- **`DatabaseSync` 是同步的**：每次写入都会在单条语句执行期间阻塞事件循环；在领域数据规模下可以接受。
- **没有忙等待或重试策略**：另一个连接持有写事务时，该操作会立即被拒绝；没有多进程写入保护。
- **普通服务只打开物理 v2**：严格的物理 v1 reader 仅用于关闭迁移 lease；任何格式都不会被就地修补或升级。
- **`openDatabase` 重复了会话持久化 SQLite 的打开顺序**：提取到共享介质层的工作暂缓至计划的会话后端迁移（见 Agent Note 的复用审计）。
