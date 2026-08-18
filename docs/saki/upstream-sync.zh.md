# Saki 上游同步

[English](upstream-sync.md) | 中文

本文档定义 Saki 如何纳入 `deepseek-ai/deepseek-harness`，而不让上游自动化直接访问 `master`。仓库工作流负责检测、同步 Pull Request、兼容性路由和必需 CI 通过后的自动合并。

## 仓库配置

创建一个 GitHub App 并安装到 `BreakfastDaPaiDang/saki`，授予以下仓库权限：

- Contents：读写
- Workflows：读写
- Pull requests：读写
- Issues：读写

把 App client ID 存为 Actions 变量 `SAKI_AUTOMATION_CLIENT_ID`，把完整私钥存为 Actions secret `SAKI_AUTOMATION_PRIVATE_KEY`。工作流创建安装 token 时只请求这些权限。必须使用 GitHub App token，因为使用仓库 `GITHUB_TOKEN` 创建的 Pull Request 不经过批准步骤就不会启动普通 CI。

把 `SAKI_CI_RUNNERS=standard` 设置为仓库 Actions 变量。用必需状态检查 `all checks passed` 保护 `master`，允许 Pull Request 自动合并，并保留 merge commit，使上游同步能够保存已纳入的上游历史。

## 运行方式

[`upstream-sync.yml`](../../.github/workflows/upstream-sync.yml) 每天 19:17 UTC 运行，也接受手动触发。它获取官方 `master`，与 Saki `master` 比较；当 Saki 已经包含该上游 commit 时不执行任何操作。

发现新上游 commit 后，工作流通过 lease 保护 `automation/upstream-sync`，把确切的上游 head 镜像到该分支，并创建或更新一个 Pull Request。Saki 的合并候选保留 Saki 专属文件和修改，GitHub CI 对合并后的树进行测试。

文本合并干净时，工作流把 Pull Request 标为 Ready 并启用自动合并。分支保护会延迟合并，直到 `all checks passed` 成功。存在文本冲突时，Pull Request 保持 Draft，并创建或更新一个带中文标题、`ready-for-agent` 和 `area/infra` 的兼容性 Issue。

同一工作流监听同步分支已完成的 CI 运行。即使 Git 没有发现文本冲突，失败或取消的 CI 也会创建或更新兼容性 Issue。CI 成功时关闭现有兼容性 Issue；随后 GitHub 完成已经启用的自动合并。

## 手动触发

配置 GitHub App 后运行：

```sh
gh workflow run upstream-sync.yml --repo BreakfastDaPaiDang/saki
```

client ID 缺失时，工作流让手动触发以配置错误失败。client ID 配置完成前，定时运行保持空闲，避免在引导期间反复发送失败通知。
