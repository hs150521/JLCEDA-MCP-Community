# JLCEDA MCP Community

## 2.1 development tools

- `bridge_clients` and `bridge_select_client` switch MCP routing between connected EDA page clients; they do not change the visible tab within one client. Use `api_invoke` with `eda.dmt_EditorControl.activateDocument(tabId)` for explicit in-client tab activation.

- `schematic_document_action`: inspect schematic coordinates, selected/region primitives, filters, and mouse position; navigate the view; select primitives; retrieve primitive properties/BBoxes; save or import schematic changes.
- `schematic_pages_manage`: with `confirm: true`, create, copy, rename, or completely reorder pages in a schematic. Reorder accepts every current page UUID exactly once, reuses freshly read EDA page objects, and verifies the final order; deletion is not exposed.

- `pcb_drc_check`: read-only PCB design-rule checking with structured violations.
- `pcb_net_query`: query active PCB networks with filtering and limits; exact-net primitive filters use the official `EPCB_PrimitiveType` enum.
- `schematic_drc_check`, `pcb_constraints_query`, `project_info`, and `netlist_compare`: read-only design review and project identity tools. `project_info` can optionally return bounded Board and Panel inventories.
- `eda_context` includes the detected JLCEDA/EasyEDA edition, online mode, editor version, editor build date, and current canvas data unit when exposed by the client.
- `eda_canvas_snapshot`: capture active EDA canvas metadata and, when explicitly requested, a bounded read-only MCP image for visual inspection.
- `design_source_export`: read bounded previews of the active document source or its footprint sources, with explicit opt-in for bounded complete source text.
- `design_archive_export`: retrieve metadata or explicitly requested bounded Base64 data for native current-project/current-document archives without writing files to disk.
- `library_preview` and `library_classification_query`: visually inspect symbol/footprint assets and navigate bounded official library classification trees before searching or placing parts.
- `workspace_query`: read the current workspace/team and discover accessible workspaces, teams, projects, and folders.
- `design_compare`: use official schematic/PCB/netlist comparison APIs, with version-aware errors.
- `pcb_layer_query`: inspect PCB layers and copper-layer count.
- `pcb_realtime_drc`: inspect or explicitly start/stop real-time PCB DRC.
- `pcb_document_action`: inspect PCB coordinates, selected/region primitives, filters, and canvas state; navigate the view; save the active board, import schematic changes, or import Base64 auto-layout/route files.
- `pcb_document_action` also supports PCB mouse position, explicit selection, and bounded primitive ID/type/BBox queries.
- `component_select`: supports exact device-property searches, including LCSC `supplierId`.
- `library_sources`: enumerates available system, personal, project, and favorite libraries for use with targeted searches.
- `library_search`: searches or retrieves 0.4.15 device, symbol, footprint, 3D-model, reusable-module, and panel-library assets, and searches simulation models; device searches also support exact properties and the official `lcscIds` mapping for one or more LCSC C-numbers.
- `pcb_constraints_query`: reads current rules, named rule configurations, net rules, net-to-net rules, region rules, and constraint groups.
- `manufacture_export`: generate whitelisted BOM, Gerber, netlist, pick-and-place, and related manufacturing artifacts.
- `manufacture_templates_query`: list PCB BOM templates, or schematic assembly variants, available for the active document.
- `manufacture_export`: schematic BOM exports can select an assembly variant returned by `manufacture_templates_query`.

当前开发版会拒绝空的自动布局/自动布线 UUID 选择；EDA 操作超时后仍保持串行，
直到底层 API 真正结束；网络标签修改同时支持普通标签和组件形式的电源/地标识。

社区维护的嘉立创 EDA 专业版 MCP 集成，基于
[`sengbin/JLCEDA-MCP`](https://github.com/sengbin/JLCEDA-MCP) 改进。
本项目不是嘉立创官方插件，也不代表上游维护者。

- 社区联系与安全报告：`hs150521@proton.me`
- License: Apache-2.0
- Issues: https://github.com/hs150521/JLCEDA-MCP-Community/issues

## 架构

```text
Codex / Claude / Cursor / 其他 MCP 客户端
                  | STDIO MCP
                  v
       JLCEDA MCP Server 2.2.0
                  | localhost WebSocket
                  v
       MCP Bridge 社区版 2.1.0
                  | JLCEDA Extension API
                  v
           嘉立创 EDA 专业版
```

市场中的 `.eext` 只包含 EDA Bridge；原生 MCP Server 需要从同一个 GitHub
Release 另行安装。社区版不依赖旧版 VS Code/Cursor MCP Hub。

## 安装 2.1.0

需要 Node.js 20 或更高版本。

1. 从 [Releases](https://github.com/hs150521/JLCEDA-MCP-Community/releases)
   下载并在嘉立创 EDA 扩展管理器安装
   `mcp-bridge-community-2.1.0.eext`。
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
  mcpServers: {
    jlceda: {
      command: jlceda-mcp,
      env: {
        JLCEDA_BRIDGE_PORT: 8765
      }
    }
  }
}
```

4. 打开嘉立创 EDA 原理图或 PCB 页面，Bridge 默认连接：
   `ws://127.0.0.1:8765/bridge/ws`。

生产使用建议配置随机 `JLCEDA_BRIDGE_TOKEN`。详细步骤和多客户端说明见
[Native MCP setup](docs/native-mcp-setup.md)。

## 主要工具

- 原理图语义读取与全工程审查
- 器件搜索、交互放置和坐标自动放置
- 电源/地网络标识及普通网络标签
- 原理图与 PCB 网络查询（名称、详情、精确网络读取）
- 多 EDA 页面枚举与明确选择
- 受明确确认保护的 PCB 网类、差分对、等长组与 Pad 对组约束管理
- 可选的官方 EDA API 搜索和透传调用

## 安全与已知限制

- Server 仅监听 `127.0.0.1`，Bridge Token 不得提交或公开。
- MCP 写工具可修改当前工程；执行前请保存并核对活动项目和页面。
- 不要让旧版 MCP Hub 与原生 Server 同时占用端口 8765。
- 已在嘉立创 EDA 专业版 3.2.181 上测试。
- 官方 `createNetLabel` 为 Alpha API；在 3.2.181 中普通标签创建可能超时。
  Bridge 会明确返回失败并释放队列，不会创建错误的电源网络标识。

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
