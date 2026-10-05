# JLCEDA MCP Server

## 2.3.8 共享封装源保存

新增 `footprint_save`，路由 `/bridge/jlceda/footprint/save`，仅支持可选 `timeoutMs`（5000–120000 毫秒，默认 30000）。Bridge 在 EDA 内读取完整源码快照（读取时状态），核对真实库/文档/标签后写回同一共享库封装，源码不会传回 MCP 客户端，保存不额外执行七类 `getAll`。共享源更新可能影响所有引用实例，不提供仅此实例的封装重绑定。官方接口无 revision/CAS，不保证与同页人工并发编辑之间的原子保存。

成功库 ACK 返回 `saved:true`、`saveAcknowledged:true`、`scope:"library_source"`、`sharedSource:true`、`sourceLength`。ACK 后身份读取失败仍保留保存 ACK，同时返回 `ok:false`、`identityVerified:false`、`reason:"footprint_changed_after_save"`，不应直接重试。显式 false 为明确未获 ACK，返回 `saved:false`、`nativeCallSettled:true`，不证明源码未改变；undefined 是已结束但效果未知，返回 `commitUnknown:true`、`readbackRequired:true`、`nativeCallSettled:true`，不带 `saved` 或 `saveAcknowledged`，不强制宿主重启，须同库同文档完整回读恢复；RPC 未确认或超时归为 `footprint_state`，要求同库同文档七类完整 `footprint_read`。恢复回读只解除编辑状态隔离，不把 `readbackVerified:true` 当成保存或引用 PCB 持久性证明。

匹配 Server/活动 Bridge 2.3.8 的 EDA 3.2.181 / API 0.3.15 实测通过：自建共享封装 Via 0→1→0，保存两次获 ACK，冷重开完整封装 DTO 与创建状态/最终原基线严格相等；引用 PCB 冷重开 Via 也为 0→1→0，其他读取部分不变。本轮按“区分内存删除与保存，并支持共享封装源持久编辑”的范围收口 #80，板级子过孔删除本身仍不保证持久。Server `npm test`、`npm run lint`、`node verify-multi-client.mjs` 和匹配 Bridge 完整 build/lint 均通过；失败与未知保存恢复分支由本地回归验证。详见 [2.3.8 发布说明](../docs/releases/v2.3.8.md)。

## 2.3.7 原理图导线与网络标签

本轮 Server 全量 `npm test`、`npm run lint` 和 `node verify-multi-client.mjs` 已通过；匹配 Bridge 的完整 `npm run build`（含新网络标签回归、typecheck、API 文档/runtime 验证和打包）及 `npm run lint` 也已通过。匹配 2.3.7 的网标预检和导线新功能已实测通过；原 TPS552892 布局仍缺 fixture，不据此宣称匿名网络合并的宿主根因已解决。

`api_invoke eda.sch_PrimitiveWire.create` 接入 `schematic_connectivity_action wire_create` 的接触预检和逐段覆盖回读，保留官方 `line/net/color/lineWidth/lineType` 五参数及 `number[]`/`number[][]` 路径。仅该 API 可在 payload 顶层选填 `allowedWireIds`，用于明确允许接触的旧导线；其他 API 带此字段会拒绝。返回 `confirmedPrimitiveIds` 和兼容的 `confirmedPrimitiveId`，不会仅凭原生返回旧 ID 就确认整个请求路径已创建。

raw 导线创建的未知提交归为 `requiredReadback:"schematic_connectivity_primitives"`，与受控创建共用恢复流程：指定 `/bridge/jlceda/schematic/read` 和 `readbackPayload:{"includeConnectivityPrimitives":true}`，核对同一执行图页的完整连接图元及语义网表；仅查 `/context` 不能解除隔离。诊断要求宿主重启时，先重启原 EDA，再使用恢复会话后的新客户端回读。图元覆盖核验不能证明所有匿名网络都没有被宿主合并，#22 原场景仍待实机核对。

自建原理图实测拒绝未许可旧线接触和跨命名网络；授权后的五参数、多路径、小写网络名创建合并旧 ID，实际路径完整覆盖，匿名线附近短延伸也通过。完整原生 JLCEDA 网表、3 个普通器件 DTO、无关命名/匿名导线及端口/标识/标签均保持基线。该烟测不能代替缺失的原 TPS552892 布局，#22 不据此自动关闭；未知提交恢复仍由本地中继回归验证。

raw `eda.sch_PrimitiveAttribute.createNetLabel` 在已知 EDA 3.x 时返回 `EDA_VERSION_UNSUPPORTED`、`commitStatus:"not_started"`、`nativeCallAttempted:false`，不调用原生方法，也不因该拒绝进入未知提交隔离。API 索引标明从 EDA v4 起提供；4.x 或未知版本仍沿用原生调用，电源/地 NetFlag 不受影响。EDA 3.2.181 与匹配 2.3.7 实测中，raw/semantic 预检后完整连接读取不变，9 个混合版本客户端 ready、心跳正常，2.3.6 待命客户端完整读取也不变。本轮修复 #26 已知 3.x 触发路径，不宣称宿主内部全部失联已根治，EDA v4 未实测。详见 [2.3.7 发布说明](../docs/releases/v2.3.7.md)。

## 2.3.6 独立封装编辑

Bridge 将官方 `getCurrentDocumentInfo()` 返回的 `documentType:4` 识别为 `pageKind:"footprint"`，身份包含 `documentUuid`、`pageUuid`、`libraryUuid` 和 `tabId`；其中 `pageUuid` 为该封装文档 UUID。库身份优先取匹配当前文档的实际 `<documentUuid>@<libraryUuid>` 标签；含 `@` 但文档前缀不符或库 UUID 缺失时拒绝，无 `@` 的旧式标签兼容当前文档的 `parentLibraryUuid`。EDA 3.2.181 跨库切换时该字段可能滞留旧值，不能覆盖匹配当前文档的实际库标签。独立封装可建立连接，无需工程 UUID；已有 PCB 或工程缓存不作为封装身份。`eda_context` 返回 `footprintContext`，`bridge_clients` 显示同一组身份。

先调用 `footprint_read` 获取当前文档全部图元。仅支持可选 `timeoutMs`（5–120 秒，默认 60 秒），不支持 sections 或过滤；成功结果包含 `scope:"current_footprint_document"`、`complete:true`、七类数组及数量。Pad 保留焊盘/孔形状、孔偏移、孔旋转和 `padType`，Polyline 保留原生 `polygonSource` 数组，Attribute 保留父 ID、key/value、显示状态及可为空的坐标。对象与全 ID 清单不一致、必要 getter 缺失、读取中换库/文档/标签或超出 10000 图元/8 MiB 时返回 `complete:false`，不会以截断数据声明完整。

