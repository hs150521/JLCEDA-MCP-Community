# JLCEDA MCP 社区版

当前源码版本：Bridge `2.3.6`，MCP Server `2.3.6`；可下载版本以 [GitHub Release](https://github.com/hs150521/JLCEDA-MCP-Community/releases) 和嘉立创扩展广场各自的发布状态为准。2.3.3 扩充了原理图与 PCB 的完整读取和受控编辑，支持一条工具调用打开或激活当前工程的图页，并修复复制页共享图元 ID、交互放置结果及无网络 PCB 图元的回读。EDA 修改超时或连接失联后，Server 会保留诊断，按操作目标完成只读回读后才能恢复写入。

2.3.6新增独立封装编辑器支持：以官方 `documentType:4` 和库文档身份建立 Bridge 连接，使用 `footprint_read` 完整读取七类图元，通过 `api_invoke` 操作首批 41 个封装画布 API。无孔 Pad 的空值或原生 NaN 孔旋转表示为 `null`，没有额外特殊轮廓的 `specialPad:[]` 原样保留。正式恢复、5 个控制图元的源码写回后重开，以及 Via/Line/Polyline/String/独立 Arc 新案例的创建、修改、删除已实测通过。Pad 尺寸请求未生效、首次 Arc 未登记原因未确定、Attribute 无非空实机样本，#80 和 EDA v4 仍未解决或未验证。完整证据、范围和限制见 [2.3.6 发布说明](docs/releases/v2.3.6.md)。

2.3.4 新增 `board_setup`：传当前工程 UUID 和 `confirm:true`，可新建 Board 及关联的原理图、PCB；提供尚未关联 Board 的原理图 UUID 时，会创建 PCB 并将两者关联到新 Board。工具回读三个文档的归属，不会自动打开 PCB 或导入原理图变更。

## 原理图 raw 创建位号保护

`api_invoke eda.sch_PrimitiveComponent.create` 现在复用自动放置的当前页位号基线和恢复流程：恢复被原生创建重排的已有位号，保留 BOM 扩展属性并回读新图元。成功返回 `designatorChanges`、`restoredDesignators`；无法确认恢复时给出 `needsReview` 或未知提交诊断。未知提交沿用 placement 恢复，须读回原页完整 ID、位号及 BOM，不能仅查上下文。完整 DeviceItem、DeviceSearchItem、SymbolItem、SymbolSearchItem 与正式库引用保留原生重载和参数。实机新件的 BOM/PCB false 保留，已有 9 件完整 DTO 不变；本次未发生位号重排，`restoredDesignators:[]`。U4/U5 重排后的恢复、显式 false 参数与恢复超时由本地回归验证。

稳定版 [2.3.5](https://github.com/hs150521/JLCEDA-MCP-Community/releases/tag/v2.3.5) 已发布：补充器件库引用解析、器件引脚实例修改、覆铜重建回退、PCB 图元等价回读、DRC 分页和结构化错误诊断。两轮本地全面审查、Bridge/Server 全量构建测试及 lint 已通过，2.3.5 的发布实机验证使用匹配的 Server 与 Bridge。器件批量放置、NC 切换、名称筛选、NetPort Name 三种查询、原理图导出，以及 PCB BOM、板框、区域、直线覆盖、旋转、属性、元数据和覆铜重建已实测通过；过孔创建/修改、工程库来源核对、覆铜等价轮廓创建/修改及真实 DRC 28 条详情的 14 页连续读取均已实测通过。全部 23 个 Issue 的证据、待验证项及未解决限制见 [2.3.5 Issue 验证记录](docs/issue-validation-2.3.5.md)。

发布审查补修：普通 Pin 与 ComponentPin 按实际执行路径区分超时恢复；ComponentPin 仍要求所属器件全部引脚的完整回读。直线拆分/合并核验记录同网络、同层写前快照，要求本次新增或改变的有效线路，并返回 `changedPrimitiveIds`。过孔修改核对实际外径大于孔径，量化后的零环宽返回实际状态与差异。

普通 Pin 与 ComponentPin 共用原生 RPC 未确认分类；WebSocket is not open、transport closed、ECONNABORTED 等断连结果均返回 nativeCallSettled:false，并要求原宿主重启后完整回读。已结束但状态不匹配的调用仍区分为 nativeCallSettled:true。三种断连在两条实际处理路径、宿主重启策略与状态漂移分支均有针对性回归，已通过两轮本地复查。 同样统一图页导航与 PCB 直线/过孔创建的断连分类；回归包含原生状态已改变后才抛错的场景，继续要求宿主重启。

名称属性查询的所有页固定使用关键词搜索，并在本地核对全部请求属性，返回 `searchImplementation:"keyword_name_filter"`；`mayHaveMore` 仍依据原生候选页，避免每页切换搜索后端。裸器件引用明确指定库时，同时核对返回记录的器件 UUID 与库 UUID，不一致则在创建前返回 `DEVICE_LOOKUP_MISMATCH`。

原理图器件几何修改会核对有名网络和匿名导线连通组；引脚离开匿名导线或移至另一组时会报告连接变化。大图页可为 `schematic_read` 和 `bridge_recover_client` 设置最多 120 秒的 `timeoutMs`。

导线创建会在任务预算内等待 EDA 图元列表同步；原生未返回导线 ID 时，只有唯一导线与请求路径及网络匹配才确认创建，结果中的 `confirmedPrimitiveId` 标识确认的图元。

多页面连接时，首个页面未就绪会自动改选已就绪页面；显式选择或正在执行任务时不会自动切换。当前页写入使用执行时的实际图页身份进行恢复核对，提交状态不明时本机也立即阻止后续写入；跨图页的页面管理操作不能用当前图页回读解除隔离。使用新增操作及其恢复回读时，应同时安装匹配版本的 Bridge 和 Server。调用 `eda.pcb_PrimitiveComponent.getAll` 时可指定 `includeCompletePositions:true` 额外获取不截断的 `componentPositions`，通用 `result` 保持原有字段。

交互放置启动、重复器件清理或坐标放置若无法核对结果，恢复时必须读取原图页不截断的器件 ID 列表；`api_invoke` 的当前页 `eda.sch_PrimitiveComponent.getAllPrimitiveId` 可传 `args:[null,false]` 与 `includeCompleteSchematicComponentIds:true` 获取该列表。原生调用尚未确认结束时，先重启原 EDA 宿主。

PCB `autoRouting` 指定网络时使用 `RoutingNets:["网络名"]`；返回值会保留原生结果，并标出 EDA 报告的失败网络或参与数量是否超出请求范围。显式指定最多 3 个网络时，Bridge 会记录布线前的网络图元与长度；原生 RPC 超时后回读同页网络，在 `routingObservation` 中报告观察到的变化或回读失败，同时返回提交状态未知并隔离写入。即时回读只是暂时快照。受控恢复需先重启原 EDA 宿主，再对任务执行时的同一 PCB 完整读回直线、圆弧、折线、过孔的网络与几何及全部网络长度；`api_invoke` 的这些图元 `getAll` 可用 `includeCompleteRouting:true` 获取不截断的快照。即使原生 API 返回 `success:true`，仍需检查失败网络与实际布线结果。

完整布线快照会保留板框、丝印等折线的 `net:null`，并逐件保留 ID、层与几何；缺失网络或几何仍使恢复失败。

`pcb_connectivity_action` 可在当前 PCB 按精确网络名和铜层（SIGNAL 或 PLANE）直接创建直线导线，或按坐标、孔径与外径创建过孔。默认要求网络已存在；独立 PCB 新网络须显式传 `allowNewNet:true`。创建后回读图元；提交状态不明时隔离写入，对同一 PCB 完整回读全部布线图元和网络，原生调用可能未结束时还须重启 EDA 宿主。

## 功能与工具

- `bridge_clients` 和 `bridge_select_client` 用于在已连接的 EDA 页面客户端之间切换 MCP 路由；显式选择待命页前会先验证双向通信和任务队列，失败时保持原活动页，旧扩展需升级后才能显式选中。它们不会切换同一个 EDA 进程中的可见标签页；进程内打开或激活文档使用 `editor_navigate`。
- `bridge_recover_client`：不可取消 EDA 修改超时时，先从 `bridge_clients` 取得超时诊断的 `requestId`，再调用 `action=recover` 建立恢复会话。底层调用若持续挂起或 PCB 自动布局的提交状态未知，此后须重启原 EDA 宿主以终止旧调用；待新 Bridge 连接和全新 `clientId` 建立，按写入目标身份选择新客户端，再执行只读 `action=readback`。普通掉线重连保留旧 `clientId`，不能用于恢复回读。当前页绑定写入缺少执行时图页 UUID 时不能以旧心跳或手填 UUID 解除隔离；原理图器件批量删除需在原图页用 `schematic_read` 和 `includeConnectivityPrimitives:true` 回读。导线创建及 NetPort 创建、移动需以 `schematic_read`、`readbackPayload:{"includeConnectivityPrimitives":true}` 完整读回当前页导线几何、NetPort 和网络属性；只查 `/context` 无法解除隔离。一般原理图当前页器件回读使用 `api_invoke` 调用 `getAllPrimitiveId` 或 `getAll`，传入 `args:[null,false]`；PCB 器件回读使用无参数的 `eda.pcb_PrimitiveComponent.getAll`。回读前始终阻止写操作，超时修改可能已经完成。
- `schematic_document_action`：检查原理图坐标、选中对象、区域图元、过滤器和鼠标位置；执行视图导航、图元选择、图元属性/BBox 读取、保存和变更导入。
- `schematic_layout_check`：基于结构化 EDA 几何估算原理图符号、引脚、属性文本、网络标签和导线重叠，报告密集区域与可选页面越界；`mode: "fix"` 仅在 `confirm: true` 时移动属性文本。
- `schematic_connectivity_action`：预览新导线与现有导线的接触、明确允许接触后创建导线，并创建或移动当前图页 NetPort；单条新导线最多传入 256 个坐标点。返回图元和网络回读状态。NetPort 适合同页连接与层次图端口，跨页连接应使用跨页连接标识。
- `schematic_wire_manage`：完整读取当前原理图页导线的 ID、网络、几何和样式，按 ID 修改单条导线的正交路径、网络或样式，也可删除单条导线。几何修改沿用导线接触预览，写后核对同页图元；未知提交用 `schematic_read` 的完整连接图元快照恢复。
- `schematic_text_manage`：完整读取当前原理图页文字标注，支持按 ID 查询、创建和删除单条文字；写前核对图页与编辑器身份，写后回读目标 ID。当前 EDA API 修改已有文字会破坏对齐，故暂不提供修改，对齐值也只读。默认对齐的文字可读取后删除并重建，新文字 ID 会变化；非默认对齐无法这样无损重建。未知提交需完整回读原图页文字。
- `schematic_read`：读取当前原理图页的电路语义和页 UUID；核对图页与编辑器文档身份、当前页器件对象和 ID 列表；读取完整连接图元时还核对导线对象和 ID 列表。未同步时返回 `PAGE_NOT_READY`。复制页可以合法共享图元 ID。
- `schematic_component_edit`：完整读取当前原理图页的普通器件状态，或按图元 ID 修改位置、旋转、镜像、位号与 BOM 属性及删除器件。修改会保留未指定的 BOM 扩展属性；改变几何状态时还会比较写入前后各引脚的网络，误接会报告 `pin_network_changed`。批量删除可通过 `api_invoke` 调用 `eda.sch_PrimitiveComponent.delete` 并传 ID 数组，Bridge 会按执行时的当前图页逐项删除和回读；复制图页与原页可能共享 ID。提交状态不明时，需在原图页完整读回普通器件及语义网络后再决定如何修正。
- `schematic_pages_manage`：在 `confirm: true` 时创建、复制、重命名或完整重排原理图页面。重排必须提供每个当前页面 UUID，Bridge 会重新读取并验证结果；不提供删除功能。
- `pcb_documents_manage`：按当前工程 UUID 完整列出 PCB，或在 `confirm:true` 时创建游离/指定板子的 PCB、复制或重命名已有 PCB。写后核对工程和 PCB UUID；重命名要求目标 PCB 已打开，工具不会切换图页。未知提交须完整回读工程 PCB 目录。
- `board_setup`：在当前工程创建 Board 和关联的原理图、PCB，也可复用现有游离原理图；结果不明时完整回读同工程的 Board、原理图和 PCB 目录，不自动删除可能留下的游离 PCB。
- `editor_navigate`：在当前工程中按文档 UUID 打开原理图图页或 PCB；也可按已有 `tabId` 激活，并提供文档 UUID 供切换前后核对。成功时回读工程、文档、图页与标签 ID；结果不明时先按目标文档回读，不要盲目重复切换。
- `pcb_drc_check`：分页读取 PCB 设计规则检查详情；支持 `offset`、`limit`，返回 `nextOffset`，并区分原生详情缺失与 Bridge 序列化截断。
- `pcb_net_query`：按条件和数量限制查询当前 PCB 网络；精确网络图元过滤接受官方 `EPCB_PrimitiveType` 名称，由 Bridge 对 EDA 返回的图元筛选。
- `footprint_read`：完整读取当前独立封装文档的 Pad、Via、Line、Arc、Polyline、String 和 Attribute，返回真实库/文档/标签身份及不截断状态；封装写入结果不明时用该快照受控恢复。
- `pcb_read`：一次读取当前 PCB 页选定的语义部分；默认包含器件与网络，可选焊盘、布线、覆铜、板框、区域和文本，`sections:["all"]` 读取全部。所选部分返回不截断的图元数组，并在读取前后核对 PCB UUID。
- `pcb_component_edit`：完整读取当前 PCB 器件，或按库引用放置、按 ID 修改层、坐标、角度、锁定状态、位号和 BOM 属性及删除单件。旋转按模 360 度比较；部分修改失败返回实际 `after`、`failureKind` 和字段差异，按诊断回读后再判断是否重试。
- `pcb_pour_manage`：读取当前 PCB 的全部覆铜边框、填充关联和几何摘要，使用可序列化的轮廓源数组创建或修改单个覆铜边框，并可删除或明确重建填充。创建和修改后不会自动重建；若 EDA 自动调整优先级等字段，会明确返回请求值、写后状态及副作用。单件重建无目标填充、删除后仍有关联填充时也不会误报成功。结果不明时需在同一 PCB 回读全部边框和填充摘要。
- `pcb_routing_edit`：完整或按 ID 读取 PCB 铜层直线、圆弧、折线和过孔；创建圆弧或折线，并按 ID 修改或删除上述图元。删除后以同类 `getAll` 的完整 ID 列表核对，不受原生 `get(id)` 删除占位对象影响；结果不明时回读全板布线及网络状态。
- `pcb_board_outline_manage`：完整或按 ID 读取 PCB 板框层的直线、圆弧和折线，创建、修改或删除单个板框图元；写后核对当前 PCB。允许用多段图元组成板框，不要求每段独立闭合。
- `pcb_region_manage`：读取当前 PCB 全部禁止区域和约束区域，包括多轮廓区域；按 ID 创建、修改和删除单个区域，创建与修改使用单轮廓源数组，多点轮廓须在末尾重复首点以显式闭合。创建未生效或实际属性不同、部分修改时返回已确认的实际状态；删除以完整区域列表确认目标 ID 消失。
- `pcb_text_manage`：完整读取当前 PCB 独立文本与器件属性，按 ID 创建、修改或删除独立文本，并修改现有器件的位号、值等属性文字及显示样式；写后核对同板图元，未知提交需完整回读文本与属性。
- `pcb_connectivity_action`：按当前 PCB 数据单位创建直线走线或过孔。可确认原生拆分或合并后的共线覆盖，以及 EDA 3.2.181 实测的 0.2 mil 网格最近值过孔尺寸归一化；返回实际图元和 `normalization`。需要已存在网络，或显式允许新网络。
- `schematic_drc_check`、`pcb_constraints_query`、`project_info` 和 `netlist_compare`：提供设计审查和工程身份信息；`project_info` 可选返回受限的 Board 和 Panel 清单。
- `eda_context`：在客户端支持时返回 JLCEDA/EasyEDA 版本、在线模式、编辑器版本、编译日期和当前画布数据单位。
- `eda_canvas_snapshot`：读取当前画布元数据，并可在明确请求时返回受限的只读 MCP 图像。
- `design_source_export`：读取当前文档或封装源文件的受限预览；完整源文本需要明确授权且受字节数限制。
- `design_archive_export`：读取原生当前工程/当前文档归档的元数据；只有明确请求时才返回受限的 Base64 数据，不写入文件。
- `library_preview` 和 `library_classification_query`：预览符号/封装资源并浏览受限的官方库分类树。
- `workspace_query`：查询当前工作区、团队、工程和文件夹，并发现可访问的资源。
- `design_compare`：调用官方原理图、PCB 和网表比较 API，并返回版本相关错误。
- `pcb_layer_query`：读取 PCB 层和铜层数量。
- `pcb_layer_manage`：读取当前 PCB 的完整图层清单与铜层数，或用 `confirm:true` 将铜层总数设置为 2–32 的偶数；大型 PCB 可用 `timeoutMs` 调整调用预算，降层前阻止移除非空内层，写后核对同页结果，提交状态未知时按同页图层回读恢复。
- `pcb_realtime_drc`：读取或明确启停 PCB 实时 DRC。
- `pcb_document_action`：读取 PCB 坐标、选中图元、区域图元、过滤器和画布状态；执行视图导航、保存、变更导入以及 Base64 自动布局/布线文件导入。
- `component_select`：支持精确器件属性查询，包括 LCSC `supplierId`。
- `library_sources`：列出系统、个人、工程和收藏库。
- `library_search`：搜索或读取 0.4.15 设备、符号、封装、3D 模型、可复用模块和 Panel 库资源，也支持仿真模型搜索；设备搜索支持精确属性和官方 LCSC C 编号映射。设备名称属性搜索会核对实际名称，各页固定关键词搜索并核对全部请求属性。
- `pcb_constraints_query`：读取当前规则、规则配置、网络规则、区域规则和约束组。
- `manufacture_export`：生成受限的 BOM、Gerber、网表、贴片坐标等制造文件；仅校验选定 domain/kind 的参数，BOM、图纸文档、标准与仿真网表使用各自格式，避免其他分支提前校验。
- `manufacture_templates_query`：列出 PCB BOM 模板或原理图装配变体；`manufacture_export` 可使用返回的装配变体。

`schematic_document_action` 与 `pcb_document_action` 的纯查询和画布导航可在写入隔离期间使用；改变选择状态、飞线计算、保存和导入仍按写操作隔离。

当前版本会拒绝空的自动布局/自动布线 UUID；EDA 修改超时后允许当前客户端执行只读查询，但读回结果在原调用仍挂起时只能视为暂时快照，写操作继续隔离。EDA 3.x 尚不支持普通网络标签的 `createNetLabel` API；电源/地标识仍可用。

PCB `import_changes` 返回 `pending_confirmation` 后，全局写入暂停，只读工具仍可用。从 `bridge_clients` 取得待确认 `requestId`；用户在 EDA 原生对话框点击“应用修改”或取消并确认对话框关闭后，调用 `bridge_recover_client`，传入 `action:"resolve_import"`、`confirm:true`、`requestId` 和 `resolution:"applied"` 或 `"cancelled"`。Server 会核对原 PCB 身份并完整读回器件和网络，Bridge 收到解除确认后才恢复写入。EDA API 无法报告对话框关闭，因此这一步依赖用户对原生操作的确认；若无法确认，应以 `action:"recover"` 建立会话，重启原 EDA 宿主，再用新 Bridge 客户端和 `hostRestartConfirmed:true` 执行完整 PCB 回读。EDA 3.2.181 的 BETA `pcb_Document.autoLayout` 可能超时后仍提交位置；Bridge 会标记结果未定，要求重启原宿主并读回全部器件坐标后再决定是否重试。`pcb_Document.autoRouting` 若立即返回失败，需以导线、过孔和 DRC 读回判断实际结果，不能把 API 调用完成当作已布线。

`import_changes` 调用原生 API 前会核对当前 PCB 与编辑器文档身份及所属板；身份尚未同步时返回 `pcb_page_not_ready`，未归属板时返回 `pcb_not_associated_with_board`。后者应先打开或创建与原理图同板的 PCB，避免 EDA 前置对话框阻塞调用。

交互放置等待用户退出当前放置模式，只把退出后仍存在的图元作为已放置结果；当前页器件对象列表会补足可能滞后的图元 ID 列表，避免已提交器件误报为未放置。完全重复图元会逐个删除并核对，连接失联或未知提交状态会停止后续放置。坐标放置逐件核对图页和新增图元 ID，已有器件位号变化时尝试恢复，无法核对时停止并返回实际明细。坐标放置与网络标识批次的默认执行预算为 300 秒，可按数量调整 `timeoutMs`。`api_invoke` 的器件属性修改保留省略的 BOM 扩展属性，批量删除逐项执行并核对结果。

社区维护的嘉立创 EDA 专业版 MCP 集成基于 [`sengbin/JLCEDA-MCP`](https://github.com/sengbin/JLCEDA-MCP) 改进。本项目不是嘉立创官方插件，也不代表上游维护者。

- 社区联系与安全报告：`hs150521@proton.me`
- 许可证：Apache-2.0
- Issue：<https://github.com/hs150521/JLCEDA-MCP-Community/issues>

## 架构

```text
Codex / Claude / Cursor / 其他 MCP 客户端
                  | STDIO MCP
                  v
       JLCEDA MCP Server 2.3.6
                  | 本机 WebSocket
                  v
       MCP Bridge 社区版 2.3.6
                  | JLCEDA 扩展 API
                  v
           嘉立创 EDA 专业版
```

市场中的 `.eext` 只包含 EDA Bridge；原生 MCP Server 需要从同一个 GitHub Release 另行安装。社区版不依赖旧版 VS Code/Cursor MCP Hub。

## 安装 2.3.6

以下为 2.3.6 的安装文件名；发布验证完成前，请以发布页实际提供的版本为准，并保持 Bridge 与 Server 版本一致。

需要 Node.js 20 或更高版本。

1. 从 [发布页](https://github.com/hs150521/JLCEDA-MCP-Community/releases) 下载并在嘉立创 EDA 扩展管理器中安装 `mcp-bridge-community-2.3.6.eext`。
   安装后在“已安装”的扩展详情中确认已允许“外部交互”，否则 Bridge 无法连接本机 MCP Server。
2. 下载 MCP Server 包并安装：

   ```powershell
   npm install --global .\jlceda-mcp-server-2.3.6.tgz
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

4. 打开嘉立创 EDA 原理图、PCB 或独立封装文档，Bridge 默认连接 `ws://127.0.0.1:8765/bridge/ws`。

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
- 本版扩展仅声明兼容嘉立创 EDA 专业版 3.x，已在 3.2.181 上测试；EDA v4 需等待未来明确支持 v4 的版本。
- 官方 `createNetLabel` 从 EDA v4 起提供，当前 3.x 版本无法创建普通网络标签。Bridge 直接返回 `EDA_VERSION_UNSUPPORTED`，不会启动可能挂起的 EDA 调用；电源和地网络标识仍可使用。

## 当前操作限制

- 原理图自动放置先查设备库，将裸 UUID 引用解析为完整 DeviceItem；查无设备时停止，避免将无效引用交给原生创建。2.3.5 实机中，无效设备 UUID 立即返回 `DEVICE_NOT_FOUND`，随后自动放置 0603 C23221 及 0805 C96346/C84376/C110775 的 4 型号批次全部成功，合计约 8.9 秒。
- `api_invoke` 修改原理图 ComponentPin 的 NC 或引脚号时，使用真实器件引脚实例；引脚位置、旋转和其他符号几何不作为该适配器的可写字段。失败后按 `schematic_connectivity_primitives` 诊断，以 `schematic_read includeConnectivityPrimitives:true` 核对所属器件全部引脚的 `pinId/x/y/rotation/noConnected`，只查询上下文不能解除隔离。2.3.5 实机 NC `true`→`false` 两次均 `verified:true`，目标坐标与同器件其他引脚保持不变。
- 现有点导线改成多线段路径会在写入前返回 `point_wire_path_conversion_unsupported`；可新建目标导线并核对连接，再显式删除原点导线。
- `pcb_connectivity_action via_create` 与 `pcb_routing_edit` 的过孔尺寸修改只接受精确尺寸或 EDA 3.2.181 实测的 `round_0_2_mil` 结果，返回请求值与实际孔径/外径；真实尺寸差异仍失败。创建与修改已实测通过：15.748/31.496→15.8/31.4、15.7/31.5→15.8/31.6。
- 过孔删除只确认当前页内存中目标消失，返回 `verificationScope:"current_page_memory"` 和 `durableDeletionVerified:false`。已知封装子过孔拒绝删除；缺少父 ID 时归属未知，必须保存并重新打开 PCB 后核对持久性。
- 2.3.6 为独立封装编辑器提供单独上下文、七类完整回读和首批画布 API。七类 modify 等待一次 `done()` 并重新读取，实际字段未生效返回 `fieldMismatches` 和真实 `after`；实机 SMD x130 生效，80×60 形状请求仍为 60×60，属于已知部分结果。个人封装的最终 5 个控制图元（含 SMD x130）源码写回后重开已一致；没有新增封装专用保存工具，PCB 封装子过孔持久删除（#80）继续开放。

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
- [2.3.5 Issue 验证记录](docs/issue-validation-2.3.5.md)
- [v2.3.6 发布说明与回归清单](docs/releases/v2.3.6.md)
- [v2.3.5 发布说明](docs/releases/v2.3.5.md)
- [v2.3.4 发布说明](docs/releases/v2.3.4.md)
- [v2.3.3 发布说明](docs/releases/v2.3.3.md)
- [嘉立创扩展广场发布要求](https://prodocs.lceda.cn/cn/api/guide/extensions-marketplace.html)
- [OpenAI Codex MCP 配置](https://developers.openai.com/codex/mcp/)
