# AGENTS.md

## 协作规则

- 文档中的自然语言优先使用中文；代码、命令、API 名称、协议名称、产品名和必要的专有名词可保留原文。
- 当用户要求检查仓库、Issue、PR 或其他 repo 内容时，若未特别说明，默认检查社区仓库 `hs150521/JLCEDA-MCP-Community`，不要检查 upstream `sengbin/JLCEDA-MCP`。

## 仓库结构

这是通过 MCP 协议集成 JLCEDA EDA 的双包单仓库：

- `mcp-server/` - Node.js MCP Server，通过 stdio 暴露 MCP，并承载本机 WebSocket Bridge。
- `mcp-bridge/` - JLCEDA EDA 扩展，连接 `mcp-server` 并执行 EDA 操作。
- `build/` - 打包后的 JLCEDA 扩展输出（`.eext`）。
- `tool/` - 工具脚本，包括离线 API 文档生成。

根目录没有统一构建编排，请分别在各包目录中构建。

## 构建命令

```powershell
# MCP Server
cd mcp-server
npm install
npm run build

# JLCEDA 扩展
cd ../mcp-bridge
npm install
npm run build  # produces ../build/mcp-bridge-community-{version}.eext
```

`mcp-server` produces runtime files in `mcp-server/dist/`. `mcp-bridge` uses esbuild and ts-node, then writes its EDA extension package to `build/`.

## 测试命令

```powershell
cd mcp-server
npm test
node verify-multi-client.mjs

cd ../mcp-bridge
npm run test:netlabel
npm run test:2.1
npm run typecheck
npm run lint
```

多客户端入口会运行维护中的 Bridge 协议集成测试，需要先构建 `mcp-server/dist/` 目录。

## 跨包协同

新增或修改 MCP 工具时：

1. Update `mcp-server/src/resources/mcp-tool-definitions.json`.
2. Update the server route/dispatcher in `mcp-server/src/`.
3. Update the corresponding handler and runtime route in `mcp-bridge/src/`.
4. Update relevant READMEs and CHANGELOGs in both packages and the root README.
5. Add focused schema and handler tests.

工具定义、Server 分发路由、Bridge 运行时路由和处理器行为必须保持同步。

## 手动验证

- 在 JLCEDA EDA Professional 中安装构建出的 `.eext`。
- 使用 `node mcp-server/dist/index.js` 或打包后的 `jlceda-mcp` 命令启动 MCP Server。
- 打开原理图或 PCB 页面，确认连接到 `ws://127.0.0.1:8765/bridge/ws`。
- 通过 MCP 客户端调用工具，确认活动 Bridge 客户端执行了操作。

只有原理图和 PCB 页面会建立 Bridge 连接。多个页面可以同时连接，但由活动 Bridge 客户端执行任务。

## 环境要求

- Node.js 20 或更高版本
- JLCEDA EDA Professional
