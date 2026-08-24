# Agent Note: Windows 上基于 terminal seam 的持久化 pwsh

Status: implemented

[English](2026-08-11-pwsh-persistent-pty.md) | 中文

## 问题

harness 在 Windows 上没有持久 shell。持久 `bash` 栈按构造就是 POSIX-only：`@deepseek-ai/dsh-subprocess-local` 在终端分配时直接抛错（`createProcessInspector()` 拒绝 win32），`@deepseek-ai/dsh-terminal-bash` 是 bash 形态（`/bin/bash` 默认值、`PS1`/`PROMPT_COMMAND` 环境标记），`@deepseek-ai/dsh-tool-bash-persistent` 用 bash 语法包装命令，pty 测试全部在 win32 上 skip。一次性 `pwsh` 工具（`@deepseek-ai/dsh-tool-pwsh` + `@deepseek-ai/dsh-pwsh-local`）已经能在 Windows 运行，但每次调用都是全新的 `pwsh -Command` 进程：cwd、`$env:` 变量、函数和交互式子进程都随调用结束，其 README 把 "No persistent shell or PTY" 记为 deferred work。

这个缺口排除了状态驻留在终端里的 Windows 工作流：单步调试、在 Python 或 Node REPL 中探索、中断前台命令后回到原 shell —— 正是持久 bash pty 在 POSIX 上服务的同一类工作。

两个基础已经存在。PTY 服务本身（`ctx.terminals` 注册表、owner 作用域、send/read/signal/kill 契约）是平台无关的。Loader 的 `disabled: !!js` 插值（PR #2234）按平台门控 shell 行，并钉死了"每宿主恰好挂载一个 shell 栈"的不变量；持久 pwsh 栈通过同一行机制组合。

## 决定

模型侧持久 `pwsh` 工具在 Windows 上交付，契约与 `tool-bash-persistent` 逐项对齐：每个 Agent 一个 owner 作用域的持久 shell、标记检测的命令完成、精确的原生退出码、有界输出，以及超时/取消/`exit` 时重置 shell 并告知模型的语义。三块交付：`subprocess-local` 的 Windows 基座、`terminal-bash` 的 shell 方言选项、新的 `tool-pwsh-persistent` 包加 minimal 预设组合行。

### `@deepseek-ai/dsh-subprocess-local` 的 Windows 基座

`createProcessInspector()` 在 win32 返回 `WindowsProcessInspector` 而不是抛错。基于 koffi 的检查器通过 Toolhelp32 枚举进程表，把 GetProcessTimes 创建身份与进程句柄零时等待结合起来（同时防止 PID 复用并识别已终止的进程对象），把 **shell pid 作为伪前台进程组**（Windows 没有 POSIX 进程组；这个稳定值让 prompt-marker 就绪快路径在一个轮询间隔内结算），不报告 stdin-wait 证据（就绪与 macOS 同档），信号走 `taskkill /T` 升级（仅 SIGKILL 加 `/F`）。koffi（`^3.1.0`，`sandbox-windows-acl` 已固定的版本）仅在 win32 惰性加载。

`LocalTerminalHandle` 为 win32 分支，因为 node-pty 的 `kill(signal)` 会抛错（"Signals not supported on windows"），其无参 kill 委托的 console-list agent 在没有父控制台时失败。拆卸经 taskkill 升级并以 shell 的启动身份作栅栏；由于被外部 taskkill 的 shell 可能永远不会触发 node-pty 的退出通知，句柄从 inspector 验证的消失状态结算 `done`（`settleExitIfGone`）。`signalForeground` 把 SIGINT 映射为 `\x03` Ctrl-C 输入写入（conhost 转为控制台级 CTRL_C 事件的投递方式；实测可中断运行中的命令），SIGTERM/SIGKILL 路由到 taskkill，SIGTSTP/SIGHUP 以 Windows 不可用为由拒绝。公共 `PtySignal` 集合与 seam 类型不变；映射全部留在 backend。

### `@deepseek-ai/dsh-terminal-bash` 的 shell 方言

