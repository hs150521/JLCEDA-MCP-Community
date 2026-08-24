# JLCEDA MCP 用户使用指南

本项目使用原生 MCP Server 架构：MCP 客户端通过 STDIO 连接 `jlceda-mcp`，服务器再通过本机 WebSocket 将请求转发给嘉立创 EDA Bridge 扩展。

旧版 VS Code/Cursor MCP Hub 和 `.vsix` 已移除，不需要安装，也不要与原生服务器同时占用同一端口。

## 安装

需要 Node.js 20 或更高版本，以及嘉立创 EDA 专业版。

1. 从 GitHub Release 下载并安装 `jlceda-mcp-server-2.2.0.tgz`：

   ```powershell
   npm install --global .\jlceda-mcp-server-2.2.0.tgz
   Get-Command jlceda-mcp
   ```

2. 在嘉立创 EDA 扩展管理器中安装本项目发布的 `mcp-bridge-community-2.1.0.eext`。

3. 打开 Bridge 设置页，确认地址为 `ws://127.0.0.1:8765/bridge/ws`。如果服务器使用 `JLCEDA_BRIDGE_TOKEN`，在地址后追加同一个 token：`ws://127.0.0.1:8765/bridge/ws?token=YOUR_RANDOM_TOKEN`。

## 配置 MCP 客户端

所有支持 STDIO MCP 的客户端都可使用同一个服务器。服务器端口和 token 必须与 Bridge 设置一致。

Codex：

```powershell
codex mcp add jlceda --env JLCEDA_BRIDGE_PORT=8765 --env JLCEDA_BRIDGE_TOKEN=YOUR_RANDOM_TOKEN -- jlceda-mcp
codex mcp list
```

通用 JSON 配置：

```json
{
  "mcpServers": {
    "jlceda": {
      "command": "jlceda-mcp",
      "env": {
        "JLCEDA_BRIDGE_PORT": "8765",
        "JLCEDA_BRIDGE_TOKEN": "YOUR_RANDOM_TOKEN"
      }
    }
  }
}
```

首次使用时，在 MCP 客户端中信任该本地服务器。修改配置后重启客户端。

## 验证连接

1. 启动 MCP 客户端配置的 `jlceda-mcp`。
2. 在嘉立创 EDA 中打开原理图或 PCB 页面。只有这两类可编辑页面会建立 Bridge 连接。
3. Bridge 设置页应显示“已连接”。
4. 多个 EDA 页面同时打开时，先调用 `bridge_clients` 查看客户端列表，再用 `bridge_select_client` 选择目标页面。
5. 发送测试请求，例如“读取当前原理图的电路信息”。

## 常见问题

### 没有可用的 EDA 客户端

确认 `jlceda-mcp` 正在运行、Bridge 地址和端口一致，并且当前 EDA 页面是原理图或 PCB。检查服务器 stderr 中是否出现 `No ready EDA client connected`。

### 修改端口后无法连接

设置 `JLCEDA_BRIDGE_PORT` 后，必须同步修改 Bridge 设置页的 WebSocket 端口，并重启 MCP 客户端。确认旧服务器没有继续占用原端口：

```powershell
Get-NetTCPConnection -LocalPort 8765 -ErrorAction SilentlyContinue
```

### 使用 token 后被拒绝

服务器环境变量 `JLCEDA_BRIDGE_TOKEN` 与 Bridge URL 的 `token` 参数必须完全一致。不要把 token 提交到日志、截图或仓库。

### 写操作超时

EDA 底层写 API 可能在特定版本中长时间不返回。Bridge 会隔离未完成的任务，避免后续请求与其并发；等待原任务结束，或在确认旧页面已卡死后使用 `bridge_select_client` 的 `force: true` 切换到健康客户端。

## 工具示例

- `schematic_read`：读取当前原理图的器件和网络连接。
- `schematic_review`：读取整个工程的原理图网表并进行审查。
- `component_select`：搜索器件候选项，确认后再放置。
- `component_place_auto`：在确认器件 UUID、库 UUID 和坐标后放置器件。
- `eda_context`：查看当前页面、项目和 EDA 版本信息。

## 相关文档

- [原生 MCP 配置](docs/native-mcp-setup.md)
- [MCP Server README](mcp-server/README.md)
- [MCP Bridge README](mcp-bridge/README.md)
- [隐私政策](PRIVACY.md)
- [安全政策](SECURITY.md)
