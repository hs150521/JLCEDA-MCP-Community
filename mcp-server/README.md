# JLCEDA MCP Server

公开的 `timeoutMs` 参数会传递到 WebSocket 请求。EDA 修改超时后，Bridge 仍会
保持串行队列锁定，直到底层 API 真正结束；请求排队时间不计入 API 执行超时。

本软件包是 **MCP Bridge 社区版**配套的原生 Model Context Protocol Server。
它通过 STDIO 与 Codex、Claude、Cursor 等 MCP 客户端通信，并通过仅监听本机的
WebSocket 与嘉立创 EDA 专业版扩展通信。

> 社区维护项目，基于 `sengbin/JLCEDA-MCP` 改进；不是嘉立创官方插件。

## 要求

- Node.js 20 或更高版本
- 嘉立创 EDA 专业版 3.x
- 已安装匹配 Release 中的 MCP Bridge 社区版 `.eext`

## 安装

从 GitHub Release 下载 `jlceda-mcp-server-2.1.3.tgz`：

```powershell
npm install --global .\jlceda-mcp-server-2.1.3.tgz
Get-Command jlceda-mcp
```

## 配置

默认端口为 `8765`。强烈建议生成随机 Bridge Token，并在 MCP 客户端与 EDA
Bridge 设置页中使用相同值。

Codex：

```powershell
codex mcp add jlceda --env JLCEDA_BRIDGE_PORT=8765 --env JLCEDA_BRIDGE_TOKEN=YOUR_RANDOM_TOKEN -- jlceda-mcp
codex mcp list
```

通用 JSON 客户端：

```json
{
  mcpServers: {
    jlceda: {
      command: jlceda-mcp,
      env: {
        JLCEDA_BRIDGE_PORT: 8765,
        JLCEDA_BRIDGE_TOKEN: YOUR_RANDOM_TOKEN
      }
    }
  }
}
```

EDA Bridge 地址：

```text
ws://127.0.0.1:8765/bridge/ws?token=YOUR_RANDOM_TOKEN
```

不要同时运行旧版 MCP Hub 和本 Server；它们占用同一端口时会导致启动或握手失败。

## 安全

- Server 仅绑定 `127.0.0.1`，不会主动监听局域网接口。
- Token 属于本地 Bridge 凭据，不应提交到仓库或出现在截图、日志和 Issue 中。
- 工具可修改当前 EDA 工程；使用写工具前请保存工程并检查目标页面。
- API 透传工具是可选功能，仅应在受信任的 MCP 客户端中启用。

完整安装、多客户端选择和故障排查说明：
[docs/native-mcp-setup.md](https://github.com/hs150521/JLCEDA-MCP-Community/blob/main/docs/native-mcp-setup.md)

## 支持与许可证

- Issues: https://github.com/hs150521/JLCEDA-MCP-Community/issues
- 安全报告与联系邮箱：hs150521@proton.me
- Privacy: [PRIVACY.md](PRIVACY.md)
- License: Apache-2.0
