# 更新日志

## 未发布

- 新增 `bridge_recover_client` 的受控恢复流程：保留超时写操作诊断，要求显式确认、新的 Bridge 运行时、文档身份校验和只读回读；在确认前继续阻止写入并提示修改可能已完成。
- 修复恢复边界：`schematic_layout_check mode=fix` 被识别为写操作；断开客户端后仍保留恢复会话；多个超时修改分别保留诊断；恢复期间允许只读请求；领域 readback 会额外校验 `context` 身份快照。

## 2.2.1 - 2026-08-24

- 新增 `schematic_layout_check`，提供原理图符号、引脚、属性文本、网络标签和导线的保守几何重叠检查、密集区域报告及确认保护的属性文本修复。

- 发布与 Bridge 2.1.2 配套的 Server 2.2.1 构建产物，并同步中文文档。

- MCP WebSocket 断开时清理挂起的 Bridge 请求，避免失联调用方一直锁定 `bridge_select_client` 直到队列超时。
- 同一页面重新连接后拒绝绑定旧 EDA 套接字的请求，避免旧结果跨越连接代次返回。
- 重新连接的页面在接纳新请求前，按照上一项 EDA 任务的执行窗口进行隔离，避免不可取消的修改操作重叠执行。
- EDA 或 MCP 套接字断开时继续保持隔离，包括仍排在 `bridge/task-started` 之前的任务以及服务端执行超时的任务。
- EDA 以名称键对象返回差分对读回数据时，保留受影响的约束项目。
- 移除不受支持的原理图网络和当前层公共路由，并使用所需的文档 UUID 同步 PCB 保存操作。

## 未发布

- Bridge 会在心跳超时后释放挂起请求，避免失联页面永久占用活动租约；`bridge_select_client` 新增受限的 `force` 恢复选项，用于从已确认卡死的活动页面切换到新的就绪页面。
- `component_select` 支持直接传入 LCSC C 编号，并明确区分未关联 EasyEDA 器件库的商品与普通搜索未命中。
## 2.1 开发版

- 新增受确认保护的 `schematic_pages_manage`，支持创建、复制、重命名和完整验证后的页面重排；有意不提供页面删除。
- 新增受限的官方制造导出，包括飞针测试和自动布线/布局 JSON 文件。
- 新增只读的 `simulation_model` 搜索，可选 Ngspice/SimulIDE 过滤。
- 新增 `schematic_document_action`，支持受限的原理图坐标/区域检查、选择、图元查询、导航、保存和导入。
- 运行时支持时，在 `eda_context` 中加入客户端版本、模式、编辑器版本和编译日期。
- 扩展 `pcb_document_action`，支持受限的图元 ID/类型/BBox 查询、鼠标位置和明确选择控制。
- 新增 `pcb_layer_query`、`pcb_realtime_drc`、精确的 `component_select.properties` 搜索及外部布线/布局导入。
- 新增 `manufacture_templates_query` 和 `manufacture_export.template`，用于选择官方 BOM 模板。
- 新增官方器件、符号和封装搜索能力 `library_search`。
- 扩展 PCB 约束架构，支持规则配置和结构化布线规则数据。
- 新增受控的 PCB 文档保存及外部布线/布局导入。
- PCB 网络查询新增 `all`、`names` 和精确 `getNet` 模式，可选精确网络分析。
- `manufacture_export` 新增原理图 BOM 装配变体选择。
- 新增只读 `pcb_drc_check` MCP 工具，提供严格检查和结构化违规结果。
- 新增 `pcb_net_query` 工具定义并同步路由。
- 由于固定版本客户端未公开 PCB 自动布线方法，公共工具列表暂不包含自动布线控制；仍支持外部布线文件。
- 通过 `library_search` 暴露官方 LCSC C 编号映射；固定版本客户端未公开 `lib_SimulationModel`，因此暂缓仿真模型搜索。
- 扩展 `pcb_document_action`，支持受限图元/选择检查、坐标转换和画布导航。
- 为器件、符号和封装库资源新增精确 UUID 获取及受限 JSON 导出预览。
- 在架构校验阶段拒绝混合选择器、非精确 PCB 分析、不支持的图元过滤器和缺失的焊盘对组名称。

## 2.2.0 - 2026-08-23

- 新增原理图 DRC、PCB 约束、工程信息、网表比较和制造导出工具。

## 2.1.5 - 2026-08-23

- 不可取消的 EDA 修改操作超时后继续隔离 Bridge 客户端，避免后续任务与未完成的 API 调用重叠。
- 保留现有的 `bridge_select_client.force` 恢复路径，用于确认已失效的活动客户端。
- 本版本不改变 EDA 客户端的器件创建实现；只安全报告超时并防止队列损坏。

## 2.1.4 - 2026-08-17

- 将校验后的 `api_invoke` 和 `eda_context` 超时值传递给 Bridge 请求。
- 收到 Bridge 的任务开始确认后才启动执行超时，并完整转发主/次 Server 的超时值。
- 增加超时参数传递的回归测试。

## 2.1.3 - 2026-08-17

- 发布面向普通用户的最小 npm 安装包，并提供 `jlceda-mcp` 命令。
- 增加社区仓库、问题反馈、Apache-2.0 许可证和安全联系方式。
- 文档改为社区版原生 MCP 架构，移除过时的上游仓库和本地路径。
- 包含原生交互放置编排、工具路由同步检查、多客户端和 Bridge Token 保护。
