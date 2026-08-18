# Agent Note: Saki Windows 宿主启动器

Status: implemented

[English](2026-08-15-saki-windows-host-launcher.md) | 中文

## Problem

Saki 需要在 Node 加载插件树之前设置机器本地的进程配置。启动已发布的 `@deepseek-ai/dsh` 包会绕过 Saki 仓库中的变更，而在运行时插件内配置代理发生在 Node 启动之后，无法管理引导阶段的网络访问。

## Decision

[`scripts/start-saki.ps1`](../../../../scripts/start-saki.ps1) 是 Windows 宿主启动器。它从仓库根目录运行仓库中的 `pnpm dsh` 命令，可选构建生产产物，为子进程验证并注入选定代理，并在退出时恢复调用方的进程环境。

启动器的接口依次是 `-ProxyUri`、`-NoProxy`、`-Build` 和 DSH 参数。`SAKI_PROXY_URI` 提供机器级代理偏好；`http://127.0.0.1:7897` 是 Windows 宿主默认值。运行时插件可以管理这些偏好或请求重启，但创建 Saki 进程仍由外部宿主适配器负责。

## Alternatives considered

**继续使用未跟踪的个人根目录脚本。** 这样不会产生 Saki 专属仓库变更，但启动行为无法被发现和评审，并且与单个检出路径耦合。

**启动已发布的 DSH 包。** 这样命令较短，但运行的是官方发布产物而非 Saki 检出版本，因此本地产品变更不会进入运行进程。

**把启动实现为 DSH 插件。** 插件可以配置运行时消费方，但加载时机太晚，无法选择 Node 可执行文件、仓库入口或引导代理环境。

## Consequences

Windows 宿主获得一个经过评审的入口，在运行时配置之外保留机器偏好，并转发完整的 DSH 命令接口。运维者必须显式请求构建，而非 Windows 部署仍需要 systemd 或容器入口等自己的宿主适配器。
