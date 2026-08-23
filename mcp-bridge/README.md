# MCP Bridge 社区版

## 2.1 PCB tools

The 2.1 release adds `pcb_drc_check`, `schematic_drc_check`, `pcb_net_query`, `pcb_constraints_query`, `pcb_layer_query`, `pcb_realtime_drc`, `pcb_document_action`, `project_info`, `netlist_compare`, `design_compare`, `manufacture_export`, read-only `manufacture_templates_query`, and `library_search`. Network queries support full details, name-only lists, and exact official `getNet` lookup. `component_select` and `library_search` support exact 0.4.15 property searches; `library_search` also exposes official single/batch LCSC C-number mapping and simulation-model search. BOM exports can select a template returned by `manufacture_templates_query`; `pcb_constraints_query` exposes structured rule data and constraint groups. `pcb_document_action` accepts Base64 JSON/SES imports and reports active calculation state. PCB auto-layout/auto-routing are intentionally not advertised because those methods are absent from the pinned 0.4.15 PCB API surface.

当前开发版会拒绝显式传入的空 UUID 选择；EDA 操作超时后仍保持修改队列锁定，
直到底层 Promise 真正结束；网络标签修改同时支持普通标签和电源/地网络标识。

> 本扩展不是嘉立创官方插件，也不代表嘉立创或原项目维护者。

本扩展基于 [`sengbin/JLCEDA-MCP`](https://github.com/sengbin/JLCEDA-MCP)
项目中的 **MCP Bridge** 改进，由社区独立维护。社区版使用独立的原生 MCP
Server，通过本机 WebSocket 与嘉立创 EDA 专业版连接，不再依赖 VS Code / Cursor
侧的 MCP Hub 扩展。

主要改进包括原生 MCP 协议、多客户端页面选择、Bridge 凭据保护、语义级原理图读取、
器件放置和网络标签等工具。

当活动页面任务已确认卡死时，MCP 客户端可通过 `bridge_select_client` 的 `force: true`
切换到新的就绪页面。切换会使旧租约的未开始任务失效，但不会取消已经在 EDA 内执行的 API 调用。

## 功能演示

![MCP Bridge 功能演示：原理图读取、器件放置和网络标签修改](images/feature-demo.png)

上图展示 Bridge 已连接时的典型工作流：MCP 客户端读取原理图、放置器件并修改网络标签，
嘉立创 EDA 页面负责执行和呈现对应操作。图片为功能流程示意，实际界面以当前 EDA 版本为准。

链路：嘉立创 EDA -> 本机 WebSocket (Bridge) -> 原生 MCP Server -> MCP 客户端。

- 社区仓库：https://github.com/hs150521/JLCEDA-MCP-Community
- 上游项目：https://github.com/sengbin/JLCEDA-MCP
- 社区联系邮箱：hs150521@proton.me

内置专用工具：

**基础工具**

- `schematic_read`：读取当前原理图页面的完整电路语义快照，包含器件列表、引脚网络连接关系与 DRC 检查结果。
- `schematic_review`：读取全工程所有原理图页面的网表文件，覆盖多页电路，适合全局审查、BOM 核查与跨页信号追踪。
- `component_select`：搜索器件候选项并返回确认结果；可直接输入 LCSC C 编号以查询已关联的 EasyEDA 器件。
- `component_place`：引导放置已确认的器件列表。
- `netlabel_place`：电源/地网络创建对应网络标识，其他信号创建普通网络标签。

**透传 EDA API 工具（可选，需在服务端侧边栏开启）**

- `api_index`：列出所有可用的 EDA API 模块名称。
- `api_search`：按关键词搜索具体 API 方法及参数说明。
- `eda_context`：读取当前 EDA 页面的上下文信息。
- `api_invoke`：直接调用任意 EDA API 并返回结果。

## 安装

必须同时安装 EDA Bridge 和原生 JLCEDA MCP Server。本社区版不依赖旧版 MCP Hub。

### 1. EDA Bridge

在嘉立创 EDA 专业版扩展管理器中安装“MCP Bridge 社区版”，重启 EDA，然后打开原理图或 PCB 页面。

### 2. 原生 MCP Server

从同一 Release 下载匹配的 `jlceda-mcp-server-2.2.0.tgz`，执行：

```powershell
npm install --global .\jlceda-mcp-server-2.2.0.tgz
```

安装后的命令为 `jlceda-mcp`。源码构建及其他客户端配置见[原生 MCP 安装说明](https://github.com/hs150521/JLCEDA-MCP-Community/blob/main/docs/native-mcp-setup.md)。

Codex 可运行：

```powershell
codex mcp add jlceda --env JLCEDA_BRIDGE_PORT=8765 -- jlceda-mcp
```

Claude Desktop、Claude Code、Cursor 等客户端应将 `jlceda-mcp` 注册为本地 STDIO MCP Server。

### 3. Bridge 地址

默认地址为 `ws://127.0.0.1:8765/bridge/ws`。若设置 `JLCEDA_BRIDGE_TOKEN`，EDA 设置页地址必须携带同一个 token。不要公开 token 或包含 token 的截图。

## 安全、兼容性与已知限制

- Server 仅监听 `127.0.0.1`；推荐配置 Bridge Token。
- MCP 工具能够修改当前工程。操作前请保存工程，并审查 AI 提议的写操作。
- `api_invoke` 是可选的 API 透传能力，只应在信任的 MCP 客户端中启用。
- 已在嘉立创 EDA 专业版 3.2.181 上测试；其他 3.x 版本需自行验证。
- `createNetLabel` 属于 Alpha API；3.2.181 中普通网络标签创建可能超时。Bridge 会明确报告失败并释放任务队列。
- 扩展只在原理图或 PCB 页面建立 Bridge 连接。

## 状态说明

连接设置页面展示两行状态，每秒自动刷新：

- **第一行（桥接状态）**：活动页面显示"已连接"；待命页面显示"当前活动客户端：xxx"；连接失败显示"连接失败"。
- **第二行（WebSocket 状态）**：正在连接时显示"连接中"；连接成功后显示"当前客户端：xxx"；连接失败时显示具体错误原因。

仅在原理图或 PCB 页面可连接，连接失败后系统会自动重试。

## 交互与注意事项

1. 写操作前保存工程，并确认活动项目和页面正确。
2. `component_place` 会启动 EDA 内的交互放置；`component_place_auto` 才会按坐标直接创建。
3. 多个 EDA 页面同时连接时，应先枚举客户端并明确选择目标页面。
4. 修改端口或 token 后，必须同步更新 MCP Server 环境变量与 Bridge 地址。
5. 普通网络标签创建失败时不要改用电源网络标识代替；请查看 Bridge 调试日志。
6. 状态异常时先关闭旧版 MCP Hub，再重启 AI 客户端与 EDA Bridge。
## 常见问题

### 聊天里看不到工具怎么办？

请在聊天客户端确认该 MCP 服务已被信任，并检查工具开关是否开启。

### AI 读不到当前图纸内容怎么办？

EDA 页面可能未桥接成功，请回到连接设置页确认连接状态是否正常。

### 保存地址后仍无法连接？

请确认原生 MCP Server 已安装并由 AI 客户端启动，且端口、token 与 Bridge 地址一致。

## 许可证

本扩展采用 [Apache License 2.0](LICENSE) 许可证。
数据处理说明见 [PRIVACY.md](PRIVACY.md)。
