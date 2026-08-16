# MCP Bridge 社区版（非官方）

> 本扩展不是嘉立创官方插件，也不代表嘉立创或原项目维护者。

本扩展基于 [`sengbin/JLCEDA-MCP`](https://github.com/sengbin/JLCEDA-MCP)
项目中的 **MCP Bridge** 改进，由社区独立维护。社区版使用独立的原生 MCP
Server，通过本机 WebSocket 与嘉立创 EDA 专业版连接，不再依赖 VS Code / Cursor
侧的 MCP Hub 扩展。

主要改进包括原生 MCP 协议、多客户端页面选择、Bridge 凭据保护、语义级原理图读取、
器件放置和网络标签等工具。

链路：嘉立创 EDA -> 本机 WebSocket (Bridge) -> 原生 MCP Server -> MCP 客户端。

- 社区仓库：https://github.com/hs150521/JLCEDA-MCP-Community
- 上游项目：https://github.com/sengbin/JLCEDA-MCP
- 社区联系邮箱：yuanzl150521@gmail.com

![演示动画](images/demo.gif)

内置专用工具：

**基础工具**

- `schematic_read`：读取当前原理图页面的完整电路语义快照，包含器件列表、引脚网络连接关系与 DRC 检查结果。
- `schematic_review`：读取全工程所有原理图页面的网表文件，覆盖多页电路，适合全局审查、BOM 核查与跨页信号追踪。
- `component_select`：搜索器件候选项并返回确认结果。
- `component_place`：引导放置已确认的器件列表。
- `netlabel_place`：电源/地网络创建对应网络标识，其他信号创建普通网络标签。

**透传 EDA API 工具（可选，需在服务端侧边栏开启）**

- `api_index`：列出所有可用的 EDA API 模块名称。
- `api_search`：按关键词搜索具体 API 方法及参数说明。
- `eda_context`：读取当前 EDA 页面的上下文信息。
- `api_invoke`：直接调用任意 EDA API 并返回结果。

## 安装

**服务端**和**客户端**两个扩展都需要安装。

> 初次安装时，先确认 VS Code/Cursor 与嘉立创 EDA 两侧扩展都已安装，再检查聊天工具的 MCP 服务配置是否正确。

### 客户端（嘉立创 EDA）

**从扩展管理器安装（推荐）：**

1. 打开嘉立创 EDA，进入扩展管理器。
2. 搜索"MCP Bridge"并安装。

### 服务端（VS Code / Cursor）

服务端文档：[MCP Hub README](https://github.com/sengbin/JLCEDA-MCP/blob/main/mcp-hub/README.md)

**从扩展商店安装（推荐）：**

打开 VS Code 或 Cursor 扩展视图，搜索“JLCEDA MCP”并安装。

- VS Code 扩展商店：https://marketplace.visualstudio.com/items?itemName=chengbin.jlceda-mcp-hub
- Cursor（Open VSX）：https://open-vsx.org/extension/chengbin/jlceda-mcp-hub

## 状态说明

连接设置页面展示两行状态，每秒自动刷新：

- **第一行（桥接状态）**：活动页面显示"已连接"；待命页面显示"当前活动客户端：xxx"；连接失败显示"连接失败"。
- **第二行（WebSocket 状态）**：正在连接时显示"连接中"；连接成功后显示"当前客户端：xxx"；连接失败时显示具体错误原因。

仅在原理图或 PCB 页面可连接，连接失败后系统会自动重试。

## 交互说明

1. 当 AI 需要用户确认具体器件型号时，VS Code / Cursor 侧会弹出器件选型面板，确认后流程继续。
2. 当 AI 需要用户在原理图中实际放置器件时，VS Code / Cursor 侧会弹出交互放置面板，提示当前应放置的器件。
3. 在选型或放置过程中点击取消，只会跳过当前器件，不会让整个任务中断。
4. 电源符号和地符号需要用户手动添加，AI 不会自动放置这类符号。
5. 如果服务端启用了“打开 EDA 时关闭侧边栏”，那么打开 EDA 后，以及器件选型或放置完成后，VS Code / Cursor 侧边栏会自动收起。

## 注意事项

1. 客户端与服务端必须同时安装。
2. 如果修改了服务端监听端口，需要在 MCP Bridge 设置页同步更新地址。
3. 多页面并行时，只有活动角色页面执行任务，待命页面属于正常状态。若当前页面与活动客户端不一致，请关闭其他 EDA 页面并刷新当前页。
4. 电源符号和地符号需要用户手动放置。
5. 状态异常时优先重启嘉立创 EDA 与 VS Code/Cursor。

## 常见问题

### 聊天里看不到工具怎么办？

请在聊天客户端确认该 MCP 服务已被信任，并检查工具开关是否开启。

### AI 读不到当前图纸内容怎么办？

EDA 页面可能未桥接成功，请回到连接设置页确认连接状态是否正常。

### 保存地址后仍无法连接？

请确认服务端扩展已安装并运行，连接地址与侧边栏显示值完全一致。

## 许可证

本扩展采用 [Apache License 2.0](LICENSE) 许可证。
