# Changelog

## 未发布

- Bridge 会在心跳超时后释放挂起请求，避免失联页面永久占用活动租约；`bridge_select_client` 新增受限的 `force` 恢复选项，用于从已确认卡死的活动页面切换到新的就绪页面。
- `component_select` 支持直接传入 LCSC C 编号，并明确区分未关联 EasyEDA 器件库的商品与普通搜索未命中。
## 2.1 development

- Add the read-only `pcb_drc_check` MCP tool with strict checking and structured violation results.

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