无孔 Pad（`hole:null`）的原生 `holeRotation` 为 `null`、`undefined` 或数值 NaN 时，DTO 明确返回 `null`；有限值原样保留，带孔状态仍要求有限孔旋转。`specialPad:[]` 表示没有额外特殊轮廓，原样保留；`pad` 或 `specialPad` 至少有一个真实非空形状，必要 getter 和焊盘/孔形状检查仍保留。同库同封装 3 个 Pad、1 个 Via、1 个 String 的 `complete:true` 快照、正式受控恢复，以及原生源码写回后重开的 5 个完整 DTO 一致已实测通过。最终 SMD x130/y80、60×60 状态已再次源码写回并关闭重开，5 个完整 DTO 一致。

启用透传 API 工具后，`api_invoke` 支持以下首批封装画布方法，共 21 个读取方法和 20 个写入方法：

| 原生模块 | 读取 | 写入 |
| --- | --- | --- |
| `pcb_PrimitivePad/Via/Line/Arc/Polyline/String`（六个模块） | `get`、`getAll`、`getAllPrimitiveId` | `create`、`modify`、`delete` |
| `pcb_PrimitiveAttribute` | `get`、`getAll`、`getAllPrimitiveId` | `modify`、`delete` |

方法名使用完整路径，例如 `eda.pcb_PrimitiveLine.modify`。参数按当前官方签名传入；修改/删除目标须来自本次实际回读的 ID。Polyline 创建可传原生轮廓源数组，修改可传 `polygonSource`；Bridge 转换成 `pcb_MathPolygon` 对象后调用。`get`、`getAll` 及创建/修改后的 `after` 使用完整 DTO，`getAllPrimitiveId` 返回 ID 列表；`identityVerified:true` 只表示操作前后库、文档和标签一致，字段值应以实际 `after` 为准。七类 `modify` 等待一次 `done()` 后重新读取，字段未生效时返回 `ok:false`、`reason:"native_footprint_modify_incomplete"`、`fieldMismatches`（field/requested/actual）和真实 `after`；已完成且完整回读可确认的差异不触发未知提交隔离。Polyline 的等价闭合轮廓方向、起点及已有精度规范化不误报字段差异，仍保留原生 source。删除返回 `deletedIds` 和 `remainingIds`。

封装编辑器拒绝 PCB/原理图专用工具和未列入首批范围的画布 API。官方 `pcb_PrimitiveAttribute.create` 为内部空实现，因此不开放；库资源查询及 `lib_Footprint.openInEditor` 等全局 API 保持通用调用方式。写入前最后一次身份检查后立即核对连接、活动角色和租约，切换客户端或断连会停止尚未开始的原生写入。

封装写入返回 `commitUnknown:true`、超时或中途失联时，按 `bridge_clients` 的诊断先执行 `bridge_recover_client action:recover`。诊断要求宿主重启时，重启原 EDA 并打开同库同封装文档；使用恢复会话后的全新客户端做 `action:readback`，指定 `readbackPath:"/bridge/jlceda/footprint/read"` 和 `readbackPayload:{}`。Server 核对执行时库/文档身份、七类完整状态及本次回读前后的标签。重开后的新 `tabId` 可以不同于旧任务，但同一次回读不能换标签；仅查询 `/context` 无法解除该隔离。

Via/Line/Polyline/String/独立 Arc 新案例的创建、修改和删除已实测通过。SMD Pad 位置改到 x130 生效，但 80×60 形状请求仍为 60×60，返回已知部分结果；首次 layer3 水平弦 Arc 未登记，具体原因未确定。Attribute 没有实际非空样本，未进行 native 修改/删除验证。个人封装的 5 个控制图元持久回读不能证明 PCB 封装子过孔持久删除（#80），2.3.6 当时未收口该 Issue。封装菜单可见，菜单重启后新客户端 ready、公开选择与 count5 完整回读通过；就绪报告发送失败后的重连分支仅由本地 fixture 验证。发布状态以同版本 GitHub Release 及关联 PR 为准，EDA v4 未验证。详见 [2.3.6 发布说明与回归清单](../docs/releases/v2.3.6.md)。

## 原理图 raw 创建位号保护

`api_invoke eda.sch_PrimitiveComponent.create` 现在复用自动放置的当前页位号基线和恢复流程：恢复被原生创建重排的已有位号，保留 BOM 扩展属性并回读新图元。成功返回 `designatorChanges`、`restoredDesignators`；无法确认恢复时给出 `needsReview` 或未知提交诊断。未知提交沿用 placement 恢复，须读回原页完整 ID、位号及 BOM，不能仅查上下文。完整 DeviceItem、DeviceSearchItem、SymbolItem、SymbolSearchItem 与正式库引用保留原生重载和参数；实机新件的 BOM/PCB false 保留，已有 9 件完整 DTO 不变；本次未发生位号重排，`restoredDesignators:[]`。U4/U5 重排后的恢复、显式 false 参数与恢复超时由本地回归验证。

## 2.3.5 发布检查记录

