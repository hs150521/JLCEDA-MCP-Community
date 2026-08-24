# 发布社区版 Bridge

本项目发布的是 MCP Bridge 的非官方社区衍生版本，来源为 sengbin/JLCEDA-MCP。每次发布都要在扩展描述和 README 中保留上游署名及非官方声明。

## 发布检查表

1. 保持 mcp-bridge/extension.json.uuid 不变。JLCEDA 会按 UUID 将后续上传归入同一扩展命名空间。
2. 按需递增 mcp-bridge/extension.json、mcp-bridge/package.json 和 mcp-server/package.json 中的版本。
3. 更新 mcp-bridge/CHANGELOG.md，并确认 README 说明安装、配置、安全假设、上游署名和支持渠道。
4. 执行：

   ```powershell
   cd mcp-server
   npm ci
   npm test

   cd ..\mcp-bridge
   npm ci
   npm run build
   ```

5. 在干净的 JLCEDA Professional 配置中安装 build/mcp-bridge-community-<version>.eext，测试连接、重连、多客户端选择、只读工具、器件放置、普通网络标签、电源标识、错误处理、升级和上一版本兼容性。
6. 为对应提交创建 GitHub Release，并附加 .eext、SHA-256 校验和及发布说明。不要从有未提交改动的工作区发布。
7. 访问 JLCEDA 扩展广场 https://jlc-ext.com/，打开“扩展管理”，选择“上传扩展”，上传测试通过的 .eext 文件。首次上传会创建命名空间，后续版本继续使用同一 UUID。
8. 提交前检查生成的扩展广场页面。包中必须包含有效的 name、uuid、displayName、description、version、license、分类、入口文件、README，以及不超过 5 MiB 的非默认 1:1 图标。不同扩展 UUID 不得复用同一 name。
9. 提交审核。若被拒绝，按扩展广场通知修复并上传新的补丁版本，不要静默替换已发布产物。

## 官方要求

- 嘉立创扩展广场指南：https://prodocs.lceda.cn/cn/api/guide/extensions-marketplace.html
- 嘉立创扩展清单指南：https://prodocs.lceda.cn/cn/api/guide/extension-json.html

## 命名和商标

扩展广场显示名称为“**MCP Bridge 社区版**”。描述必须继续说明其基于上游 MCP Bridge，且不是官方 JLCEDA 插件。仓库采用 Apache-2.0 许可证；分发源代码或二进制包时保留 LICENSE 和上游署名。

