# Saki Windows 宿主启动器

[English](host-launcher.md) | 中文

本文档定义从仓库检出版本启动 Saki 的 Windows 宿主进程。稳定入口包含兼容 Windows PowerShell 5.1 的引导层，常规宿主启动器则明确声明并运行于 PowerShell 7。启动器负责进程前置条件和继承的网络设置；运行时插件可以展示或编辑宿主偏好，但不能取代加载插件的进程。

## 用法

可以从任意目录运行启动器：

```powershell
.\scripts\start-saki.ps1
```

默认命令是在 Saki 仓库根目录执行 `pnpm dsh web`。生产 Web 启动需要当前构建产物；首次检出后，或者源码变更影响生成包或前端 bundle 后，传入 `-Build`：

```powershell
.\scripts\start-saki.ps1 -Build
```

构建保持显式，因为它开销较大，而且源码启动器不会检测过期产物。

## PowerShell 运行时

`scripts/start-saki.ps1` 是 Windows PowerShell 5.1 和 PowerShell 7 共用的稳定入口，并会报告检测到的运行时版本。如果系统已有受支持的 `pwsh`，入口会立即在 PowerShell 7 下启动宿主，同时保留原调用中的代理、构建和 DSH 参数。

如果缺少 `pwsh`，或者其版本低于 PowerShell 7，引导层会先询问，再通过 `winget install` 或 `winget upgrade` 安装 `Microsoft.PowerShell`。没有得到明确同意时，它不会安装软件或请求提权。确实需要无人值守安装时，可以显式传入 `-InstallPowerShell`；要在不弹出询问的情况下拒绝安装，可以传入 `-DeclinePowerShellInstall`：

```powershell
.\scripts\start-saki.ps1 -InstallPowerShell -Build
.\scripts\start-saki.ps1 -DeclinePowerShellInstall
```

安装成功后，引导层会报告最终版本，并在 `pwsh` 下重新启动宿主。如果 `winget` 不可用、安装失败，或者当前进程还找不到新命令，入口会以非零状态退出，并给出 [PowerShell 手动安装说明](https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-windows)。如果安装已经成功但当前进程的 `PATH` 尚未更新，通常重新打开终端即可。

## 代理配置

启动器优先使用 `SAKI_PROXY_URI`，未设置时默认使用 `http://127.0.0.1:7897`。它会验证代理能够接受 TCP 连接、启用 Node 环境代理支持，并把大小写两组代理变量传给 Saki 及其子进程。

可以为单次调用覆盖代理，或者禁用继承的代理设置：

```powershell
.\scripts\start-saki.ps1 -ProxyUri http://127.0.0.1:7890
.\scripts\start-saki.ps1 -NoProxy
```

Saki 退出时，启动器会恢复调用它的 PowerShell 进程原有的代理变量。Saki 运行期间，`localhost`、`127.0.0.1` 和 `::1` 始终不经过代理。

## DSH 参数

启动器不能识别的参数会转发给仓库中的 `dsh` 命令。例如：

```powershell
.\scripts\start-saki.ps1 web --port 3081
.\scripts\start-saki.ps1 --profile headless "summarize this repository"
```

启动器参数必须位于转发的 DSH 参数之前。缺少 `pnpm`、代理 URI 无效、代理不可用、构建失败或 DSH 进程失败时，启动器以非零状态退出。
