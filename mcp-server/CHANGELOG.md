# 更新日志

## [Unreleased]

## [2.3.6] - 2026-10-05

- 新增独立封装支持：公开 `footprint_read`，同步独立封装文档及 `libraryUuid` 上下文；默认提供 60 秒 Bridge 读取预算，可按需要延长至 120 秒。
- 共享契约声明首批 21 个封装画布读取方法和 20 个写入方法，与 Bridge 路由及输入定义保持同步；Attribute.create 不开放。
- 封装写入按 task-started 的真实执行身份分类，未知提交、超时和失联要求同库同文档七类完整 `footprint_read`。恢复允许新标签，但回读前后的库/文档/标签必须一致，错误库或不完整状态不会解除写入隔离。
- 新增主连接/中继的三类未确认提交恢复及分发回归，更新 Agent 操作指引。正式 footprint_state 实机恢复返回 readbackVerified:true、writesRemainBlocked:false；个人封装原生源码写回后重开，5 控制图元完整 DTO 一致。最终 SMD x130 状态已保存并重开核对；#80 持久 PCB 子过孔删除继续开放。

- 原理图 raw component.create 复用已有位号保护与完整 placement 恢复，保留正式设备/符号重载及原生参数。实机新件 BOM/PCB false 保留、9 旧件完整 DTO 不变；本次没有位号重排，U4/U5 恢复由本地 fixture 验证。
- 配合 Bridge 的无孔 Pad DTO：原生空值或 NaN 孔旋转按不适用表示为 null，带孔状态仍要求有限孔旋转。完整恢复接受真实 `specialPad:[]`，同时要求焊盘或特殊焊盘至少有一个非空形状。
- 配合 Bridge 七类 modify 等待一次 done 并重新读取；可确认的字段差异返回 fieldMismatches 和实际 after，按已知部分结果处理。SMD 80×60 尺寸请求未生效；Attribute 未进行非空 native 验证，首次 Arc 未登记原因未确定，EDA v4 未验证。
- MCP SDK 的恢复 `readbackPath` enum/default 直接来自工具定义，补齐封装和工程目录回读入口；实际 stdio `tools/list`、`tools/call` 回归覆盖两个协议版本，未知路径仍拒绝。

## [2.3.5] - 2026-10-05

