# JLCEDA MCP Server

## 2.3.0

本版本使用共享 Bridge 路由清单，增加内部请求超时、重复 requestId 检查、消息大小限制和有限 pending 队列。`JLCEDA_BRIDGE_TOKEN` 仍为可选配置。

`bridge_clients` 和 `bridge_select_client` 用于在已连接的 EDA 页面客户端之间切换 MCP 路由，不会切换同一个 EDA 进程中的可见标签页。如需在进程内切换标签页，请通过 `api_invoke` 调用 `eda.dmt_EditorControl.activateDocument(tabId)`。

`bridge_recover_client` 用于不可取消 EDA 修改超时后的受控恢复：先显式确认并请求新的 Bridge generation，再用新 `clientId` 做文档身份校验和只读回读；回读完成前，EDA 写操作都会被阻止，但普通只读查询仍可执行。`schematic_layout_check` 只有默认检查模式是只读，`mode: "fix"` 会按写操作隔离。

恢复时必须从 `bridge_clients` 选择具体超时写操作的 `requestId`；`readbackPath` 与 `readbackPayload` 始终只能描述只读操作，恢复目标客户端在首次回读后锁定。多个未解决的超时写操作会继续保持写阻断，直到各自收到迟到结果或完成受控恢复；未确认完成的写诊断不会因 TTL 自动放行写入。

Bridge 客户端超时会返回带 `BRIDGE_TASK_TIMEOUT` 标记的结果；Server 会将该结果纳入同一受控恢复诊断流程，不要求必须等 Server 自身的备用计时器触发。

## 2.1 开发工具

`schematic_layout_check` 对当前原理图执行保守的符号/引脚/属性/导线矩形碰撞检查，并显式报告属性几何和页面边界能力是否可用。修复模式需要 `confirm: true`，只移动属性文本，不改变电气连接。

Server 提供 `schematic_document_action`，用于受限地检查原理图坐标、选中对象、区域图元、过滤器和鼠标位置，并执行视图导航、图元选择、属性读取、保存和变更导入。

`schematic_pages_manage` 只有在 `confirm: true` 时才会创建、复制、重命名或完整重排页面。重排必须提供每个页面 UUID，Bridge 会重新读取页面对象并验证最终顺序；不提供删除功能。

`eda_context` 在客户端支持时返回客户端版本、连接模式、编辑器版本、编译日期和当前画布数据单位。`eda_canvas_snapshot` 可在不改变文档或视图的情况下返回受限的画布图像。

`workspace_query` 查询当前工作区、团队以及受限的工程和文件夹列表。`design_source_export` 和 `design_archive_export` 分别读取受限的源文件预览和原生设计归档元数据；完整文本或 Base64 数据都需要明确授权并受大小限制。

`library_preview` 可生成符号/封装预览图，`library_classification_query` 可浏览官方库分类树。`project_info` 可选返回受限的 Board 和 Panel 清单。

Server 提供 PCB DRC、网络查询、库搜索、制造查询和受保护的文档操作。设备 `library_search` 支持 0.4.15 精确属性、官方单个/批量 LCSC C 编号映射和精确 UUID 获取；符号、封装、3D 模型、可复用模块和 Panel 库使用各自支持的 API。仿真模型搜索支持 Ngspice/SimulIDE 过滤，但官方模型读取 API 需要私有部署，因此不公开。制造导出包含官方飞针测试文件，PCB 自动布局/自动布线在目标客户端公开对应 API 前保持暂停。

`pcb_constraints_manage` 是受确认保护的写入工具，用于网类、差分对、等长组和 Pad 对组的窄范围修改，并返回受影响项目的读取验证；不支持批量替换规则配置。

公开的 `timeoutMs` 参数会传递到 WebSocket 请求。EDA 修改超时后，Bridge 会隔离未完成的任务，避免后续请求并发修改；请求排队时间不计入 API 执行超时。

本软件包是 **MCP Bridge 社区版**配套的原生 Model Context Protocol Server，通过 STDIO 与 Codex、Claude、Cursor 等 MCP 客户端通信，再通过仅监听本机的 WebSocket 与嘉立创 EDA 专业版扩展通信。

> 社区维护项目，基于 `sengbin/JLCEDA-MCP` 改进；不是嘉立创官方插件。

## 要求

- Node.js 20 或更高版本
- 嘉立创 EDA 专业版 3.x
- 已安装匹配发布版本中的 MCP Bridge 社区版 `.eext`

## 安装

从 GitHub 发布页下载 `jlceda-mcp-server-2.2.2.tgz`：

```powershell
npm install --global .\jlceda-mcp-server-2.2.2.tgz
Get-Command jlceda-mcp
```

## 配置

默认端口为 `8765`。建议生成随机 Bridge Token，并在 MCP 客户端与 EDA Bridge 设置页使用相同值。

Codex：

```powershell
codex mcp add jlceda --env JLCEDA_BRIDGE_PORT=8765 --env JLCEDA_BRIDGE_TOKEN=YOUR_RANDOM_TOKEN -- jlceda-mcp
codex mcp list
```

通用 JSON 客户端：

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

完整安装、多客户端选择和故障排查说明见[原生 MCP 安装说明](https://github.com/hs150521/JLCEDA-MCP-Community/blob/main/docs/native-mcp-setup.md)。

当 `bridge_clients` 显示活动页面任务卡死且另一个页面已就绪时，可使用 `bridge_select_client` 并设置 `force: true` 进行恢复。该选项会取消 Server 对旧页面任务的等待并切换租约，但不能取消已经在 EDA 内运行的 API 调用。

## 支持与许可证

- Issue：<https://github.com/hs150521/JLCEDA-MCP-Community/issues>
- 安全报告与联系邮箱：`hs150521@proton.me`
- 隐私政策：[PRIVACY.md](PRIVACY.md)
- 许可证：Apache-2.0
