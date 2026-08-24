# AGENTS.md

## 协作规则

- 文档中的自然语言优先使用中文；代码、命令、API 名称、协议名称、产品名和必要的专有名词可保留原文。
- 当用户要求检查仓库、Issue、PR 或其他 repo 内容时，若未特别说明，默认检查社区仓库 `hs150521/JLCEDA-MCP-Community`，不要检查 upstream `sengbin/JLCEDA-MCP`。
- 使用 `gh` 发送 Issue、PR 描述或评论前，先验证 Markdown 格式，尤其是换行符、代码块和列表，确保不会把转义字符或明文换行符直接显示给读者。

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
npm run build  # 生成 ../build/mcp-bridge-community-{version}.eext
```

`mcp-server` 会在 `mcp-server/dist/` 生成运行时文件。`mcp-bridge` 使用 esbuild 和 ts-node，然后将 EDA 扩展包写入 `build/`。

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

1. 更新 `mcp-server/src/resources/mcp-tool-definitions.json`。
2. 更新 `mcp-server/src/` 中的 Server 路由/分发器。
3. 更新 `mcp-bridge/src/` 中对应的处理器和运行时路由。
4. 更新两个包中的相关 README、CHANGELOG 以及根目录 README。
5. 增加针对性的架构和处理器测试。

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

## Code Review 审计流程

当用户要求审计 PR、分支或最近改动，且明确只能进行静态 review 时，按以下流程执行：

1. 确认实际 Git worktree、当前分支、工作树状态和审计基线；默认审阅当前分支相对 `origin/main` 的完整 diff。不得覆盖或回滚用户已有改动。
2. 按提交和模块读取新增代码，至少覆盖工具定义、Server 分发器、Bridge 路由、处理器、协议、状态机和相关测试脚本；检查跨包契约是否同步。
3. 先审查高风险行为：写操作确认、超时与不可取消 Promise、重连/恢复、客户端选择、权限边界、身份校验、并发竞态、资源/结果上限和输入校验。
4. 对新增状态机逐条追踪正常、失败、超时、断连、重连、重复调用和恢复路径；确认失败后不会错误放行写操作，也不会永久阻塞无恢复手段。
5. 对新增工具核对 JSON schema、Server path map、Bridge handler map、超时策略和实际 handler 行为，特别检查“声明只读但实际可写”以及默认值/枚举不一致。
6. 只做静态验证（代码阅读、`rg`、`git diff --check` 等）；用户明确不能测试时不运行构建、测试或 EDA 手动验证，并在结论中说明验证边界。
7. 报告只列出可复现或有明确代码证据的问题，按严重性排序，使用绝对文件链接和单行定位；每条说明触发条件、实际影响和涉及的契约。最后简述未执行的验证和剩余风险。
