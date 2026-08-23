# Saki Windows host launcher

English | [中文](host-launcher.zh.md)

This reference defines the Windows host process that starts Saki from its repository checkout. The stable entry point includes a Windows PowerShell 5.1-compatible bootstrap, while the ordinary host launcher declares and runs on PowerShell 7. The launcher owns process prerequisites and inherited network settings; runtime plugins may expose or edit host preferences but cannot replace the process that loads them.

## Usage

Run the launcher from any directory:

```powershell
.\scripts\start-saki.ps1
```

The default command is `pnpm dsh web`, executed from the Saki repository root. Production Web startup requires current build artifacts; pass `-Build` after a fresh checkout or after source changes that affect generated packages or frontend bundles:

```powershell
.\scripts\start-saki.ps1 -Build
```

The build is explicit because it is expensive and the source launcher does not detect stale artifacts.

## PowerShell runtime

`scripts/start-saki.ps1` is the stable entry point on both Windows PowerShell 5.1 and PowerShell 7. It reports the detected runtime version. When a supported `pwsh` is already available, it starts the PowerShell 7 host immediately and preserves the proxy, build, and DSH arguments from the original invocation.

When `pwsh` is missing or older than PowerShell 7, the bootstrap asks before running `winget install` or `winget upgrade` for `Microsoft.PowerShell`. It never installs or requests elevation without that explicit answer. For an intentional unattended invocation, use `-InstallPowerShell`; use `-DeclinePowerShellInstall` to reject installation without prompting:

```powershell
.\scripts\start-saki.ps1 -InstallPowerShell -Build
.\scripts\start-saki.ps1 -DeclinePowerShellInstall
```

After a successful installation, the bootstrap reports the resulting version and relaunches the host under `pwsh`. If `winget` is unavailable, installation fails, or the new command is not yet visible, the entry point exits nonzero with [manual PowerShell installation instructions](https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-windows). Opening a new terminal is usually sufficient when a successful installation has not yet updated the current process's `PATH`.

## Proxy configuration

The launcher uses `SAKI_PROXY_URI` when set and otherwise defaults to `http://127.0.0.1:7897`. It verifies that the proxy accepts a TCP connection, enables Node environment-proxy support, and supplies uppercase and lowercase proxy variables to Saki and its child processes.

Override the proxy for one invocation or disable inherited proxy settings:

```powershell
.\scripts\start-saki.ps1 -ProxyUri http://127.0.0.1:7890
.\scripts\start-saki.ps1 -NoProxy
```

The launcher restores the calling PowerShell process's proxy variables when Saki exits. `localhost`, `127.0.0.1`, and `::1` always remain outside the proxy while Saki runs.

## DSH arguments

Arguments that the launcher does not recognize are forwarded to the repository's `dsh` command. For example:

```powershell
.\scripts\start-saki.ps1 web --port 3081
.\scripts\start-saki.ps1 --profile headless "summarize this repository"
```

Launcher parameters must precede forwarded DSH arguments. A missing `pnpm`, invalid proxy URI, unavailable proxy, failed build, or failed DSH process exits nonzero.