一个后端、两种方言：`shellDialect: 'bash' | 'pwsh'`（默认 `'bash'`，存量部署逐字节不变）。有效 `shellPath`/`shellArgs` 按方言解析（bash `/bin/bash --noprofile --norc -i`；pwsh 经共享的 `dsh-pwsh-local` 解析器取 `-NoLogo -NoProfile -NonInteractive`）。`-NonInteractive` 会阻止自动加载 PSReadLine，并让 `Read-Host` 和确认 UI 等 PowerShell 宿主输入直接失败，同时保留 ConsoleHost 的顶层提示符循环、持久 runspace 与原生前台子进程的 PTY 继承。所有提交行都以 `\r` 结尾；ConsoleHost 的控制台读取器和终端中的原生子进程都会把它作为一次 Enter 消费。显式 pwsh `shellArgs` 必须省略或与这组受支持参数完全一致；`-File -`、`-Command -` 等重定向 stdin 模式会在配置阶段被拒绝。在 Unix 上，[ConsoleHost 写出提示符后进入控制台读取器](https://github.com/PowerShell/PowerShell/blob/929903692e550140efb5042ed05d65bfd21ccb5f/src/Microsoft.PowerShell.ConsoleHost/host/msh/ConsoleHost.cs#L2581-L2614)，此时 .NET 可能发出 `ESC[6n` 并等待 `ESC[row;colR`；node-pty 只提供字节传输，不提供终端响应。因此，sanitizer 会在整个会话中跨数据回调识别这一种精确查询，并从可见输出中移除它；只有 pwsh 会话会回复，在输出确定处于行首时返回第 1 行第 1 列，否则返回第 1 行第 2 列。非零回退让 ConsoleHost 能在未终结输出后补换行，同时无需完整终端模拟器；近似序列与无关控制序列都不会得到响应。命令、光标回复与信号共用一个串行终端动作队列，同时只写入一个光标回复。普通回复会保持活动状态，直至提供方写入结算，并且在该写入调用开始后由可打印文本、自有提示符或后续精确光标位置查询提供恢复证据；结算与该证据的先后顺序不限。若查询出现在自有提示符标记之后，或非空活动 send 仍在等待其提供方写入动作，则回复写入结算即可释放，因为 ConsoleHost 随后可能等待输入且不再产生输出。即使消费方替换可打印提示符尾部，该标记也足够：提示符函数先发出标记，再返回该尾部，而 ConsoleHost 只有在渲染它之后才发出查询。当前台检查异步延迟输入动作时，这也能让已计划输入跟在原生提示符查询之后；如果输入已经早于查询到达，[.NET 会把这些字节交还给 stdin 读取器](https://github.com/dotnet/runtime/blob/51874e577c504e758a38f19bfb9999aa1ad0594a/src/libraries/System.Console/src/System/ConsolePal.Unix.cs#L489-L518)。由于这段加锁的 .NET 读取只有在消费前一个回复后才能发出下一次查询，系统会有界保留之后第一个精确查询作为后继，并以它作为前一个回复的恢复证据；该后继仍存在时会丢弃更多查询。系统会先安装后继，再释放前一个回复的阻塞，因此排队的命令或信号无法越过它；关闭、退出和传输失败则会丢弃后继。只要这条回复链仍存在，就绪检查就不能结算；已经超时的 send 也会保留位置直至回复链清除。仍处于活动会话中的回复失败属于终端传输失败；正常输出结束或关闭已经取得所有权后的失败不会取代该终端结果。前台检查与 PTY 输出投递是彼此分离的观察：本地提供方的异步 `inspectForeground()` 内部执行同步进程扫描，因此检查期间产生的输出可能保持排队，直到检查结果处理逻辑运行后才投递。`stdin_read` 或 `inferred_idle` 观察因此只形成候选。只有 `waitReason`、`processGroupId` 和 `outputRevision` 在下一次轮询仍保持不变，候选才会结算；期间的终端输出会使候选失效。已配置的绝对 `timeoutMs` 仍是权威上限，可能在候选获得确认轮询前先以 `timeout` 结算。子环境去掉 bash 专属 `PS1`/`PROMPT_COMMAND` 标记并为 pwsh 加 `NO_COLOR`。pwsh 无法从环境安装提示符，因此后端通过第一次会话 send 写入 prompt 函数，并等待受控提示符真正可见——因为 pwsh 从横幅到提示符的间隙可能超过静默上限，所以会在后续 send 上循环等待；`session_exit` 或 `timeout` 结算拒绝 spawn。所有 bootstrap send 共用一个已配置的 `timeoutMs` deadline。bootstrap 只接受位于 viewport 或保留 scrollback 尾部的受控提示符，因此回显的 setup 源码既不能发布该会话，也不能无限延长启动。两种方言发出相同的 BEL 终结 OSC `133;D;` 标记；marker 识别与下游就绪消费仍保持共享，marker 仍只是载荷不被消费的就绪信号，也没有新增模型通知通道（延后的 BEL 事件通道保持延后）。

### `@deepseek-ai/dsh-tool-pwsh-persistent`

新包镜像 `tool-bash-persistent`：同样的 `Config`（`backendType` 默认 `shell`、`timeoutMs`、`maxOutputChars`、`description`）、同样的 owner 作用域 shell 注册表与每 owner 串行队列、同样的超时/中止/退出/重置路径。工具名是 `pwsh`；它与一次性 `tool-pwsh` 永不共挂，因为预设行按平台互斥。

命令经包装器执行：先重置 `$LASTEXITCODE`（可赋值，已实测），通过 `Invoke-Expression` 在反引号转义的双引号字符串中执行 body（`quoteForPwsh`：反引号、引号、`$`、CRLF 与 ESC 转义，输入行上不携带裸控制字符，包装器可在 ConstrainedLanguage 下存活），报告精确原生退出码、PowerShell 终止性错误的 `1` 或成功的 `0`。PTY 路径会把提交的包装器回显进流，因此提取会从捕获输出中剥离包装器原文；回显无法伪造完成，因为状态正则要求 END nonce 后紧跟数字，而回显继续是引号字符。prompt 函数安装工具自有提示符（`__DSH_PERSISTENT_PWSH_PROMPT__ `）覆盖后端引导值，与 bash 的双层结构相同。

### 组合

minimal 预设用 #2234 的 `disabled: !!js` 插值按平台门控持久 shell 栈：bash 行（`terminal-bash` + `tool-bash-persistent`）在 POSIX 挂载，pwsh 行（`shellDialect: pwsh` 的 `terminal-bash` + `tool-pwsh-persistent`）在 win32 挂载——每宿主恰好一个持久 shell。`windows-shell.spec` 钉死按平台的花名册；真实 Loader 组合在真实 ConPTY pwsh 上跑通整条栈。

### 测试

Windows 测试面沿用 master 的豁免结构：terminal-bash 与 subprocess-local 的测试在 win32 上继续排除（`windowsUnsupportedTests`），其源码在 win32 上继续覆盖豁免（`windowsUnsupportedCoveragePackages`），平台门控 fixture 与 node 翻译命令因此仍是 win32 开发车道的证据；koffi-backed inspector 在 Linux 侧加入 windows-only 覆盖豁免。terminal 后端的真实 pwsh 套件证明持久 cwd/env、不自动加载 PSReadLine、宿主提示立即失败、密钥清洗、UTF-8 输出、无换行输出后的提示符分隔，以及原生子 REPL 精确执行一次、返回后继续执行下一条 shell 命令。流式测试覆盖拆分与重复的精确光标查询、不匹配查询、行首追踪、异步提供方动作串行化、启动与 send 的就绪抑制、固定回复上限、回复失败、正常退出和关闭竞态。专门的竞态用例在前台检查期间排队 PTY 输出，证明 `stdin_read` 与 `inferred_idle` 候选都会先给输出投递留出一次机会、等到下一次轮询再结算，把排队结果保留在 send viewport 中，并允许绝对 deadline 早于未确认候选胜出。自定义可打印提示符尾部用例证明，自有提示符标记无需后端的 `dsh> ` 尾部即可释放光标回复。`tool-pwsh-persistent` 不在豁免之列：其套件在 windows-native 车道上运行、源码受覆盖约束，镜像 `tool-bash-persistent` 的 stub 模式矩阵并加回显剥离模式；其真实 Loader 组合在真实 ConPTY 会话上证明持久 cwd/env、多行与 here-string 命令、大输出裁剪与退出/重置。ACP keyless snapshot 通过真实 Loader 组合启动持久工具，并固定模型可见的 schema 与结果。

## 备选方案

- **独立的 `pty-pwsh-local` backend 包。** 拒绝：本地 session、sanitizer、就绪档位和沙箱栅栏是共享机制；为一个 config 字段复制 500 行 session 换来的是一包复制粘贴，与 bash 组并置薄 executor 的情形不同。
- **tasklist 或 wmic 轮询进程树。** 拒绝：`inspectForeground` 每次就绪轮询（约 50ms）都跑，每 tick 生成一次探测进程不可行；wmic 已从现行 Windows 移除。koffi + Toolhelp32 是进程内、廉价的。
- **为 SIGINT 加原生 helper 或 `GenerateConsoleCtrlEvent`。** 拒绝：向 ConPTY 输入写 `\x03` 即可中断运行中的命令（已实测），零新增代码。语义差异——在提示符处 `\x03` 取消当前行而不是给进程发信号——文档化而不是绕开。
- **包装器 body 用 base64 编码。** 拒绝：解码需要 `[Convert]`/`[System.Text.Encoding]` 调用，其在 ConstrainedLanguage 下的可用性未证实；反引号转义的双引号字符串只用语言级构造，且已端到端实测。
- **容忍回显而不剥离包装器。** 拒绝：完整路径和提示符就绪路径下回显天然被排除，但超时和 START 丢失的回退会把包装器源码（含 marker nonce）泄漏进模型可见文本。
- **等待 Unix 光标查询自行超时。** 拒绝：第一次 .NET 光标查询的等待时间超过已配置的启动 deadline，受控 OSC 提示符使光标追踪失效后还会反复发生 cache miss，且就绪检查可能把这次协议读取误判成命令完成。响应协议才能修复缺失的终端行为，而不是削弱 deadline。
- **重定向 stdin 模式或私有命令分发器。** 拒绝：`-File -` 会让终端输入经过 stdin 文件读取器；Unix 回车会阻塞，而 CRLF 会成为原生子进程的两行输入；`-Command -` 则拒绝终端 stdin。私有分发器必须重新实现 ConsoleHost 提示符循环已经提供的多行解析、Ctrl-C、错误、`exit`、作用域和原生子进程 stdin 行为。
- **复活 BEL 模型通知通道。** 拒绝：当前实现不消费任何 marker 载荷、不投递任何 BEL 事件；设计对齐当前实现，deferred 项保持 deferred。
- **把 Windows PowerShell 5.1 当一等目标。** 拒绝：pwsh 7（含 Store 安装）是目标；`resolvePwshPath` 保留 5.1 作为最后的可执行回退，但不承诺持久 shell 在其上的完整行为。

## 后果

**Windows 成为一等公民的持久 shell 宿主。** 持久 pwsh 栈在 windows-native 车道上运行并受覆盖门禁约束；一次性/持久 shell 的划分与 POSIX 镜像，预设 spec 在两种平台上都钉死每宿主恰好一个 shell 栈。

**Windows 覆盖沿用 master 的豁免结构。** subprocess-local 与 terminal-bash 源码在 win32 上保持覆盖豁免、其套件保持测试排除，与 master 完全一致；Windows 代码路径经 win32 开发车道与真实 pwsh 工具套件验证，新表面的覆盖义务在 windows-native 车道上落在 `tool-pwsh-persistent`。

**Windows 就绪弱于 Linux。** 伪 pgid marker 快路径覆盖 shell 提示符，但没有提示符的子进程按静默档结算（约 3s），与 macOS 完全一致；没有精确的 stdin-wait 档。

**Windows 的拆卸与信号不同于 POSIX。** 不带 `/F` 的 taskkill 无法终止控制台进程（TERM 档是 `/F` 升级前的宽限等待）、SIGINT 是控制台级 Ctrl-C、SIGTSTP/SIGHUP 不可用，且被外部 taskkill 的 shell 可能不触发 node-pty 的退出通知——句柄改从验证的消失状态结算。

**PowerShell 宿主提示会直接失败而不是等待。** 默认的 `-NonInteractive` 宿主会拒绝 `Read-Host` 和确认 UI。持久状态与原生前台子进程输入仍可通过 PTY 使用。

**受支持的 PTY 路径会回显提交的输入。** PowerShell 的 ConsoleHost 行编辑器负责该回显。marker 锚定提取与包装器原文剥离会从模型可见结果中移除完整副本，原始终端视图与部分输出回退中的残留仍有界。

**携带的风险。** Windows ACL 沙箱只读模式下，ConstrainedLanguage 可能拒绝引导代码通过 `[Console]::` 固定编码并写入 prompt marker；此时命令通过可打印提示符和静默档结算，非 ASCII 输出可能沿用宿主代码页。模型重定义 `prompt` 函数同样会使就绪降级到静默档。koffi 成为进程基座的依赖，承担与沙箱包相同的安装/prebuild 评审。
