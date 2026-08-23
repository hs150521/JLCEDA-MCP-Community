# Changelog

- Clean up pending bridge requests when their MCP WebSocket disconnects, so a stale caller cannot lock `bridge_select_client` until the queue timeout.
- Reject requests tied to an EDA socket when the same page reconnects, preventing stale results from crossing connection generations.
- Preserve affected constraint items when the EDA returns differential-pair read-backs as a name-keyed object.

## 未发布

- Bridge 会在心跳超时后释放挂起请求，避免失联页面永久占用活动租约；`bridge_select_client` 新增受限的 `force` 恢复选项，用于从已确认卡死的活动页面切换到新的就绪页面。
- `component_select` 支持直接传入 LCSC C 编号，并明确区分未关联 EasyEDA 器件库的商品与普通搜索未命中。
## 2.1 development

- Add confirmation-gated `schematic_pages_manage` for page creation, copy, rename, and complete verified reordering; page deletion is intentionally excluded.
- Add bounded IPC-2581C and JRouter automatic-routing JSON manufacturing exports.
- Add read-only `simulation_model` searches with optional Ngspice/SimulIDE filtering.
- Add `schematic_document_action` for bounded schematic coordinate/region inspection, selection, primitive lookup, navigation, save, and import actions.
- Include client edition, mode, editor version, and build date in `eda_context` when supported by the runtime.
- Extend `pcb_document_action` with bounded primitive ID/type/BBox queries, mouse position, and explicit selection controls.
- Add `pcb_layer_query`, `pcb_realtime_drc`, exact `component_select.properties` search, and external route/layout import support.
- Add `manufacture_templates_query` and `manufacture_export.template` for selecting official BOM templates.
- Add `library_search` for official device, symbol, and footprint searches.
- Expand PCB constraint schema for rule configurations and structured routing-rule data.
- Add `pcb_document_action` for controlled PCB document save and external routing/layout imports.
- Add `all`, `names`, and exact `getNet` modes to PCB network queries, with optional exact-net analysis.
- Add schematic BOM assembly-variant selection to `manufacture_export`.
- Add the read-only `pcb_drc_check` MCP tool with strict checking and structured violation results.
- Add `pcb_net_query` tool definitions and synchronized routes.
- Keep PCB auto-routing controls out of the public tool list because the pinned client does not expose the methods; external route files remain supported.
- Expose official LCSC C-number mapping through `library_search`; simulation-model search is deferred because the pinned client does not expose `lib_SimulationModel`.
- Extend `pcb_document_action` with bounded primitive/selection inspection, coordinate conversion, and canvas navigation.
- Add exact UUID retrieval for device, symbol, and footprint library assets, plus bounded JSON export previews.
- Reject mixed selectors, non-exact PCB analysis, unsupported primitive filters, and missing pad-pair group names at schema validation time.

## 2.2.0 - 2026-08-23

- Add schematic DRC, PCB constraints, project info, netlist comparison, and manufacturing export tools.

## 2.1.5 - 2026-08-23

- Keep the Bridge client quarantined after an uncancellable EDA mutation times out, so later tasks cannot overlap the pending API call.
- Preserve the existing `bridge_select_client.force` recovery path for confirmed stale active clients.
- This release does not change the EDA client's component-creation implementation; it reports the timeout safely and prevents queue corruption.

## 2.1.4 - 2026-08-17

- 将校验后的 `api_invoke` 和 `eda_context` 超时值传递给 Bridge 请求。
- 收到 Bridge 的任务开始确认后才启动执行超时，并完整转发主/次 Server 的超时值。
- 增加超时参数传递的回归测试。

## 2.1.3 - 2026-08-17

- 发布面向普通用户的最小 npm 安装包，并提供 `jlceda-mcp` 命令。
- 增加社区仓库、问题反馈、Apache-2.0 许可证和安全联系方式。
- 文档改为社区版原生 MCP 架构，移除过时的上游仓库和本地路径。
- 包含原生交互放置编排、工具路由同步检查、多客户端和 Bridge Token 保护。
