# Agent Note: 构建依赖安全约束

Status: implemented

[English](2026-09-12-build-dependency-security-containment.md) | 中文

## 问题

桌面运行时准备只需要 Windows Node.js ZIP 中的一个可执行文件，但通用归档解压会为每个条目开放文件系统操作。网站工具也可能在直接依赖获得兼容安全补丁后继续保留存在漏洞的传递依赖。

## 决策

[Windows 运行时准备](../../../../apps/desktop/scripts/prepare-runtime.ts) 验证上游归档校验和，通过 `fflate` 选择与发行版和架构完全对应的 `node.exe` 条目，并以独占创建方式将其字节写入调用方拥有的路径。归档路径和符号链接元数据绝不决定文件系统目标位置。现有的可执行文件版本检查验证生成的运行时。[桌面打包决策](../architecture/2026-08-25-electron-desktop-packaging-and-updates.zh.md) 负责运行时隔离和发行完整性。

[工作区覆盖配置](../../../../pnpm-workspace.yaml) 仅在稳定版 VitePress 1.6.4 下选择已修补的 Vite 6；网站声明相同的 Vite 版本范围。此例外始终限定于该父依赖版本，并要求网站构建和片段链接验证成功。依赖更新保留[维护隔离策略](2026-09-05-saki-maintenance-work-ownership.zh.md)。

## 考虑过的替代方案

**保留通用 ZIP 解压。** 桌面应用不需要 Windows 归档中的目录、npm 内容或符号链接。选择字节既移除了这些解压语义及存在漏洞的 `extract-zip` 依赖，也无需自行维护 ZIP 解析器。

**将网站工具迁移到预发布的 VitePress 主版本。** 主版本迁移会将兼容性工作扩大到依赖修复之外。稳定版 VitePress 和 Vue 插件能够使用已修补的 Vite 6 构建；限定父依赖的覆盖配置记录了这一有限的兼容性决策。

## 影响

ZIP 选择会将所选可执行文件缓存在内存中，并且有意不支持解压完整的 Node.js 发行包。测试验证缺失和损坏的归档、拒绝覆盖现有输出，以及在存在路径穿越、绝对路径和符号链接条目时保留目标位置之外的文件。Windows 运行时冒烟检查会执行内置 Node.js 和 pnpm 并验证其版本。更新 VitePress 时需要重新评估其 Vite 依赖，而不是沿用全局 Vite 覆盖配置。
