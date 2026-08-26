# Agent Note: 回调作用域的关闭领域迁移

Status: implemented

[English](2026-08-25-callback-scoped-closed-domain-migration.md) | 中文

## 问题

`storageDomain` 过去只能打开严格匹配当前 `DomainSpec` 的 unit。这适合提供服务，却不能安全演进权威历史 unit：普通打开可能创建当前状态、会保留实时句柄，而且无法在不暴露后端专属布局的情况下发布到另一个缺失候选。直接读取后端会让产品包依赖 JSON 文件或 SQLite 表，原地迁移则会在产品不变量和权威发布成功前危及唯一已知良好的源。

通用机制还需要明确区分提交。目标发布前的取消或校验失败必须不留下完整目标。发布一旦提交，读回失败就表示候选已经存在，维护流程必须清理它；把两种情况报告成同一种失败会使恢复含糊不清。

## 决策

可选的 `KvFacet.closed` 操作组拥有回调作用域、快速失败的 unit 名称预留。`withReservedUnit(name, signal, callback)` 在调用回调前登记预留以及供后端关闭等待的完成信号。实时、正在打开或已被预留的 unit 会以 `unit-open` 拒绝；它绝不等待另一项预留。作用域一旦观察到回调以任一结果结束，就会停止向 lease 接纳新方法，因此逃逸出去的 lease 和 commit token 都以 `closed` 拒绝。名称预留只会在此前已经接纳的每个 lease 方法都排空后释放，包括回调未等待的方法；后端关闭会等待回调及相同的已接纳工作。

Lease 可以非变更性地检查已存储身份、通过严格描述符读取分离快照，或者以仅创建方式物化一个完整缺失 unit。物化会在发布之前观察调用方 signal，并返回 `KvClosedUnitMaterialization`：`durable` 结果带有精确的已提交 `readBack()`；`uncertain` 结果带有提交失败，并提供一个 `readBack()`，它会返回可见快照，或者在确认缺失后返回 `undefined`。只有后端能够证明没有发布时才会拒绝；这种拒绝不得留下会被检查识别为完整的 unit。读回仍局限于预留作用域，并忽略之后到达的取消。

普通写入会区分已知发布但持久性不确定（`durability-uncertain`、`published: true`）与无法判定提交（`commit-outcome-unknown`、`publicationPossible: true`）。直接 unit 遇到任一结果后都会停止提供服务。领域层保留发起调用收到的后端原始错误，但既不采用内存变更，也不发出 `domain/changed`；它会让领域中毒，使所有已排队和之后的读写都以 `write-outcome-uncertain` 拒绝，而关闭仍会排空并释放 unit。恢复时应关闭句柄、丢弃并重建受影响的后端（或重启），然后才从介质重新打开；这条保守规则也覆盖不确定结果会毒化共享连接的 provider。确定的发布前失败会保留先前内存，且写链仍可继续。

无论来自声明还是存储，KV unit／领域版本都必须是非负安全整数；负零无效。`defineDomainMigrations` 是唯一的计划构造器。它验证同一领域上有序的 `N -> N+1` 步骤，要求中间版本使用同一份声明身份，并以严格当前声明结束；它还会捕获 spec 容器的冻结副本，并以模块私有身份登记计划。迁移入口拒绝结构化伪造，因此调用方无法绕过相邻性检查，也无法通过原始 spec 对象修改已登记计划。

确定性与不产生外部 effect 是登记调用方的义务。同步 callback 只获得 detached、深冻结 snapshot，因此其声明输入中没有 service handle，但运行时校验无法证明可重复性，也无法检测 clock、network client、process state 或其他 ambient import。Review 与调用方拥有的 evidence 负责建立这些属性；runner 只校验它能观察到的数据与发布结果。

`DomainFacility.migrate` 会预留领域名，再嵌套取得源和目标后端预留。它在检查或读取源之前拒绝已经存在的目标，按已存储版本和严格表／global 布局选择保留历史 spec，校验所有源记录，并把分离且深度冻结的快照交给每个同步步骤。源与每份完整输出都必须先是精确的 JSON 数据，再按相邻目标 spec 校验；编码会省略或强制转换数据的值会在发布前被拒绝。源预留一直保持到目标提交和当前 schema 读回结束；源介质绝不改变，也不会发出 `domain/changed`。

