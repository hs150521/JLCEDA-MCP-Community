# JLCEDA MCP 社区版

通过 MCP 让 AI 客户端读取和编辑嘉立创 EDA 专业版的原理图、PCB 与封装。

项目由本地 **MCP Server** 和 EDA 内的 **MCP Bridge 扩展**组成，两者需配套安装。基于 [sengbin/JLCEDA-MCP](https://github.com/sengbin/JLCEDA-MCP) 维护，非嘉立创官方插件。

[下载安装包](https://github.com/hs150521/JLCEDA-MCP-Community/releases/latest) · [安装指南](docs/native-mcp-setup.md) · [问题反馈](https://github.com/hs150521/JLCEDA-MCP-Community/issues)

## 可以做什么

- 读取原理图、PCB、网络和工程信息，检查设计与 DRC。
- 搜索器件库，放置器件，编辑图元、属性和网络连接。
- 管理图页、PCB 文档、图层与设计约束。
- 编辑独立封装并保存共享库源。
- 导出 BOM、Gerber、网表、原理图图像及设计归档。
- 查询官方 API、比较设计，并在多个 EDA 页面间选择操作目标。

## 快速开始

需要 Node.js 20+、嘉立创 EDA 专业版 3.x/4.x，以及支持本地 STDIO MCP 的 AI 客户端。具体功能受 EDA 版本限制。

1. 从同一 [Release](https://github.com/hs150521/JLCEDA-MCP-Community/releases/latest) 下载 Bridge `.eext` 和 Server `.tgz`。
2. 在 EDA 的扩展管理器中导入 `.eext`，启用扩展并允许「外部交互」。
3. 安装 Server（以 2.4.0 为例）：

   ```powershell
   npm install --global .\jlceda-mcp-server-2.4.0.tgz
   ```

4. 在 AI 客户端中添加本地 STDIO 服务，启动命令为 `jlceda-mcp`。兼容 JSON 的客户端可使用：

   ```json
   {
     "mcpServers": {
       "jlceda": {
         "command": "jlceda-mcp",
         "env": { "JLCEDA_BRIDGE_PORT": "8765" }
       }
     }
   }
   ```

5. 打开 EDA 原理图、PCB 或独立封装文档，在「MCP Bridge 社区版 → 连接设置」确认已连接。

默认地址为 `ws://127.0.0.1:8765/bridge/ws`。Token、多客户端配置及故障排查见[安装指南](docs/native-mcp-setup.md)。

## 使用注意

- 修改前保存工程，并核对活动项目和页面；多个页面可通过 `bridge_clients` / `bridge_select_client` 选择。
- 超时或连接中断不代表修改未发生。遇到 `commitUnknown` 时，按工具诊断回读并恢复，勿直接重复写入。
- `footprint_save` 修改共享库源，可能影响引用它的其他设计；页面回读成功不等于保存后的持久性验证。
- Server 仅监听本机；不要公开 Bridge Token，也不要让旧版 MCP Hub 占用同一端口。
- 普通网络标签需要 EDA v4；各功能的版本门槛和验证范围见[发布说明](https://github.com/hs150521/JLCEDA-MCP-Community/releases)。

## 开发与文档

分别在 `mcp-server` 中运行 `npm ci`、`npm test`，在 `mcp-bridge` 中运行 `npm ci`、`npm run build`。扩展包输出到 `build/`。

- [Server 配置](mcp-server/README.md) · [Bridge 使用](mcp-bridge/README.md)
- [工具参数定义](mcp-server/src/resources/mcp-tool-definitions.json)
- [Server CHANGELOG](mcp-server/CHANGELOG.md) · [Bridge CHANGELOG](mcp-bridge/CHANGELOG.md)
- [贡献政策](COMMUNITY.md) · [发布流程](docs/publishing.md)
- [隐私说明](PRIVACY.md) · [安全政策](SECURITY.md) · [Apache-2.0 许可证](LICENSE)

社区联系与安全报告：`hs150521@proton.me`。