- 名称属性查询的所有页固定使用关键词搜索，并在本地核对全部请求属性，返回 `searchImplementation:"keyword_name_filter"`；`mayHaveMore` 仍依据原生候选页，避免每页切换搜索后端。裸器件引用明确指定库时，同时核对返回记录的器件 UUID 与库 UUID，不一致则在创建前返回 `DEVICE_LOOKUP_MISMATCH`。
- 发布审查补修：普通 Pin 与 ComponentPin 按实际执行路径区分超时恢复；ComponentPin 仍要求所属器件全部引脚的完整回读。直线拆分/合并核验记录同网络、同层写前快照，要求本次新增或改变的有效线路，并返回 `changedPrimitiveIds`。过孔修改核对实际外径大于孔径，量化后的零环宽返回实际状态与差异。
- 普通 Pin 与 ComponentPin 共用原生 RPC 未确认分类；WebSocket is not open、transport closed、ECONNABORTED 等断连结果均返回 nativeCallSettled:false，并要求原宿主重启后完整回读。已结束但状态不匹配的调用仍区分为 nativeCallSettled:true。三种断连在两条实际处理路径、宿主重启策略与状态漂移分支均有针对性回归，已通过两轮本地复查。 同样统一图页导航与 PCB 直线/过孔创建的断连分类；回归包含原生状态已改变后才抛错的场景，继续要求宿主重启。
- `pcb_region_manage` 的多点轮廓写入须显式首尾闭合；工具定义、Agent 指引和文档增加 EDA 3.2.181 实机要求与闭合示例。
- `pcb_text_manage` 的 Attribute 修改参数允许 `value`、`valueVisible`，补全对应的工具契约与分发回归；2.3.5 实机两字段修改及回读已验证。
- `pcb_drc_check` 工具契约增加 `offset`、`limit`；Bridge 返回 `nextOffset`、原生详情数量及两层截断诊断，以分页获取原生可用详情。
- 非字符串 Bridge 错误转换为可读错误，同时保留 `code`、`reason`、`field`、`status` 等诊断；主连接、中继和工具分发的回归覆盖完整传输，错误文本不再只剩通用提示或 `[object Object]`。
- 同步说明器件库解析、名称过滤、ComponentPin 实例修改、覆铜回退、PCB 几何归一化、元数据实际回读与制造导出分支校验；ComponentPin 失败恢复归为完整连接回读，要求目标所属器件全部引脚 ID、位置、旋转及 NC 的真实状态。工具说明补充工程库来源核对、覆铜闭合轮廓等价比较，以及过孔创建/修改的实测 0.2 mil 最近格点规则，过孔创建/修改、工程库来源核对和覆铜轮廓已完成实机验证。
- 说明过孔删除仅验证当前页内存；缺失父 ID 不证明其独立归属。持久子过孔删除与独立封装上下文仍未解决，继续保留诊断与原生限制；真实 DRC 分类树的 28 条叶子明细已连续读取 14 页，端点完整，两种截断标志均为 false。
- 源码及配套安装文件更新为 2.3.5；两轮本地全面审查、Server/Bridge 全量构建测试及 lint 通过。2.3.5 Server 与 Bridge 已运行，4 型号自动放置、无效引用预检、NC 切换、名称过滤、NetPort Name 三种查询、原理图 CSV/网表/PDF 及 PCB BOM 导出实测成功；已测 PCB 场景与保留问题详见 [23 项 Issue 验证记录](https://github.com/hs150521/JLCEDA-MCP-Community/blob/v2.3.5/docs/issue-validation-2.3.5.md)。

## [2.3.4] - 2026-09-26

- 新增 `board_setup`：在当前工程一次创建 Board 及关联原理图/PCB，或把现有游离原理图与新 PCB 关联；结果不明时按同工程完整文档目录恢复。

## [2.3.3] - 2026-09-26

- 调整 Agent 指引：当前页问题可用 `schematic_read`，全工程分析按需使用 `schematic_review`；输出随用户问题聚焦，不强制六张表或每次建立 todo。
- 选型允许沿用用户已给的精确器件或代选授权，取消仅结束当前尝试；电源/地网络标识通过 `netlabel_place` 放置。优先使用对应的专用工具，已验证当前版本精确签名时无需重复 `api_search`；`wire_create` 成功后使用 `schematic_read includeConnectivityPrimitives:true` 核对同页实际连接，未知写入恢复要求保持不变。
- 配合 Bridge 修复 `project_info` 在 PCB 页面遗漏原理图图页的问题，并说明导航会在 `timeoutMs` 预算内等待目标文档就绪。
- `pcb_layer_manage action=set` 明确要求 `confirm:true`，阻止未确认的 PCB 叠层修改。
- `pcb_layer_manage` 的完整读取和降层预检支持按 PCB 大小将桥接超时预算调整到 120 秒。
- PCB 文档创建或复制已获得新 UUID 但目录回读失败时，恢复要求目录包含该 UUID，避免旧目录误解锁后重复创建。
- `pcb_region_manage` 参数与原生区域创建、修改接口对齐为单轮廓；创建后已确认的无效或属性偏差不再进入未知提交隔离。
- 受控恢复的主回读使用调用者的 `timeoutMs`，不再固定 15 秒；`schematic_read` 和 `bridge_recover_client` 可为大图页设置最多 120 秒的读取预算。
- `pcb_region_manage` 完整回读已知部分修改或删除结果时不再误设未知提交隔离；工具描述补充实际返回字段。
- 记录 `import_changes` 的未关联板预检结果：Bridge 不调用原生导入，Server 不进入待确认或未知提交隔离。
- 配合 Bridge 修复交互放置已提交却返回 `placed:false`：原理图当前页对象回读可补足滞后的 ID 列表，Server 继续等待退出放置模式后处理下一器件。
- 原理图复制页可合法复用原页器件、导线和文字 ID；`api_invoke` 器件删除仅作用于执行时当前页，按当前页确认结果，未知提交以 `schematic_read includeConnectivityPrimitives:true` 回读原页。
- 完整 PCB 布线恢复接受无网络图元的明确 `net:null`，保留板框和丝印折线的 ID 与几何；缺失网络字段仍判为回读不完整。
- 新增 `pcb_layer_manage` 的读写路由和铜层数量未知提交恢复；降层前阻止移除非空内层，未知提交时在原 PCB 完整回读层数和图层清单。
- 新增 `editor_navigate`，可在当前工程一次调用打开或激活原理图图页及 PCB；切换前验证工程目录，切换后精确核对文档、图页和标签身份，结果不明时按目标文档受控回读。
- 自动布线超时的 `routingObservation` 会随原结果透传；即时网络变化不解除 Server 的完整恢复回读和宿主重启要求。
- 新增 `schematic_text_manage`，完整读取当前原理图页文字，支持创建、删除及按 ID 查询；按 ID 的操作使用完整列表避开原生单项读取不一致。EDA 3.2.181 / API 0.3.15 修改已有文字会破坏对齐，因此暂不提供修改，显式对齐值写入也已禁用；未知提交需同页完整文字回读。
- 新增 `pcb_documents_manage`，按工程 UUID 完整列出 PCB，受确认保护地创建、复制或重命名；未知提交要求同工程完整 PCB 目录回读。
- 配合 Bridge 修复 `pcb_net_query` 的精确网络图元类型过滤；工具参数保持不变。
- 新增 `pcb_text_manage`，完整读取 PCB 独立文本和器件属性，支持独立文本增删改及已有属性修改；未知提交需同板完整回读两类图元。
- 新增 `pcb_read`，一次按需读取当前 PCB 的器件、焊盘、网络、布线、覆铜、板框、区域和文本；默认仅器件与网络，所选部分不截断并核对同板身份。
- 文档明确通过 `api_invoke` 指定自动布线网络时使用官方 `RoutingNets` 字段，并说明 Bridge 返回的超范围诊断；保留原生 API 结果和 PCB 回读判断。
- 新增 `pcb_region_manage`，支持禁止区域与约束区域（含多轮廓）的完整读取及单图元创建、修改、删除，未知提交需同板完整区域回读。
- 配合 Bridge 在原理图器件几何修改后报告引脚网络变化，并要求完整连接图元和语义网络回读后恢复写入，包括原生调用迟到的结果；器件编辑可按大图页需要调整超时预算，NetPort 移动期间核对图页身份。
- 新增 `schematic_wire_manage`，完整读取当前页导线，按 ID 修改正交几何、网络、样式或删除；写后核对，未知提交需完整连接图元回读。
- 新增 `pcb_board_outline_manage`，对板框层的直线、圆弧和折线提供完整读取及单图元创建、修改、删除；明确区分原生创建未生效、已新增但几何不符与未知提交，后者复用同板图元回读。
- `schematic_read` 普通读取核对图页/文档身份及当前页器件对象与 ID 列表；完整连接回读另核对导线对象与 ID 列表。复制页共享 ID 不再误判为旧页。
- 新增 `schematic_component_edit`，可完整读取当前页普通器件并按 ID 修改或删除；写后核对目标状态，未知提交要求同页完整器件状态回读。
- 新增 `pcb_component_edit`，可按设备或封装库引用放置 PCB 器件，修改位置与 BOM 属性或删除；未知提交要求同板完整器件状态回读。
- 新增 `pcb_pour_manage`，将覆铜轮廓数组转换为原生多边形并操作覆铜边框；完整核对重建结果和删除后的关联填充，报告原生创建或修改引起的优先级变化，未知提交须同板回读全部边框和填充摘要。
- 新增 `pcb_routing_edit`，支持 PCB 布线图元的精确读取、修改和删除及圆弧、折线创建；删除后以同类全量 ID 列表核对，未知提交复用全板布线与网络回读。

## [2.3.2] - 2026-09-25

- 坐标器件放置与网络标识批次采用可调的 25–600 秒执行预算，默认 300 秒，避免合法大批次在固定 25 秒后被隔离；网络标识未知提交须完整读回 NetFlag、NET 属性和语义网表。
- 交互放置启动、原理图连接写入与可写 `api_invoke` 的原生调用未确认时要求宿主重启；放置和连接写入分别使用完整器件状态或连接图元回读。`component_place` 会透传启动阶段的未知提交标记。
- 交互放置状态检查采用覆盖 Bridge 25 秒合约的 Server 请求预算，避免清理和位号恢复被提前判为超时。
- `bridge_select_client` 显式选中待命页前新增 1.5 秒双向队列探活；无应答或旧扩展未声明能力时保持原活动页和租约，`bridge_clients` 显示是否支持探活。
- 原理图交互放置重复件清理在原生调用未确认结束时要求重启旧宿主；调用已结束但回读失败仍需完整同页回读。PCB 导线/过孔的迟到已验证成功结果可解除重启要求，但保留完整路由回读。
- 新增 `pcb_connectivity_action`，可在当前 PCB 按网络和铜层创建单条直线导线或过孔；默认核对已有网络，显式 `allowNewNet:true` 可用于独立 PCB 的新网络。写入后回读图元，未确认提交时执行同板完整布线状态回读；原生调用未确认结束时才强制宿主重启。
- 交互放置的 `/component/place/check` 可能清理完全重叠的重复图元，因此按写操作隔离；坐标放置或交互放置恢复位号时若提交状态未知，强制回读原图页完整器件 ID、位号和数量，避免只查上下文就解除隔离。
- PCB 自动布线的原生 RPC 超时纳入提交状态未知的写入隔离；受控恢复要求原宿主重启确认，并在执行时同一 PCB 上完整读回直线、圆弧、折线、过孔的网络与几何以及所有网络长度。分段回读前后均核对 PCB 身份，失败时继续隔离。
- `api_invoke` 的四类无参数 PCB 布线图元 `getAll` 可用 `includeCompleteRouting:true` 返回未截断的几何快照；自动布线返回 `success:true` 但仍有失败网络时明确报告未完成。
- 导线创建、NetPort 创建或移动在超时或提交状态不明后，恢复流程强制以 `schematic_read` 完整回读当前图页的导线几何、端口和 NET 属性；回读不完整或图页不符时继续阻断写入。

- 原理图页面管理和对应的底层页面变更 API 可修改非当前图页；提交状态未知时要求完整原理图页面目录回读，并核对目标页面或原理图归属，不再把当前图页回读当成目标核验。
- 所有写任务的超时与未知提交诊断采用任务启动时的实际身份，当前页绑定写入缺少执行图页身份时不再使用旧心跳解除隔离；跨页器件删除要求全工程 `schematic_review` 回读，已确认签名的工程改名 API 则核对参数指定的目标工程。
- 首个连接页面未就绪时，自动改选后续已就绪页面；手动选中的页面、执行中的任务和未确认写入不会被自动切走。
- PCB 自动布局的恢复诊断使用任务启动时及原生结果中的实际 PCB 身份，不再依赖可能过期的心跳图页；恢复读回自动请求完整器件位置。
- `api_invoke` 可为无参数 PCB 器件 `getAll` 指定 `includeCompletePositions:true`，在保留通用 `result` 字段的同时额外返回全量 `componentPositions`。
- 将 PCB 和原理图文档工具的纯查询及画布导航归为非设计写入，允许在写入隔离期间使用；选择状态、飞线计算、保存和导入仍受隔离。
- PCB `import_changes` 返回待确认时建立全局写入屏障；用户明确确认已在原生对话框应用或取消后，`bridge_recover_client action=resolve_import` 校验导入时的 PCB 身份并完整读回器件与分页网络，才解除屏障。无法确认时保留重启宿主的受控恢复路径。
- `netlabel_place` 工具说明标明普通网络标签需要 EDA v4；EDA 3.x 将直接返回未开始，避免调用不可用的 API。
- `pcb_document_action` 与代理指引标明 PCB 变更导入的原生确认阶段，以及 PCB BETA 自动布局/布线的结果验证步骤。
- 交互式 `component_place` 等待用户退出当前放置模式，只返回退出后仍存在的新增图元 ID；重复图元或超时后停止批次，不自动重试可能已提交的放置。
- `component_place_auto` 检查本批次此前放置的器件位号；后续放置导致位号变化时停止批次，并返回更新后的已放置明细。
- 新增 `schematic_connectivity_action`，提供导线交点预览、需显式允许已有导线接触的创建流程，以及当前图页 NetPort 创建和移动入口。
- `schematic_connectivity_action` 的单条新导线最多接收 256 个坐标点，工具参数在 Server 与 Bridge 双层校验。
- 按最近心跳判定 Bridge 客户端是否就绪，并让心跳停滞的连接超时退出；`bridge_clients` 增加 `lastHeartbeatMsAgo`。
- 已开始的写任务若因 EDA 客户端或 MCP 调用方失联而中断，保留未确认修改诊断；重连隔离时间届满仍需恢复回读才能再次写入。
- 恢复隔离期间允许 `getAllPrimitiveId` / `getAll` 以严格的 `args:[null,false]` 查询当前页器件，并可用于受控恢复回读；无参数调用继续兼容，其余 `api_invoke` 仍按写入隔离。
- PCB 恢复期间可用无参数的 `eda.pcb_PrimitiveComponent.getAll` 回读器件位置；带筛选参数的调用继续受隔离。
- `bridge_recover_client` 使用原始超时诊断的图页 UUID 校验新客户端与实际 `/context` 回读；同一文档中的其他原理图页或 PCB 不再能解除当前图页的写入阻断。
- PCB 器件位置回读通过 `componentPositions` 返回完整的位置、旋转角和位号摘要，不会在多于 120 个器件时截断恢复依据。
- 恢复回读明确失败时继续阻断写入；PCB 自动布局超时后，强制以同板完整器件位置回读恢复，单独查询 `/context` 不会解除隔离。
- Server 与 Bridge 超时先后交错、或 EDA 原生自动布局返回提交状态未知时保留恢复诊断，避免重启 Bridge 后绕过位置回读。
- 原理图导线及 NetPort 的结果若标记 `commitUnknown: true`，按时返回也会建立未确认写入诊断；迟到结果继续保留诊断，避免另一页面提前再次写入。
- 所有未确认写操作的恢复回读均要求原 Bridge 连接已经断开；另一页面的新连接不能在旧原生调用仍运行时提前解除隔离。PCB 自动布局仍须重启原 EDA 宿主并读回全部器件位置。
- 明确恢复顺序：先以 `action=recover` 建立会话，持续挂起或 PCB 自动布局提交未知时再重启原 EDA 宿主，最后使用会话之后的新连接完成 `action=readback`。
- 恢复目标按 WebSocket 连接身份识别新 Bridge，避免新连接与恢复请求落在同一毫秒时被错误拒绝。
- 恢复回读还要求全新 `clientId`；旧 EDA 运行时的原客户端或备用客户端普通掉线重连虽更换 WebSocket，仍不能被当成新世代解除写隔离。
- `schematic_connectivity_action` 的导线预览按只读分类，超时或断线不再留下未确认写入诊断。

## [2.3.1] - 2026-09-24

- 工具分发异常输出包含工具、Bridge 路由、错误信息、异常堆栈以及版本与构建日期水印的结构化 stderr 日志；Server 同时输出 Bridge 上报的诊断日志。
- Bridge 任务错误的名称、堆栈、错误码和超时时间可沿 Server 内部转发链保留；构建日期写入打包产物，便于定位实际运行版本。
- 修复 `component_select` 的关键词/属性搜索和 `design_compare` 的三种比较输入在 MCP 输入校验阶段被错误拒绝的问题。

## [2.3.0] - 2026-08-25

- 使用根目录 `contracts/bridge-contract.json` 作为 Bridge 公开工具、内部交互路由、超时策略和协议字段的唯一事实源。
- Server 分发和 Bridge 回包均按共享契约校验；握手协商协议版本 1，并兼容缺少版本字段的旧 Bridge。
- 将 WebSocket 编码、负载上限和 token 比较提取为独立线协议模块，保持 `EdaBridgeServer` 协调 API 不变。

- 使用共享 Bridge 路由清单注册和分发 MCP 工具。
- 增加内部请求超时、重复 `requestId` 检查、消息大小限制和有限挂起请求队列。
- 增强多客户端 Bridge 消息校验，保持可选的本机 token 认证。
- 修复客户端模式内部转发在主 Server 排队期间过早按执行超时失败的问题；辅助 Server 现在等待主 Server 的 `bridge/task-started` 回执后才开始执行超时计时。
- 修复交互式 `component_place` 轮询和关闭控制路径被误判为写操作的问题，避免短暂读取超时触发不必要的恢复隔离。
- 对客户端模式内部转发应用与主 Server 相同的挂起请求上限。
- 修复 Bridge 客户端先于 Server 超时时未创建恢复诊断的问题；超时结果现在携带结构化 `BRIDGE_TASK_TIMEOUT` 标记和超时时间，并进入同一写隔离流程。
- 加固受控恢复：恢复绑定显式超时 `requestId`，拒绝 `layout-check mode=fix` 回读写入，断开源客户端仍可通过隔离诊断恢复；目标客户端断开后可由新连接世代重新绑定，同 ID 重连也会校验连接世代；未确认完成的写诊断不会因 TTL 自动解除写阻断。

- 新增 `bridge_recover_client` 的受控恢复流程：保留超时写操作诊断，要求显式确认、新的 Bridge 运行时、文档身份校验和只读回读；在确认前继续阻止写入并提示修改可能已完成。

## 2.2.2 - 2026-08-25

- 发布与 Bridge 2.1.3 配套的 Server 2.2.2 构建产物，修复 Bridge 客户端先超时场景的受控恢复诊断。
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

## 早期开发记录

- Bridge 会在心跳超时后释放挂起请求，避免失联页面永久占用活动租约；`bridge_select_client` 新增受限的 `force` 恢复选项，用于从已确认卡死的活动页面切换到新的就绪页面。
- `component_select` 支持直接传入 LCSC C 编号，并明确区分未关联 EasyEDA 器件库的商品与普通搜索未命中。

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
