# JLCEDA MCP Server

MCP Bridge 社区版配套的本地 Server：通过 STDIO 连接 AI 客户端，通过本机 WebSocket 连接嘉立创 EDA 扩展，提供设计读取、编辑、器件搜索、检查与导出工具。

基于 [sengbin/JLCEDA-MCP](https://github.com/sengbin/JLCEDA-MCP) 维护，非嘉立创官方插件。

## 安装

需要 Node.js 20+、嘉立创 EDA 专业版 3.x/4.x，以及同一 Release 中的 Bridge 扩展。

从[发布页](https://github.com/hs150521/JLCEDA-MCP-Community/releases/latest)下载 `.tgz`，在下载目录安装（以 2.4.0 为例）：

```powershell
npm install --global .\jlceda-mcp-server-2.4.0.tgz
Get-Command jlceda-mcp
```

## 配置

在 AI 客户端中添加本地 STDIO MCP 服务。兼容 JSON 的客户端示例：

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

EDA Bridge 默认连接 `ws://127.0.0.1:8765/bridge/ws`；扩展需启用「外部交互」权限，并打开原理图、PCB 或独立封装文档。

| 环境变量 | 用途 |
| --- | --- |
| `JLCEDA_BRIDGE_PORT` | 本机 Bridge 端口，默认 `8765` |
| `JLCEDA_BRIDGE_TOKEN` | 可选认证凭据；设置后须与 Bridge 连接设置一致 |

升级 Server 后重启或重连 MCP 客户端。各客户端配置、Token 和多客户端说明见[安装指南](https://github.com/hs150521/JLCEDA-MCP-Community/blob/main/docs/native-mcp-setup.md)。

## 使用与排查

- 先用 `bridge_clients` 检查连接及活动页面；多个页面可用 `bridge_select_client` 选择。
- 工具支持原理图、PCB 和封装读写，器件库查询、DRC、设计比较及制造文件导出。参数见[工具定义](https://github.com/hs150521/JLCEDA-MCP-Community/blob/main/mcp-server/src/resources/mcp-tool-definitions.json)。
- 无法连接时，检查 Server 是否启动、端口是否被旧版 MCP Hub 占用，以及两端 Token 是否一致。
- 写入前保存设计并核对目标。返回 `commitUnknown` 时，按诊断使用 `bridge_recover_client`，不要直接重试；强制切换客户端不能取消 EDA 中已运行的操作。
- Server 仅监听 `127.0.0.1`。不要公开 Token；API 透传仅供受信任的客户端使用。

## 开发与支持

在本目录运行 `npm ci`、`npm test`；多客户端测试运行 `node verify-multi-client.mjs`，代码检查运行 `npm run lint`。

[CHANGELOG](https://github.com/hs150521/JLCEDA-MCP-Community/blob/main/mcp-server/CHANGELOG.md) · [发布与验证范围](https://github.com/hs150521/JLCEDA-MCP-Community/releases) · [问题反馈](https://github.com/hs150521/JLCEDA-MCP-Community/issues) · [隐私说明](https://github.com/hs150521/JLCEDA-MCP-Community/blob/main/mcp-server/PRIVACY.md)

Apache-2.0 许可证。社区联系与安全报告：`hs150521@proton.me`。
