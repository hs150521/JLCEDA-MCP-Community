# JLCEDA MCP 社区版

## 2.1 开发工具

- `bridge_clients` 和 `bridge_select_client` 用于在已连接的 EDA 页面客户端之间切换 MCP 路由；它们不会切换同一个 EDA 进程中的可见标签页。如需在进程内切换标签页，请通过 `api_invoke` 调用 `eda.dmt_EditorControl.activateDocument(tabId)`。
- `schematic_document_action`：检查原理图坐标、选中对象、区域图元、过滤器和鼠标位置；执行视图导航、图元选择、图元属性/BBox 读取、保存和变更导入。
- `schematic_pages_manage`：在 `confirm: true` 时创建、复制、重命名或完整重排原理图页面。重排必须提供每个当前页面 UUID，Bridge 会重新读取并验证结果；不提供删除功能。
- `pcb_drc_check`：读取 PCB 设计规则检查结果。
- `pcb_net_query`：按条件和数量限制查询当前 PCB 网络；精确网络图元过滤使用官方 `EPCB_PrimitiveType` 枚举。
- `schematic_drc_check`、`pcb_constraints_query`、`project_info` 和 `netlist_compare`：提供设计审查和工程身份信息；`project_info` 可选返回受限的 Board 和 Panel 清单。
- `eda_context`：在客户端支持时返回 JLCEDA/EasyEDA 版本、在线模式、编辑器版本、编译日期和当前画布数据单位。
- `eda_canvas_snapshot`：读取当前画布元数据，并可在明确请求时返回受限的只读 MCP 图像。
- `design_source_export`：读取当前文档或封装源文件的受限预览；完整源文本需要明确授权且受字节数限制。
- `design_archive_export`：读取原生当前工程/当前文档归档的元数据；只有明确请求时才返回受限的 Base64 数据，不写入文件。
- `library_preview` 和 `library_classification_query`：预览符号/封装资源并浏览受限的官方库分类树。
- `workspace_query`：查询当前工作区、团队、工程和文件夹，并发现可访问的资源。
- `design_compare`：调用官方原理图、PCB 和网表比较 API，并返回版本相关错误。
- `pcb_layer_query`：读取 PCB 层和铜层数量。
- `pcb_realtime_drc`：读取或明确启停 PCB 实时 DRC。
- `pcb_document_action`：读取 PCB 坐标、选中图元、区域图元、过滤器和画布状态；执行视图导航、保存、变更导入以及 Base64 自动布局/布线文件导入。
- `component_select`：支持精确器件属性查询，包括 LCSC `supplierId`。
- `library_sources`：列出系统、个人、工程和收藏库。
- `library_search`：搜索或读取 0.4.15 设备、符号、封装、3D 模型、可复用模块和 Panel 库资源，也支持仿真模型搜索；设备搜索支持精确属性和官方 LCSC C 编号映射。
- `pcb_constraints_query`：读取当前规则、规则配置、网络规则、区域规则和约束组。
- `manufacture_export`：生成受限的 BOM、Gerber、网表、贴片坐标等制造文件。
- `manufacture_templates_query`：列出 PCB BOM 模板或原理图装配变体；`manufacture_export` 可使用返回的装配变体。

当前开发版会拒绝空的自动布局/自动布线 UUID；EDA 操作超时后仍保持串行，直到底层 API 真正结束；网络标签修改同时支持普通标签和组件形式的电源/地标识。

社区维护的嘉立创 EDA 专业版 MCP 集成基于 [`sengbin/JLCEDA-MCP`](https://github.com/sengbin/JLCEDA-MCP) 改进。本项目不是嘉立创官方插件，也不代表上游维护者。

- 社区联系与安全报告：`hs150521@proton.me`
- 许可证：Apache-2.0
- Issue：<https://github.com/hs150521/JLCEDA-MCP-Community/issues>

## 架构

```text
Codex / Claude / Cursor / 其他 MCP 客户端
                  | STDIO MCP
                  v
       JLCEDA MCP Server 2.2.0
                  | 本机 WebSocket
                  v
       MCP Bridge 社区版 2.1.1
                  | JLCEDA 扩展 API
                  v
           嘉立创 EDA 专业版
```

市场中的 `.eext` 只包含 EDA Bridge；原生 MCP Server 需要从同一个 GitHub Release 另行安装。社区版不依赖旧版 VS Code/Cursor MCP Hub。

## 安装 2.1.1

需要 Node.js 20 或更高版本。

1. 从 [发布页](https://github.com/hs150521/JLCEDA-MCP-Community/releases) 下载并在嘉立创 EDA 扩展管理器中安装 `mcp-bridge-community-2.1.1.eext`。
2. 下载 MCP Server 包并安装：

   ```powershell
   npm install --global .\jlceda-mcp-server-2.2.0.tgz
   Get-Command jlceda-mcp
   ```

3. 将 `jlceda-mcp` 配置为 AI 客户端的本地 STDIO MCP Server。

Codex：

```powershell
codex mcp add jlceda --env JLCEDA_BRIDGE_PORT=8765 -- jlceda-mcp
codex mcp list
```

通用 JSON 客户端：

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

4. 打开嘉立创 EDA 原理图或 PCB 页面，Bridge 默认连接 `ws://127.0.0.1:8765/bridge/ws`。

生产使用建议配置随机 `JLCEDA_BRIDGE_TOKEN`。详细步骤和多客户端说明见[原生 MCP 安装说明](docs/native-mcp-setup.md)。

## 主要工具

- 原理图语义读取与全工程审查
- 器件搜索、交互放置和坐标自动放置
- 电源/地网络标识及普通网络标签
- 原理图与 PCB 网络查询
- 多 EDA 页面枚举与明确选择
- 受明确确认保护的 PCB 网类、差分对、等长组与 Pad 对组约束管理
- 可选的官方 EDA API 搜索和透传调用

## 安全与已知限制

- Server 仅监听 `127.0.0.1`，Bridge Token 不得提交或公开。
- MCP 写工具可修改当前工程；执行前请保存并核对活动项目和页面。
- 不要让旧版 MCP Hub 与原生 Server 同时占用端口 8765。
- 已在嘉立创 EDA 专业版 3.2.181 上测试。
- 官方 `createNetLabel` 为 Alpha API；在 3.2.181 中普通标签创建可能超时。Bridge 会明确返回失败并释放队列。

## 开发与发布

```powershell
cd mcp-server
npm ci
npm test

cd ..\mcp-bridge
npm ci
npm run build
```

- [贡献与维护政策](COMMUNITY.md)
- [安全政策](SECURITY.md)
- [隐私与本地数据流](PRIVACY.md)
- [发布检查表](docs/publishing.md)
- [嘉立创扩展广场发布要求](https://prodocs.lceda.cn/cn/api/guide/extensions-marketplace.html)
- [OpenAI Codex MCP 配置](https://developers.openai.com/codex/mcp/)