发布前取消会释放两项预留并保持目标缺失。发布之后，读回与当前 schema 校验不再观察迟到的取消，而是继续排空。原始可见快照会先与拟写的已校验快照比较，再重新解析可见值；等价比较忽略对象成员顺序，但保留数组顺序与精确数字，因此被丢弃或改变但仍符合 schema 的记录仍属无效，schema transform 也无法掩盖偏离。不确定结果若读回精确返回目标，会报告 `migration-target-durability-uncertain` 和 `committed: true`；确认缺失会报告 `migration-target-not-committed`；不确定结果的读回若拒绝，会报告 `migration-target-outcome-unknown`。持久物化的提交结果已知；若其读回拒绝，目标无法验证，因此报告 `migration-target-invalid` 和 `committed: true`；成功返回但不符合 schema 或发生偏离的快照也报告同一失败。通用层既不会盲目重试，也不会删除目标。`DomainFacility.materialize` 为全新当前版本状态使用相同的校验、仅创建式发布、读回与证据分类。Facility 拆除会先停止接纳，排空先前已接纳的普通打开与冷操作，尝试把由它们产生的每个实时领域关闭至结算，在单项失败时直接报告、多个失败时聚合报告，并且无论关闭是否失败都会卸载存储形式。

JSON provider 在每个文件中写入物理格式版本 1，以及 unit 名、领域版本、`hasGlobal`、global 值和实际表对象。普通读取与 closed 读取使用致命 UTF-8 解码及共享的严格无损 parser：字节序标记、注释、尾随逗号、嵌套重复成员，以及会被 JavaScript 舍入、下溢或上溢的数字词法都会在不改变源的情况下拒绝。后端一次解析根路径，固定它创建或观察到的第一个真实目录身份，并在读取前后以及紧贴 `rename`／`link` 发布时检查该身份。发布前检测到替换会在没有最终目标的情况下拒绝；命名空间发布后检测到替换会产生如实的未知提交证据，绝不通过陈旧字符串路径删除最终入口，并使直接 unit 或实时领域停止服务。仅创建式发布使用已同步的同目录临时文件和不覆盖的 hard link；目录同步失败后绝不删除已链接目标，并保留不确定读回证据。后端关闭会同步停止实时 unit 准入并排空此前已接纳的操作。由于可移植 Node 路径 API 无法把 `rename`／`link` 绑定到打开的目录句柄，同一用户在最后一个未观察路径解析间隔内完成替换仍是部署限制。

SQLite provider 把物理 schema 版本与领域版本分开。物理版本 2 存储 `has_global` 和显式逻辑表 row；记录表使用经过十六进制编码的 unit 与表片段，因此含下划线的名称不会冲突。它要求 UTF-8 数据库，并把逻辑记录 key 存成规范 JSON 字符串文本，使内嵌 NUL 与孤立代理项都能无碰撞保留。读取 key 和 value 的 TEXT 单元格时会先取得精确字节，以 fatal UTF-8 方式解码，再解码 key 或解析值，因此文本桥截断、替换字符、非规范 key 和隐藏后缀都不能悄悄改变迁移数据。`sqlite_schema` 的 SQL 文本、对象类型、名称与所属表名也会先取得精确字节，再进行 token 与清单校验；清单只省略精确匹配的隐式主键索引。文件型普通打开会在冻结副本上验证完整 v2 布局与全部已存内容，在配置 writer 之前对原连接重复验证，并在公开实时句柄前精确读取请求的 unit。因此它拒绝畸形介质时不会改变 journal mode 或源字节。当前和旧版已存值都使用共享的严格 JSON parser，它会拒绝重复成员以及会被 JavaScript 舍入、下溢或上溢的数字词法。关闭读取器还接受 B03 所需的严格物理 v1 子集：一个有效 unit、没有已存储 global row，而且只包含该 unit 的有效记录表。基于文件的关闭读取会把数据库以及任何非空的 WAL 和 rollback-journal sidecar 复制到私有目录，把每个复制的恢复文件权限规范为仅所有者可读写，验证复制期间源数据库／WAL／SHM／rollback-journal 状态没有改变，并只允许 SQLite 重放或恢复副本；它绝不使用可能漏掉已提交 WAL frame 的 `immutable=1`。只有三个 sidecar 路径也全部不存在时，数据库才会被识别为缺失；孤儿 WAL、SHM 或 rollback journal 属于畸形介质，读取和创建尝试都不会触碰它。SQLite `COMMIT` 失败时，只有事务仍然活跃且回滚成功才能以未发布拒绝；已经结束的事务会返回 uncertain 结果。结果不确定、回滚失败或已经进入执行的普通写语句失败都会中毒共享连接并阻断后续读写；文件型恢复仍可使用新的冻结副本，`:memory:` 则不能暴露中毒句柄。

