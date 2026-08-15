# Agent Note: Saki Windows host launcher

Status: implemented

English | [中文](2026-08-15-saki-windows-host-launcher.zh.md)

## Problem

Saki needs machine-local process configuration before Node loads the plugin tree. Starting a published `@deepseek-ai/dsh` package bypasses Saki's repository changes, while configuring the proxy inside a runtime plugin occurs after Node has already started and cannot govern bootstrap network access.

## Decision

[`scripts/start-saki.ps1`](../../../../scripts/start-saki.ps1) is the Windows host launcher. It runs the repository's `pnpm dsh` command from the repository root, optionally builds production artifacts, validates and injects the selected proxy for the child process, and restores the caller's process environment on exit.

The launcher's interface is `-ProxyUri`, `-NoProxy`, `-Build`, followed by DSH arguments. `SAKI_PROXY_URI` supplies the machine-level proxy preference; `http://127.0.0.1:7897` is the Windows host default. Runtime plugins may manage these preferences or request a restart, but an external host adapter remains responsible for creating the Saki process.

## Alternatives considered

**Keep the personal root script untracked.** This avoids a Saki-specific repository change but leaves startup behavior undiscoverable, unreviewed, and coupled to one checkout path.

**Start the published DSH package.** This keeps the command short but runs official release artifacts instead of the Saki checkout, so local product changes do not reach the running process.

**Implement startup as a DSH plugin.** A plugin can configure runtime consumers, but it loads too late to choose the Node executable, repository entry point, or bootstrap proxy environment.

## Consequences

Windows hosts get one reviewed entry point that keeps machine preferences outside runtime configuration and forwards the complete DSH command interface. Operators must request builds explicitly, and non-Windows deployment still needs its own host adapter such as systemd or a container entry point.