稳定版 [2.3.5](https://github.com/hs150521/JLCEDA-MCP-Community/releases/tag/v2.3.5) 已发布，GitHub 发布状态以 Release 页面为准。两轮本地全面审查、Bridge/Server 全量构建测试及 lint 已通过，2.3.5 的发布实机验证使用匹配的 Server 与 Bridge。器件批量放置、NC 切换、名称筛选、NetPort Name 查询、原理图导出，以及 PCB BOM、板框、区域、直线覆盖、旋转、属性、元数据和覆铜重建已实测通过；过孔创建/修改、工程库来源核对、覆铜等价轮廓创建/修改及真实 DRC 28 条详情的 14 页连续读取均已实测通过。安装包的可用状态以 [GitHub Release](https://github.com/hs150521/JLCEDA-MCP-Community/releases) 为准。完整 Issue 矩阵见 [2.3.5 验证记录](https://github.com/hs150521/JLCEDA-MCP-Community/blob/v2.3.5/docs/issue-validation-2.3.5.md)。

发布审查补修：普通 Pin 与 ComponentPin 按实际执行路径区分超时恢复；ComponentPin 仍要求所属器件全部引脚的完整回读。直线拆分/合并核验记录同网络、同层写前快照，要求本次新增或改变的有效线路，并返回 `changedPrimitiveIds`。过孔修改核对实际外径大于孔径，量化后的零环宽返回实际状态与差异。

普通 Pin 与 ComponentPin 共用原生 RPC 未确认分类；WebSocket is not open、transport closed、ECONNABORTED 等断连结果均返回 nativeCallSettled:false，并要求原宿主重启后完整回读。已结束但状态不匹配的调用仍区分为 nativeCallSettled:true。三种断连在两条实际处理路径、宿主重启策略与状态漂移分支均有针对性回归，已通过两轮本地复查。 同样统一图页导航与 PCB 直线/过孔创建的断连分类；回归包含原生状态已改变后才抛错的场景，继续要求宿主重启。

名称属性查询的所有页固定使用关键词搜索，并在本地核对全部请求属性，返回 `searchImplementation:"keyword_name_filter"`；`mayHaveMore` 仍依据原生候选页，避免每页切换搜索后端。裸器件引用明确指定库时，同时核对返回记录的器件 UUID 与库 UUID，不一致则在创建前返回 `DEVICE_LOOKUP_MISMATCH`。

2.3.5 改进器件库引用解析、真实 ComponentPin 的 NC 修改、覆铜逐实例重建、PCB 等价几何回读、器件部分修改诊断、PCB 属性文字输入校验、制造导出分支格式校验、DRC 详情分页和非字符串错误传输。原生未解决项及待验证场景见下文。


`bridge_recover_client` 的完整回读不再被固定 15 秒截断；可设置 `timeoutMs`，大原理图最多 120 秒。`schematic_read` 同样支持最长 120 秒的读取预算。

2.3.4 新增 `board_setup`，可在当前工程创建关联的 Board、原理图和 PCB，或将现有游离原理图与新 PCB 关联。此前 2.3.3 新增工程内图页导航、原理图文字/导线/器件以及 PCB 文字/区域/板框/覆铜/布线/器件的读写工具，并完善导入预检和操作回读。Server 与 Bridge 应安装匹配版本；`JLCEDA_BRIDGE_TOKEN` 仍为可选配置。

工具分发异常和 Bridge 上报的结构化诊断日志会输出到 Server 的 stderr。分发异常记录工具、Bridge 路由、可用的错误码与异常堆栈，并附带版本及构建日期水印；构建日期在打包时固定。

`component_select` 的关键词与精确属性搜索、`design_compare` 的网表/原理图/PCB 比较现在都能通过 Server 的输入校验并进入 Bridge。

`component_place` 等待用户按 Esc 或右键退出当前放置模式后才启动下一件；Bridge 会把当前页器件对象与 ID 列表一起核对，避免 ID 列表更新较慢时漏报已提交器件。完全重叠的重复图元经核对后清理，并透传新增与清理的图元 ID。已有器件位号被 EDA 改动时，会保留 BOM 属性并尝试恢复原位号，结果列于 `restoredDesignators`；未恢复、失联或超时则停止批次，不自动重试未知是否已提交的操作。

`component_place_auto` 按坐标逐件创建；若 EDA 改变已有器件或本批次此前放置器件的位号，会保留 BOM 属性并尝试一次恢复。恢复失败时停止后续放置，返回位号变化及已放置器件的当前位号。

`bridge_clients` 和 `bridge_select_client` 用于在已连接的 EDA 页面客户端之间切换 MCP 路由。显式选择待命客户端前，Server 会发送短时双向探活，并等待其串行任务队列回传确认；探活失败不会更改活动客户端或租约。旧版 Bridge 未声明探活能力时仍可连接，但须升级后才能显式选中待命页面。它们不会切换同一个 EDA 进程中的可见标签页；进程内打开或激活文档使用 `editor_navigate`，成功后会核对文档、图页和标签身份。

`bridge_recover_client` 用于不可取消 EDA 修改超时后的受控恢复。先从 `bridge_clients` 取得具体 `requestId`，再以 `action=recover` 建立恢复会话。若原 EDA Promise 一直挂起，此后须重启原 EDA 宿主以终止旧调用，并重新打开目标图页；保持 MCP Server 运行以保留诊断。原调用正常结束时 Bridge 会自行重连。等待原 Bridge 连接断开、恢复会话建立后的新 Bridge 连接就绪，再用全新 `clientId` 做身份校验和只读 `action=readback`。普通掉线自动重连会沿用旧 `clientId`，即使 WebSocket 已更换也不能用于本次回读；建立恢复会话时已连接的其他客户端同样不能通过重连解除隔离。当前页绑定的写入必须有任务执行时的 `pageUuid`，不能用旧心跳或手填 `expectedPageUuid` 代替。原理图器件批量删除绑定执行时的当前图页，恢复时以 `schematic_read includeConnectivityPrimitives:true` 回读原页；其他非页面操作应显式给出目标 `expectedDocumentUuid` 或 `expectedProjectUuid`，已确认签名的工程改名 API 会使用其参数中的目标工程 UUID。使用新增操作及其恢复回读时，应同时安装匹配版本的 Bridge 与 Server；2.3.1 Bridge 可正常连接，但旧版页面写入缺少执行身份时会保留隔离。回读完成前，EDA 写操作都会被阻止；普通只读查询可执行，但原调用挂起时结果只是暂时快照。`schematic_layout_check` 的 `mode: "fix"` 按写操作隔离。

PCB `import_changes` 返回 `pending_confirmation` 后，Server 将其列为全局写入阻断诊断。用户在原 EDA 对话框应用或取消并确认关闭后，使用诊断中的 `requestId` 调用 `bridge_recover_client`，传入 `action:"resolve_import"`、`confirm:true`、`resolution:"applied"` 或 `"cancelled"`。Server 核对原连接及 PCB 文档/图页，完整读回器件和网络；Bridge 收到同页解除确认后才恢复写入。只读查询在此期间仍可用，但 EDA API 不提供确认框完成事件，读回本身不能证明对话框已关闭。无法确认时以 `action:"recover"` 建立恢复会话，重启原 EDA 宿主，再用全新连接、`hostRestartConfirmed:true`、无参数 `eda.pcb_PrimitiveComponent.getAll` 做 `action:"readback"`；Server 还会分页读取完整网络名称。

Bridge 会在当前 PCB 与编辑器文档身份尚未同步时返回 `pcb_page_not_ready`，在 PCB 未归属板时返回 `pcb_not_associated_with_board`；两者均不执行 `import_changes` 原生调用，也不会进入导入确认或写入恢复流程。

恢复时必须从 `bridge_clients` 选择具体超时写操作的 `requestId`；`readbackPath` 与 `readbackPayload` 始终只能描述只读操作，恢复目标客户端在首次回读后锁定。多个未解决的超时写操作会继续保持写阻断，直到各自收到迟到结果或完成受控恢复；未确认完成的写诊断不会因 TTL 自动放行写入。

已开始的写任务若因页面失联、心跳停滞或 MCP 调用方断开而无法确认完成，也会留下同样的诊断；`uncertaintyReason` 标明失联原因。重连等待期届满不会自动解除写阻断。

原理图当前页器件 ID 回读建议使用 `readbackPath: "/bridge/jlceda/api/invoke"` 和 `readbackPayload: {"apiFullName":"eda.sch_PrimitiveComponent.getAllPrimitiveId","args":[null,false]}`。`getAllPrimitiveId` 和 `getAll` 的 `args:[null,false]` 被严格识别为当前页只读查询；无参数调用继续兼容，但部分 EDA 版本可能混入其他图页。`allSchematicPages: true` 不适合当前页恢复判断。`bridge_clients` 的 `ready` 依据最近心跳判定，`lastHeartbeatMsAgo` 可用于识别仅有其他消息但心跳已停的客户端。

PCB 器件位置回读可将 `readbackPath` 设为 `/bridge/jlceda/api/invoke`，`readbackPayload` 设为 `{"apiFullName":"eda.pcb_PrimitiveComponent.getAll","args":[]}`；Server 会自动请求不截断的 `componentPositions`。布局前也可直接调用 `api_invoke` 并传入 `includeCompletePositions:true` 取得全量位置，同时保留通用 `result` 字段。若原操作是 `eda.pcb_Document.autoLayout` 且提交状态未知，先以 `action=recover` 建立会话，再关闭并重启原 EDA 宿主，保持 MCP Server 运行；旧 Bridge 连接断开、恢复请求后的新客户端连接同一 PCB 后，传 `hostRestartConfirmed:true` 执行完整位置回读。仅查 `/context` 不会解除写入阻断。恢复期仅放行此 PCB 方法的无参数形式；带图层或锁定筛选参数的调用仍被隔离。若任务启动时未取得实际 PCB UUID，不能用过期的心跳图页或自行填写的 UUID 解除自动布局隔离。

PCB `autoRouting` 指定网络时使用 `RoutingNets:["网络名"]`；Bridge 在原生 `result` 外返回请求网络和超出请求范围的报告诊断。明确指定最多 3 个网络而原生 RPC 超时时，`routingObservation` 报告同页网络图元与长度的即时变化，但只是暂时快照，Server 仍留下写入隔离诊断。先执行 `action=recover`，再关闭并重启原 EDA 宿主；全新 Bridge 客户端打开任务执行时的同一 PCB 后，调用 `action=readback`，设置 `hostRestartConfirmed:true`、`readbackPath:"/bridge/jlceda/api/invoke"`、`readbackPayload:{"apiFullName":"eda.pcb_PrimitiveLine.getAll","args":[]}`。Server 会在分段读取前后核对 PCB 身份，自动完整读回直线、圆弧、折线、过孔的图元 ID、网络、层与几何，以及全部网络长度。任何一段失败都继续阻断写入。直接调用四类无参数 `getAll` 时可传 `includeCompleteRouting:true` 获取相同的不截断图元快照。

更新磁盘上的 Server 构建后，须重启已运行的 MCP Server 进程；旧进程不会载入新的工具契约和恢复校验。恢复前在 `bridge_clients` 核对诊断中的 `requiredReadback` 与 `hostRestartRequired`，自动布线超时应分别为 `pcb_routing_state` 和 `true`。
自动布线恢复的完整快照保留板框、丝印等无网络折线的 `net:null`、ID 和几何；`net` 字段缺失或几何不完整时仍阻止写入。

`pcb_connectivity_action` 提供 `line_create` 与 `via_create`。调用前用 `pcb_net_query` 核对网络名，并用 `pcb_layer_query` 选择启用且未锁定的铜层（SIGNAL 或 PLANE）；独立 PCB 需要创建新网络时显式传 `allowNewNet:true`。坐标和尺寸使用当前 PCB 数据单位，导线宽度、过孔孔径与外径都必须给正值。原生创建返回后会回读图元；若结果未确认，Server 隔离后续写入，并要求新 Bridge 客户端对同一 PCB 完整回读直线、圆弧、折线、过孔和网络。诊断的 `hostRestartRequired:true` 表示原生调用可能尚未结束，恢复前还必须重启原 EDA 宿主并传 `hostRestartConfirmed:true`；若原生调用已结束、只是回读失败，则不要求宿主重启。回读参数与上方自动布线相同。

`pcb_net_query` 的 `mode:"exact"` 可通过 `analysis.primitiveTypes` 按官方图元类型名称筛选。Bridge 在 EDA 内无筛选读取网络图元后执行类型匹配，规避 EDA 3.2.181 的原生筛选返回空数组。

Bridge 客户端超时会返回带 `BRIDGE_TASK_TIMEOUT` 标记的结果；Server 会将该结果纳入同一受控恢复诊断流程，不要求必须等 Server 自身的备用计时器触发。

`schematic_connectivity_action` 的导线或 NetPort 写入返回 `commitUnknown: true` 时，即使按时收到结果，Server 也会建立未确认写入诊断并阻止后续写入；这包括原生调用超时以及写入成功但紧接的图元回读失败。Server 超时后的迟到结果同样保留诊断。导线创建、NetPort 创建或移动必须用 `bridge_recover_client action=readback` 指定 `readbackPath:"/bridge/jlceda/schematic/read"`、`readbackPayload:{"includeConnectivityPrimitives":true}`；Server 核对原图页完整导线 ID/几何、NetPort ID/网络/坐标、NET 属性和语义网表。诊断包含 `hostRestartRequired:true` 时先重启原宿主并传 `hostRestartConfirmed:true`；读回失败继续隔离，只查 `/context` 不会解除。

`schematic_read` 在普通读取和完整连接回读前后核对当前图页 UUID 与编辑器文档 UUID，并比对当前页器件对象与图元 ID 列表；设置 `includeConnectivityPrimitives:true` 时还比对导线对象与 ID 列表。若读取期间身份或列表未同步，则返回 `PAGE_NOT_READY`，等待加载后重试。复制页可以合法复用源页图元 ID。不要把未同步的快照用于放置或解除写入隔离；成功结果包含 `pageUuid`。

`wire_create` 与 raw `eda.sch_PrimitiveWire.create` 均要求实际导线完整覆盖请求路径，且覆盖路径上存在本次有效变化；拆分/合并可由多个实际 ID 共同覆盖，返回 `confirmedPrimitiveIds` 并保留 `confirmedPrimitiveId`。成功后仍须用 `schematic_read includeConnectivityPrimitives:true` 核对同页实际语义连接；返回的 `net` 是按原生大写规则归一后的请求名，未指定时为 `null`，不能代替网表。路径不完整或无法确认时保留 `commitUnknown`，按诊断完整回读；该读取也可用于其他当前页连线核查。

## 2.3.5 回读与操作说明

### 器件库、引脚与原理图检查

`component_place`、`component_place_auto` 及原理图设备引用创建在客户端提供 `lib_Device.get()` 时先读取设备库，将有效裸引用解析为完整 DeviceItem 后调用原生创建；找不到设备时返回 `DEVICE_NOT_FOUND` 且不启动创建。完整 DeviceItem/SearchItem 与符号引用保留各自原生重载；客户端未提供设备查询时保留裸引用的原生兼容路径。单子件设备可自动采用唯一的 `subPartName`。33 字符的错误设备 UUID 与其正确 32 字符系统库记录已区分。2.3.4 实机一次性图页中，通过 `lib_Device.get()` 的完整 DeviceItem 与唯一 `subPartName`，连续创建 0603 C23221 及 0805 C96346/C84376/C110775；四次原生创建各约 1–2 秒，`schematic_read` 完整回读确认 4 件且无写入隔离。2.3.5 实机中，无效 UUID 立即返回 `DEVICE_NOT_FOUND`；随后 `component_place_auto` 的上述 4 型号批次全部成功，合计约 8.9 秒。

设备 `library_search` 的 `properties.name` 搜索会精确核对实际返回名称；各页固定使用关键词搜索并同时核对全部请求属性，返回 `exactNameVerified`、`searchImplementation` 和 `excludedNameMismatches`。2.3.5 最终实机以 limit:1 连续查询两页，分别返回 1 条精确匹配和空页，均采用 keyword_name_filter，第二页 mayHaveMore:false。这些结果仍受原生分页范围限制。

`api_invoke` 调用 `eda.sch_PrimitivePin.modify` 时，若目标为当前页器件的 ComponentPin，Bridge 改用真实实例的 `toAsync()`、`setState_NoConnected()`/`setState_PinNumber()` 和 `done()`，只支持 `noConnected`、`pinNumber`。提交前后核对该器件各引脚状态；不会为 NC 修改重写符号引脚几何。失败恢复归为 `schematic_connectivity_primitives`：使用 `bridge_recover_client action=readback`，指定 `readbackPath:"/bridge/jlceda/schematic/read"`、`readbackPayload:{"includeConnectivityPrimitives":true}`。语义快照包含 `pinId`、`x`、`y`、`rotation`、`noConnected`，恢复时须核对目标所属器件全部引脚的真实状态；仅查询 `/context` 不会解除隔离。诊断要求宿主重启时先重启原 EDA 宿主。2.3.5 实机对同一 ComponentPin 的 NC `true`→`false` 两次均 `verified:true`，目标坐标与同器件其他引脚均保持不变。失败后的恢复路径已有本地回归，未在该成功场景中触发。

`schematic_document_action` 依据父图元属性查询与按 ID 查询纠正绑定属性类型，保留真实父 ID、键、值和几何。无参数 `sch_PrimitiveAttribute.getAll()` 只返回独立属性；带父图元参数的 `getAll(parentPrimitiveId)` 与 `get([primitiveId])` 可读取绑定的 Name Attribute。2.3.5 最终实机类型查询、单件读取和批量读取均将 NetPort Name 返回为 Attribute；单件与批量结果的父 ID、Name 值和坐标一致。现有点导线转换为多线段路径会在原生修改前返回 `point_wire_path_conversion_unsupported`，并给出 `before`、`requested`；需要该路径时，新建导线、核对几何及网络，再显式删除原点导线。写后几何不匹配会返回实际 `after`。

`manufacture_export` 仅在选定 `domain` / `kind` 的分支计算参数和校验格式，避免其他导出分支提前触发不相关校验。BOM 使用 CSV/XLSX，图纸文档使用 PDF/PNG/SVG，标准与仿真网表分别核对自身 `netlistType`；PCB BOM 及其他制造导出同样使用自己的分支。2.3.5 实机原理图 BOM CSV（740 B）、JLCEDA 网表（18,883 B）、PDF 文档（35,886 B）与 PCB BOM CSV（334 B）均生成成功；其他导出类型仍按验证记录逐项核对。

### PCB 原生归一化与诊断

`pcb_component_edit` 按模 360 度核对旋转，因此 `-90` 与 `270` 等价，成功结果可包含 `normalization.rotation`；2.3.5 实机修改 `-90` 后回读 `270` 已验证。实机 `supplierId` 与 `otherProperty` 修改也已按实际状态验证。元数据部分写入不匹配时，返回实际 `after`、`failureKind:"state_mismatch"`、`mismatches`、`mismatchCount` 和 `mismatchesComplete`；`nativeCallSettled:true` 表示原生调用已结束。该失败仍保留 `commitUnknown` 和受控回读要求，按诊断核对后再决定后续操作。创建时若原生将设备或封装复制进工程库，须以创建返回的来源引用与请求来源或同 ID 回读的一致性确认，返回 `normalization.source`；实机创建已核对新 ID、实际位置、270° 旋转与工程库来源引用。

`pcb_board_outline_manage` 的闭合轮廓比较支持等价起点循环移动与方向反转；开放折线路径只接受完整路径反向，不接受循环换起点。`pcb_region_manage` 比较已闭合的区域轮廓，允许等价起点及方向变化；多点轮廓写入须显式首尾闭合。比较保留圆弧/曲线语义。对 EDA 3.2.181 已观察的四位小数坐标回读，使用每坐标 `0.00005 mil` 容差；真实几何差异仍报告不匹配。返回值保留实际轮廓及归一化诊断。2.3.5 实机板框反向回读、显式闭合区域反向及四位小数坐标回读均已验证。

`pcb_connectivity_action line_create` 可核对端点反向，以及原生拆分/合并后同网络、同层、同宽的共线图元是否覆盖请求线段；结果返回实际 `primitiveIds`、`returnedPrimitiveId`、`after` 和 `normalization`。2.3.5 实机共线覆盖回读返回 2 个实际 ID 并验证成功。`via_create` 与 `pcb_routing_edit` 过孔尺寸修改只接受精确尺寸或 EDA 3.2.181 实测的 0.2 mil 网格最近值（`round_0_2_mil`），返回请求值、实际孔径/外径与归一化方式，位置和网络仍须匹配；创建与修改已实测通过：15.748/31.496→15.8/31.4、15.7/31.5→15.8/31.6。

`pcb_routing_edit` 删除过孔前检查原生网络图元：已知父器件 ID 时返回 `footprint_owned_via` 且不调用删除；缺少父字段时返回的归属为未知。删除后目标从完整 ID 列表消失，只证明当前页内存已删除，结果带 `verificationScope:"current_page_memory"`、`durableDeletionVerified:false`、`requiredPersistenceVerification:"save_and_reopen_pcb"`。板级删除本身不保证持久；需要共享源修改时，在实际独立封装中编辑并 `footprint_save`，再冷重开封装和引用 PCB 完整核对，不支持仅此实例封装重绑定。

`pcb_pour_manage rebuild` 优先使用批量 `rebuildCopperRegions()`；缺少批量方法时尝试目标实例的 `rebuildCopperRegion()`。两者均不可用则返回 `reason:"unsupported_capability"`、`errorCode:"EDA_CAPABILITY_UNAVAILABLE"`、缺失 API 和可用的 EDA 版本，明确 `applied:false`。2.3.5 实机全板重建已验证 1 个边框与 1 个填充；批量、实例回退和能力缺失分支另有本地回归。创建或修改允许闭合轮廓等价反向、起点变化及已观察的四位小数回读，返回实际轮廓与 `normalization`；实机创建与修改均确认反向和四位小数轮廓等价；实际优先级副作用另行报告。`pcb_text_manage` 的 Attribute 修改支持 `property.value` 和 `property.valueVisible` 通过 Server 校验，实机两字段修改及实际回读已验证。

### DRC 分页与错误传输

`pcb_drc_check` 支持非负整数 `offset` 与 1–500 的 `limit`，默认每次最多 120 条详情。按照返回的 `nextOffset` 继续读取，直到该字段不再返回。结果包含 `totalAvailableDetails`、`returnedDetails`、`nativeTruncated`、`serializationTruncated` 和 `truncated`；分页只能覆盖原生提供的详情，不能补出原生未返回的错误。真实分类树按叶子明细分页；含 28 个错误的 PCB 已按 limit:2 连续读取 14 页，nextOffset 正确结束，直线端点为数值，两种截断标志均 false。

结构化错误在 Bridge、WebSocket、中继和工具分发层保留可用的 `message`、`name`、`code`、`reason`、`field`、`status`；非字符串对象错误不会只显示为 `[object Object]`。错误正文不透传任意源对象或设计源字段。

2.3.5 的独立封装编辑器尚无专用 Bridge 文档上下文；2.3.6已补充单独的封装身份和首批读写能力，实机结果按上方回归清单记录。

## 工具说明

`schematic_layout_check` 对当前原理图执行保守的符号/引脚/属性/导线矩形碰撞检查，并显式报告属性几何和页面边界能力是否可用。修复模式需要 `confirm: true`，只移动属性文本，不改变电气连接。

`schematic_connectivity_action` 提供 `wire_preview`、`wire_create`、`netport_create` 和 `netport_move`。新导线的 `line` 最多包含 512 个数（256 个坐标点）。先预览导线与现有导线的电气接触，再把确实要连接的导线 ID 传给 `allowedWireIds`；没有连接点的纯十字交叉不算接触，不同已命名网络的接触会被拒绝。创建后返回受影响导线 ID，仍需复查网表。NetPort 在当前图页创建或移动并回读图元；移动期间核对图页与编辑器文档 UUID 及当前图元列表。新建时还返回目标网络的引脚列表。NetPort 是层次图端口，可用于同页连接，不应当作跨页连接标识。

`schematic_wire_manage` 的 `read` 默认返回当前页全部导线的完整 JSON 快照，指定 `primitiveId` 时只返回目标导线。`modify` 按 ID 更新单条导线的 `line`、`net`、`color`、`lineWidth` 或 `lineType`；几何必须为平铺的正交坐标，接触其他导线时需用 `allowedWireIds` 明确允许。网络改名只允许未接触其他导线或显式网络标识的单条导线。`delete` 按 ID 删除单条导线。写入后核对当前图页和目标状态。若返回 `commitUnknown:true`，使用 `bridge_recover_client action=readback`，指定 `readbackPath:"/bridge/jlceda/schematic/read"`、`readbackPayload:{"includeConnectivityPrimitives":true}`，核对完整导线、端口及网络属性；诊断要求时先重启原 EDA 宿主。

`schematic_text_manage` 的 `read` 返回当前页全部文字标注或指定 `primitiveId` 的单条文字；`create` 至少传入 `x`、`y`、`content`，可选旋转、颜色和字体；`delete` 按 ID 删除。现场 EDA 3.2.181 / API 0.3.15 修改已有文字会破坏对齐方式，本工具暂不提供 `modify`，也拒绝显式写入 `alignMode`。若原文字使用默认对齐，可先 `read` 记录属性，再 `delete` 和 `create` 来变更文字；新文字会得到新 ID。非默认对齐无法借此无损重建。每次写入后核对同页目标状态。若返回 `commitUnknown:true`，使用 `bridge_recover_client action=readback`，指定 `readbackPath:"/bridge/jlceda/schematic/text-manage"`、`readbackPayload:{"action":"read"}`，完整回读原图页文字；诊断要求时先重启原 EDA 宿主。

`schematic_component_edit` 的 `read` 返回当前原理图页全部普通器件的完整状态；`modify` 用 `primitiveId` 和 `property` 修改单个器件的位置、方向、位号或属性，`delete` 按 ID 删除一个器件。`property.otherProperty` 与已有 BOM 扩展属性合并；其余未指定字段保持原值。写入后核对目标 ID 和请求的状态变化；几何修改还比较目标器件各引脚网络。`pin_network_changed` 会列出误接引脚并隔离写入，恢复时需对同页执行 `schematic_read`，设置 `includeConnectivityPrimitives:true`，核对连接图元和语义网表后修正。其他 `commitUnknown:true` 使用 `bridge_recover_client action=readback`，指定 `readbackPath:"/bridge/jlceda/schematic/component-edit"`、`readbackPayload:{"action":"read"}`，完整读回执行时的原图页；诊断要求宿主重启时先重启原 EDA 宿主。

需要一次调用批量删除时，`api_invoke` 可传 `apiFullName:"eda.sch_PrimitiveComponent.delete"`、`args:[["ID1","ID2"]]`。Bridge 将数组拆成单个原生删除，并按执行时的当前图页逐项回读，返回 `deletedIds` 和 `failedIds`；复制图页与原页可共享 ID，不会把原页的同名 ID 当作当前页残留。`schematic_read` 也依据图页和编辑器文档身份、当前页对象与 ID 列表的一致性核验，不把共享 ID 当作切页失败。

`pcb_component_edit` 的 `read` 返回当前 PCB 全部器件的不截断状态。`create` 接受设备或封装的库引用、顶层或底层、坐标与可选角度；`modify` 按 ID 修改单个器件的层、坐标、角度、锁定状态、位号或 BOM 属性，`delete` 按 ID 删除单个器件。修改 `otherProperty` 时会保留未指定的已有键。每次写入后重新读取并核对当前 PCB。提交状态不明时，`bridge_recover_client action=readback` 必须使用 `readbackPath:"/bridge/jlceda/pcb/component-edit"` 和 `readbackPayload:{"action":"read"}`，核对同一 PCB 的完整器件快照；诊断要求宿主重启时先重启原宿主。

`pcb_pour_manage` 的 `read` 返回当前 PCB 全部覆铜边框和已填充区域的 ID、关联、填充数量及几何摘要。`create` 接受已有网络、铜层及 `polygonSource` 数组，例如 `["R",100,200,300,400,0,0]`；`modify` 可更改单个边框的轮廓与设置，`delete` 删除单个边框。EDA 3.2.181 的原生创建和修改都可能调整覆铜优先级；完整回读发现请求值或未请求字段发生偏差时返回 `applied:true`、`verified:false`、`before/after/sideEffects`，写入状态已明确，无需执行未知提交恢复。`rebuild` 只在明确调用时重建指定边框或全板填充，必须核对完整返回集合和写后状态；单件重建未生成目标填充、删除后仍有关联填充时返回 `verified:false` 和已读回状态。原生重建报错也可能已改变填充，遇到 `commitUnknown:true` 时使用 `bridge_recover_client action=readback`，指定 `readbackPath:"/bridge/jlceda/pcb/pour-manage"`、`readbackPayload:{"action":"read"}`，核对同一 PCB 的全部边框和填充摘要；诊断要求宿主重启时先重启原宿主。

`pcb_routing_edit` 的 `read` 可完整返回当前 PCB 铜层的直线、圆弧、折线和过孔，也可用 `kind` 与 `primitiveId` 精确读取；非铜层图形不作为走线返回。`create` 支持圆弧和折线，后者接受可序列化的 `polygonSource`；直线和过孔的创建使用 `pcb_connectivity_action`。`modify`、`delete` 按类型和 ID 操作单个图元；删除后以同类 `getAll` 的 ID 列表确认目标消失。写入结果不明时，使用 `bridge_recover_client action=readback`，指定 `readbackPath:"/bridge/jlceda/api/invoke"`、`readbackPayload:{"apiFullName":"eda.pcb_PrimitiveLine.getAll","args":[]}`；Server 会继续读取圆弧、折线、过孔和网络，并核对原 PCB。诊断要求宿主重启时先重启原宿主。

`pcb_board_outline_manage` 的 `read` 返回当前 PCB 板框层 11 的直线、圆弧和折线，或按 `kind` 与 `primitiveId` 读取单个图元。`create` 使用板框层与空网络，EDA 回读也可能为 `null`；`modify` 和 `delete` 仅接受板框层图元，折线接受可序列化的 `polygonSource`；一段轮廓无需独立闭合。写后回读同板图元；创建未新增图元时返回 `applied:false`，新增图元与请求不符时返回 `applied:true`、实际图元和差异。结果不明时用 `bridge_recover_client action=readback` 指定无参数 `eda.pcb_PrimitiveLine.getAll`，Server 会补读圆弧、折线、过孔和网络，再由调用者核对板框变化；诊断要求宿主重启时先重启原宿主。

`pcb_read` 默认读取当前 PCB 的器件和网络；`sections` 可从 `components`、`pads`、`nets`、`routing`、`pours`、`outline`、`regions`、`text` 中选择，或传 `["all"]`。结果包含同一 `pageUuid`、`includedSections`、`omittedSections` 和所选部分的不截断数组及数量。`text` 包含独立文本与器件属性；`pads` 包括独立焊盘和器件焊盘的 ID、父器件 ID、层、焊盘号、位置、角度、网络及焊盘类型；逐件读取器件焊盘可能较慢，可调整 `timeoutMs`。复杂焊盘外形不在此语义快照中。任一所选部分读取失败或图页改变时整次调用失败。

`pcb_region_manage` 的 `read` 返回当前 PCB 全部禁止区域和约束区域，或按 `primitiveId` 查询单个区域，包括多轮廓区域。`create` 指定层、单轮廓 `polygonSource` 和至少一条区域规则；规则编号 2/5/6/7/8 分别禁止元件、导线、填充、覆铜和内电层，9 表示跟随区域约束规则。`modify` 也仅接受单轮廓 `polygonSource`。多点轮廓须在末尾重复首点，例如 `[0,0,"L",100,0,100,100,0,100,0,0]`；EDA 3.2.181 实测未闭合的多点区域创建会报参数错误。`R`、`CIRCLE` 使用各自的官方参数。`delete` 删除单个区域。写入结果不明时用 `bridge_recover_client action=readback`，指定 `readbackPath:"/bridge/jlceda/pcb/region-manage"`、`readbackPayload:{"action":"read"}`，核对同一 PCB 的全部区域；诊断要求宿主重启时先重启原宿主。

区域创建完整回读确认无新增图元时返回 `applied:false`；只新增一个但属性不符时返回 `applied:true`、`after`、`requestedMismatches` 和 `verified:false`。修改若部分属性未生效，也返回实际状态与未应用字段；完整回读已确定结果时不会开启未知提交隔离。删除通过完整区域列表核对目标 ID。

`pcb_text_manage` 的无过滤 `read` 完整返回当前 PCB 的独立文本 String 和器件属性 Attribute；`kind` 可只读取一类，`primitiveId` 可精确读取，`parentPrimitiveId` 可读取指定器件的属性。`create`、`delete` 仅用于独立文本；创建至少提供层、坐标和内容，其余样式采用官方示例默认值。`modify` 可更改独立文本内容与样式，或传入属性 ID 和父器件 ID 修改已有器件属性的值、可见性与样式。官方 `pcb_PrimitiveAttribute.create()` 无效，因此本工具不提供单独创建属性。写入结果不明时使用 `bridge_recover_client action=readback`，指定 `readbackPath:"/bridge/jlceda/pcb/text-manage"`、`readbackPayload:{"action":"read"}`，完整核对同一 PCB 的文本与属性；诊断要求时先重启原宿主。

`pcb_layer_manage` 的 `read` 返回当前 PCB 铜层数量及完整图层清单；`set` 需传 `confirm:true` 和 2–32 的偶数 `copperLayerCount`，写后核对同一 PCB 的层数与启用的 SIGNAL/PLANE 层数量。大型 PCB 可用 `timeoutMs` 将完整回读及降层预检的默认 30 秒预算调整至 5–120 秒。降层前如将移除的内层已有图元，Bridge 返回 `removed_layer_not_empty` 和阻挡图元，不执行设置。若结果不明，使用 `bridge_recover_client action=readback`，指定 `readbackPath:"/bridge/jlceda/pcb/layer-manage"`、`readbackPayload:{"action":"read"}`；诊断要求时先重启原宿主。

`component_place` 的放置检查可能清理与已有图元完全重叠的重复副本；该检查按写操作执行，超时或失联后需按写入恢复流程处理。

`component_place` 启动或检查、`component_place_auto`，以及 `api_invoke eda.sch_PrimitiveComponent.create` 若返回 `commitUnknown:true`，恢复回读必须调用 `eda.sch_PrimitiveComponent.getAllPrimitiveId`，传 `args:[null,false]`；Server 会追加 `includeCompleteSchematicComponentIds:true`，核对当前图页及不截断的 `schematicComponentIds`、`schematicComponentStates`（ID、位号及 BOM 属性）和数量，不能只用 `/context` 或网表解除隔离。诊断有 `hostRestartRequired:true` 时，须先重启原 EDA 宿主。

`component_place_auto` 与 `netlabel_place` 整批默认有 300 秒执行预算，可用 `timeoutMs` 在 25–600 秒内调整；大量器件或标签建议按实际 EDA 速度设置。`netlabel_place` 创建结果未定时停止剩余标签，恢复时使用 `schematic_read` 的 `includeConnectivityPrimitives:true` 完整读回普通 NET 属性及 NetFlag 图元，诊断要求重启时先重启原宿主。

可写 `api_invoke` 的原生 RPC 超时或断线会阻止后续写入；诊断要求宿主重启时，使用新 Bridge 核对目标文档和受影响图元，再恢复写入。只读 `api_invoke` 的失败不进入写入恢复。

Server 提供 `schematic_document_action`，用于受限地检查原理图坐标、选中对象、区域图元、过滤器和鼠标位置，并执行视图导航、图元选择、属性读取、保存和变更导入。

`schematic_document_action` 和 `pcb_document_action` 的纯查询及画布导航可在写入隔离期间使用；改变选择状态、飞线计算、保存和导入仍受写入隔离约束。

`schematic_pages_manage` 只有在 `confirm: true` 时才会创建、复制、重命名或完整重排页面。重排必须提供每个页面 UUID，Bridge 会重新读取页面对象并验证最终顺序；不提供删除功能。页面操作可指向非当前图页；提交状态未知时，用无参数 `eda.dmt_Schematic.getAllSchematicPagesInfo` 读回完整目录，并核对目标页面或原理图归属，当前图页的 `/context` 回读不会解除隔离。

`pcb_documents_manage` 以 `project_info` 或 `bridge_clients` 返回的当前工程 `projectUuid` 为目标：`operation:list` 完整返回该工程 PCB 的 UUID、名称和所属板子；`create` 可省略 `boardName` 新建游离 PCB，`copy` 按已有 `pcbUuid` 复制，`rename` 改名。三种写入均需 `confirm:true`，并在 EDA 工作区同步后按 PCB UUID 和工程目录回读；改名仅对 EDA 中已打开的目标 PCB 生效，工具不会自行切换图页。未知提交使用 `bridge_recover_client`，指定 `readbackPath:"/bridge/jlceda/pcb/documents-manage"`、`readbackPayload:{"operation":"list","projectUuid":"原工程 UUID"}`；旧宿主尚有未完成原生调用时先重启。暂不提供 PCB 删除。

`board_setup` 接受当前工程 `projectUuid` 和 `confirm:true`；省略 `schematicUuid` 时由 EDA 同时创建 Board、原理图和 PCB，传入同工程游离原理图 UUID 时先创建 PCB 再建立关联。返回 Board 名称与两个文档 UUID，不自动打开文档或导入原理图变更。结果不明时，`bridge_recover_client` 使用 `readbackPath:"/bridge/jlceda/project/info"`、`readbackPayload:{"includePages":false,"includeBoards":true,"includeSchematics":true,"includePcbs":true,"limit":500}` 回读完整目录；先核对是否已创建，勿重试或自动清理游离 PCB。

`editor_navigate` 接受当前工程的 `projectUuid` 与原理图图页或 PCB 的 `documentUuid`。`operation:open` 打开或激活该文档；`operation:activate` 还需已打开的 `tabId`，可由 `eda.dmt_EditorControl.getSplitScreenTree` 获取。工具先核对目标属于当前工程，再调用编辑器 API，在 `timeoutMs` 预算内核对工程、文档、图页和标签 ID。返回 `commitUnknown:true` 时先查看 `bridge_clients` 的诊断，使用 `bridge_recover_client` 恢复，并以目标 `documentUuid`、原工程 `projectUuid` 和 `readbackPath:"/bridge/jlceda/context"` 验证当前页；诊断要求时先重启原 EDA 宿主。不要在结果不明时盲目重试导航。

`eda_context` 在客户端支持时返回客户端版本、连接模式、编辑器版本、编译日期和当前画布数据单位。`eda_canvas_snapshot` 可在不改变文档或视图的情况下返回受限的画布图像。

`workspace_query` 查询当前工作区、团队以及受限的工程和文件夹列表。`design_source_export` 和 `design_archive_export` 分别读取受限的源文件预览和原生设计归档元数据；完整文本或 Base64 数据都需要明确授权并受大小限制。

`library_preview` 可生成符号/封装预览图，`library_classification_query` 可浏览官方库分类树。`project_info` 在 PCB 页仍可列出当前工程全部原理图图页，也可选返回受限的 Board 和 Panel 清单。

Server 提供 PCB DRC、网络查询、库搜索、制造查询和受保护的文档操作。设备 `library_search` 支持 0.4.15 精确属性、官方单个/批量 LCSC C 编号映射和精确 UUID 获取；符号、封装、3D 模型、可复用模块和 Panel 库使用各自支持的 API。仿真模型搜索支持 Ngspice/SimulIDE 过滤，但官方模型读取 API 需要私有部署，因此不公开。制造导出包含官方飞针测试文件，PCB 专用自动布局/自动布线 MCP 工具仍未启用；EDA BETA API 可经 `api_invoke` 调用，结果需用器件位置、导线、过孔和 DRC 读回确认。

`pcb_constraints_manage` 是受确认保护的写入工具，用于网类、差分对、等长组和 Pad 对组的窄范围修改，并返回受影响项目的读取验证；不支持批量替换规则配置。

公开的 `timeoutMs` 参数会传递到 WebSocket 请求。EDA 修改超时后，Bridge 会隔离未完成的任务，避免后续请求并发修改；请求排队时间不计入 API 执行超时。

本软件包是 **MCP Bridge 社区版**配套的原生 Model Context Protocol Server，通过 STDIO 与 Codex、Claude、Cursor 等 MCP 客户端通信，再通过仅监听本机的 WebSocket 与嘉立创 EDA 专业版扩展通信。

> 社区维护项目，基于 `sengbin/JLCEDA-MCP` 改进；不是嘉立创官方插件。

## 要求

- Node.js 20 或更高版本
- 嘉立创 EDA 专业版 3.x
- 已安装匹配发布版本中的 MCP Bridge 社区版 `.eext`

## 安装

以下文件名对应 2.3.8；是否可下载以发布页实际提供的包为准。

从 GitHub 发布页下载 `jlceda-mcp-server-2.3.8.tgz`：

```powershell
npm install --global .\jlceda-mcp-server-2.3.8.tgz
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
- `netlabel_place` 的普通信号标签依赖 EDA v4 才提供的 `createNetLabel`；配套的本版扩展仅支持 EDA 3.x，因此普通标签会立即返回未开始。EDA v4 需等待未来兼容版本；电源和地网络标识仍可使用。
- API 透传工具是可选功能，仅应在受信任的 MCP 客户端中启用。

完整安装、多客户端选择和故障排查说明见[原生 MCP 安装说明](https://github.com/hs150521/JLCEDA-MCP-Community/blob/main/docs/native-mcp-setup.md)。

当 `bridge_clients` 显示活动页面任务卡死且另一个页面已就绪时，可使用 `bridge_select_client` 并设置 `force: true` 进行恢复。该选项会取消 Server 对旧页面任务的等待并切换租约，但不能取消已经在 EDA 内运行的 API 调用。

## 支持与许可证

- Issue：<https://github.com/hs150521/JLCEDA-MCP-Community/issues>
- 安全报告与联系邮箱：`hs150521@proton.me`
- 隐私政策：[PRIVACY.md](PRIVACY.md)
- 许可证：Apache-2.0