通用层不选择 generation 路径、不创建 backup、不校验产品级引用不变量，也不发布权威状态。这些职责仍属于 [manifest 选择式 Installation 维护决策](2026-08-26-saki-manifest-selected-installation-maintenance.zh.md)所述的 Saki Installation 维护 Consumer。成功的通用迁移会证明严格已存储布局、历史与相邻 schema、已提交当前 schema 读回以及源不变；Saki 仍会在 Installation lease 下通过普通当前 spec 打开候选，再发布 manifest。

## 考虑过的方案

**公开彼此独立的 `inspect`、`read` 和 `materialize` 调用。** 分离调用会留下预留空档，并要求每个调用方正确释放后端资源。回调作用域 lease 把排他、失效、提交证据和关闭排空留在每个 adapter 内。

**用普通 `DomainFacility.open` 打开历史和候选 unit。** 普通打开属于提供服务的路径，可能创建缺失的当前 unit，也会产生实时句柄。它无法连续持有两个后端预留直到提交读回，而且会把冷维护与发出事件的运行时状态混在一起。

**原地迁移源。** Transaction 无法在当前 schema 产生新写入后继续保留旧 build 可兼容的源，也无法防御提交后才发现的产品不变量。独立且仅创建的目标会一直保留源，直到更高层发布权威状态。

**通过 immutable URI 打开 SQLite。** SQLite immutable 模式假定文件不会改变，可能忽略未 checkpoint 的已提交 WAL。经过校验的私有副本会包含非空 WAL 和 rollback-journal sidecar，允许重放或恢复而不触碰源。

**从值推导布局，或用分隔符拼接表名。** Null global 无法区分未声明 slot 与已声明但从未写入的 slot，而下划线拼接并非单射。显式 `hasGlobal` 元数据和十六进制片段使两种身份都精确无歧义。

## 后果

冷迁移按需启用：后端可以省略 `kv.closed`，没有登记计划的领域继续保持严格 `version-mismatch` 服务行为。迁移要求源与目标是不同后端实例，并且可能在检查、读取和已提交读回期间多次复制 SQLite 文件；离线维护接受这项成本以换取正确性。

JSON 物理 header 与 SQLite 物理 v2 都是有意的预发布格式破坏。普通 adapter 不修复旧介质。SQLite 只为声明的 B03 源保留一条狭窄的只读物理 v1 路径；它不能写入或普遍提供该格式。

发布后校验或持久性证据失败时，可见或可能已提交的候选可能继续存在。显式错误类别让拥有方的维护 journal 能把确认可见、确认缺失与无法判定的结果同可重试发布前失败区分开；通用层有意不删除该候选，也不选择其他介质。

共享后端 contract 覆盖非负安全 unit 版本（包括拒绝负零与不安全整数）、后端开始关闭时在同一轮拒绝新的实时 unit 操作、预留排他与失效、回调结束后立即拒绝、在释放预留与完成后端关闭前排空已接纳但回调未等待的 lease 方法、发布前后取消、仅创建式保全、分离的精确 JSON 所有权、每种 JavaScript 字符串 key、严格布局和读回。Storage-domain 测试覆盖无效版本声明、伪造与变更后的计划、每个保留源、无效历史与相邻记录、目标预检顺序、精确语义读回、持久性／提交不确定、已中毒排队写、拆除竞态、关闭失败排空与卸载，以及不产生事件。Provider 测试覆盖严格的当前及保留 JSON 字节、无效的已存储版本、fatal UTF-8 处理、源保全、真实 `rename`／`link` 操作周围的 JSON 根替换、SQLite key 编码与 transaction 结果，以及不兼容 SQLite 介质在初始化改变介质之前被拒绝。跨 provider 测试会在 JSON→SQLite 与 SQLite→JSON 两个方向运行完整保留链，通过普通当前服务路径打开持久目标，并重新打开未改变的历史源。
