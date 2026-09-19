# Agent Note：可复现的 CI bubblewrap 软件包

Status: implemented

[English](2026-09-19-ci-bubblewrap-snapshot.md) | 中文

## 问题

Ubuntu 会从实时仓库移除被取代的软件包修订版。因此，即使固定了版本和 SHA-256，下载地址仍可能在仓库代码未变时失效。在[运行 35455546913](https://github.com/BreakfastDaPaiDang/saki/actions/runs/35455546913) 中，bubblewrap 准备步骤返回 HTTP 404，Node 兼容、覆盖率和快照任务尚未执行检查便退出。

## 决策

`scripts/prepare-ci-bubblewrap.sh` 从日期固定为 `20260919T000000Z` 的 [Ubuntu 快照](https://snapshot.ubuntu.com/)下载 Ubuntu Noble 的 `0.9.0-1ubuntu0.3` amd64 软件包。其 SHA-256 与官方 Noble 安全软件包索引一致。脚本在解包前验证下载内容，并要求真实的命名空间探测通过后才运行测试。

## 考虑过的替代方案

**只更新实时仓库 URL。** 后续安全修订版仍可能使该软件包被移除。固定日期的快照保留已审查的内容，校验值仍会拒绝不同的字节。

## 影响

实时仓库替换修订版不会使固定的 URL 失效。维护时采用安全修订版，必须一起更新快照、软件包版本和摘要。快照保留期仍依赖外部服务；下载、校验、解包和探测失败均会终止任务。
