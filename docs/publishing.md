# 发布社区版 Bridge

本项目发布的是 MCP Bridge 的非官方社区衍生版本，来源为 sengbin/JLCEDA-MCP。每次发布都要在扩展描述和 README 中保留上游署名及非官方声明。

## 发布检查表

1. 保持 mcp-bridge/extension.json.uuid 不变。JLCEDA 会按 UUID 将后续上传归入同一扩展命名空间。
2. 同步递增 mcp-bridge/extension.json、两个包的 package.json 与 package-lock.json 中的版本。
3. 更新两个包的 CHANGELOG.md，并确认 README 说明安装、配置、安全假设、上游署名和支持渠道。发布说明应覆盖自上一个 GitHub Release 起的全部变更；当前版本见 [v2.4.0 发布说明](releases/v2.4.0.md)。
4. 执行：

   ```powershell
   cd mcp-server
   npm ci
   npm test

   cd ..\mcp-bridge
   npm ci
   npm run build
   ```

5. 在干净的 JLCEDA Professional 配置中安装 `build/mcp-bridge-community-<version>.eext`，测试连接、重连、多客户端选择、只读工具、器件放置、普通网络标签的版本提示、电源标识、错误处理、升级和上一版本兼容性。更新后确认“外部交互”权限仍已启用。源码现声明支持 EDA 3.x/4.x，应分别记录实际宿主版本与测试范围；普通标签在 3.x 应拒绝，新 API 按各自最低版本检查，不能把类型或构建通过当作宿主实测。
6. 从干净提交打包 Server `.tgz`，为同一提交创建 GitHub Release，并附加 `.eext`、`.tgz`、SHA-256 校验和及发布说明。不要从有未提交改动的工作区发布。
7. 访问 JLCEDA 扩展广场 https://jlc-ext.com/，打开“扩展管理”，选择“上传扩展”，上传测试通过的 .eext 文件。首次上传会创建命名空间，后续版本继续使用同一 UUID。
8. 提交前检查生成的扩展广场页面。包中必须包含有效的 name、uuid、displayName、description、version、license、分类、入口文件、README，以及不超过 5 MiB 的非默认 1:1 图标。不同扩展 UUID 不得复用同一 name。
9. 提交审核。若被拒绝，按扩展广场通知修复并上传新的补丁版本，不要静默替换已发布产物。

## GitHub Release 自动发布

[GitHub Release 工作流](../.github/workflows/release.yml) 在推送 `v*` 标签时运行，也可在 Actions 页面选择 `main` 等发布分支手动执行。手动运行的标签输入可留空，按包版本生成 `v<version>`；两种方式都固定到触发时的提交。先提交并推送全部发布源码，确保标签版本与 Bridge/Server 的 package.json、package-lock.json（含 packages 根项）和 extension.json 一致；两个 CHANGELOG 必须有非空的 `## [<version>]` 节，不能只保留 Unreleased。

工作流执行 Windows/Linux Server 测试、lint、多客户端验证和生产依赖审计，以及 Linux Bridge 完整构建和 lint；所有检查通过且生成的受跟踪文件没有差异后，再执行 `npm pack`。手动运行仅在这些门禁通过后创建缺失的标签；已有标签必须指向此次验证的同一提交，绝不移动标签。发布任务按仓库串行执行。它只向 GitHub Release 上传 `.eext`、Server `.tgz` 和 `SHA256SUMS`，不发布到 npm registry，也不向扩展广场自动提交。中文发布说明从两个 CHANGELOG 的对应版本节生成。

上传先写入草稿，并重新下载附件验证 SHA-256，全部成功后才公开发布；失败会保留草稿，同一标签及提交可重新运行恢复。已发布版本不会覆盖，修复应递增版本并创建新标签。带预发布后缀的版本会标记为 prerelease。工作流使用自动提供的 `GITHUB_TOKEN` 和 `contents:write` 权限，无需配置额外 secret；官方 checkout/setup-node 固定到提交 SHA。

自动发布不替代上面的 EDA 实测和扩展广场审核。若标签由另一个工作流的 `GITHUB_TOKEN` 推送，GitHub 默认不会再触发 tag push 工作流；这种情况应显式使用 workflow_dispatch 运行本工作流，参见 [GitHub 工作流触发规则](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow)。

## 官方要求

- 嘉立创扩展广场指南：https://prodocs.lceda.cn/cn/api/guide/extensions-marketplace.html
- 嘉立创扩展清单指南：https://prodocs.lceda.cn/cn/api/guide/extension-json.html

## 命名和商标

扩展广场显示名称为“**MCP Bridge 社区版**”。描述必须继续说明其基于上游 MCP Bridge，且不是官方 JLCEDA 插件。仓库采用 Apache-2.0 许可证；分发源代码或二进制包时保留 LICENSE 和上游署名。
