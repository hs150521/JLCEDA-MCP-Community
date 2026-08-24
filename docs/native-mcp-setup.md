# 原生 MCP 安装

本文适用于社区的 native-mcp-v2 分支。

## 1. 安装 Server

需要 Node.js 20 或更高版本。从对应的 GitHub Release 下载 jlceda-mcp-server-2.2.0.tgz，然后执行：

```powershell
npm install --global .\jlceda-mcp-server-2.2.0.tgz
Get-Command jlceda-mcp
```

安装后的 STDIO 命令为 jlceda-mcp。

### 从源码构建

```powershell
cd mcp-server
npm ci
npm test
```

构建过程会将运行时资源复制到 dist/resources。不要使用未执行上述步骤生成的旧 dist 目录。

## 2. 创建 Bridge Token

请使用至少 32 字节的随机值。PowerShell 示例：

```powershell
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
[Convert]::ToBase64String($bytes)
```

请妥善保管输出值。所有需要共享本地 EDA Bridge 的 MCP 客户端都使用同一个值。

## 3. 配置 MCP 客户端

将 jlceda-mcp 配置为本地 STDIO Server，并在每个客户端使用相同的端口和 token。

### Codex

```powershell
codex mcp add jlceda --env JLCEDA_BRIDGE_PORT=8765 --env JLCEDA_BRIDGE_TOKEN=replace-with-your-random-token -- jlceda-mcp
codex mcp list
```

Codex 将 MCP 配置保存到 ~/.codex/config.toml，桌面应用、命令行和 IDE 扩展共享该配置。修改 Server 后请重启 Codex 客户端。参见官方 Codex MCP 文档：https://developers.openai.com/codex/mcp/。

### Claude Desktop 和兼容 JSON 的客户端

```json
{
  "mcpServers": {
    "jlceda": {
      "command": "jlceda-mcp",
      "env": {
        "JLCEDA_BRIDGE_PORT": "8765",
        "JLCEDA_BRIDGE_TOKEN": "replace-with-your-random-token"
      }
    }
  }
}
```

Server 只绑定 127.0.0.1。第一个 MCP 进程拥有 WebSocket 监听器，后续进程通过已认证的 /mcp-internal 路由连接。

## 4. 配置 EDA 扩展

打开扩展设置页面并保存：

```text
ws://127.0.0.1:8765/bridge/ws?token=replace-with-your-random-token
```

设置页面会显示已配置地址；该页面截图应视为敏感信息。运行时 Bridge 日志会隐藏 token。

## 5. 避免混用架构

不要让旧版 MCP Hub 和原生 MCP Server 使用同一个端口。测试前请停止旧 MCP 进程或改用不同端口。占用 8765 但未实现 /mcp-internal 的进程会导致其他原生 MCP 会话无法启动。

## 6. 选择 EDA 目标

同时打开多个可编辑 JLCEDA 页面时，在任何 EDA 操作前调用 bridge_clients。根据返回的工程和页面身份信息确认目标，再将准确的 clientId 传给 bridge_select_client。身份字段来自官方 JLCEDA 上下文 API，并会在活动编辑器标签页变化时刷新。

Server 会拒绝未知或未就绪客户端；当前活动页面存在未完成请求时也不会切换目标。

## 7. 协议支持

Server 使用官方 MCP TypeScript Server SDK 2.x：

- 2024/2025 客户端使用旧版 initialize 生命周期；
- 2026-07-28 客户端使用 server/discover 和按请求传递的 _meta 信封。

两条路径均有自动化冒烟测试。

