# 2.3.5 Issue 验证记录

记录日期：2026-10-05。范围为社区仓库 [hs150521/JLCEDA-MCP-Community](https://github.com/hs150521/JLCEDA-MCP-Community) 本轮读取到的全部 23 个 Open Issue。

当前目标版本为 Bridge / MCP Server 2.3.5，处于发布验证阶段。下表分别注明本地回归、2.3.4 原生实测、2.3.5 工具实测与仍待验证场景；本地通过不代表 Issue 的原场景已在新扩展中确认解决。本文不包含测试工程的 UUID、目录或设计数据。

## 验证概况

- 本轮实现覆盖器件引用解析、真实 ComponentPin 实例修改、绑定属性查询、覆铜重建回退、工具输入契约、名称搜索过滤、制造格式校验、PCB 等价回读和错误传输。最新 PCB 修复补充过孔 0.2 mil 最近格点、工程库来源回读和覆铜轮廓等价比较，正在最终复测。
- 两轮本地全面审查、Bridge/Server 全量构建测试及 lint 通过；Bridge 构建包含全部新增回归脚本、TypeScript、API 文档、runtime 校验和打包。2.3.5 已导入扩展并重启，Server 与 Bridge 均确认版本 2.3.5。
- #68 的无效 33 字符 UUID 与正确 32 字符系统库记录已区分；2.3.4 实机一次性图页中，通过 `lib_Device.get()` 的完整 DeviceItem 与唯一 `subPartName`，连续创建 0603 C23221 及 0805 C96346/C84376/C110775。四次原生创建各约 1–2 秒，当前页 `schematic_read` 完整回读确认 4 件，未触发写入隔离。随后在 2.3.5 实机中，无效引用立即返回 `DEVICE_NOT_FOUND`，正确设备的 4 型号自动放置批次全部成功，合计约 8.9 秒。
- 2.3.5 实机同一 ComponentPin 的 NC `true`→`false` 均已验证，坐标与同器件其他引脚不变；精确名称搜索仅返回 1 条匹配记录并排除 20 条无关记录；原理图 BOM CSV、JLCEDA 网表、PDF 文档均生成成功。
- NetPort Name 的最终实机类型查询、单件读取和批量读取均返回 Attribute，单件与批量的真实父 ID、Name 值和坐标一致。
- PCB 实机已验证 BOM CSV（334 B）、板框反向回读、显式闭合区域反向与四位小数坐标回读、2 个实际直线 ID 的共线覆盖、旋转 `-90`→`270`、Attribute 的 `value` / `valueVisible`、器件 `supplierId` / `otherProperty`，以及全板覆铜重建后的 1 个边框与 1 个填充。此前新 PCB 导航悬挂已重启恢复，后续验证在可用 PCB 页面继续。
- #79 的最新过孔创建/修改、PCB 工程库来源核对和覆铜创建几何修复待最终实测。DRC 从 0 错误 fixture 转到含 28 个真实错误的 PCB 后，发现旧分页把 2 个子类别当成 2 条详情，未返回 `nextOffset`，深层直线端点出现 `DetailLimitExceeded`；正在修正叶子详情分页，待新构建实测。#80 的封装子过孔保存后再生、#82 的独立封装编辑器上下文，以及旧 Issue 原场景继续保持开放。

## 全部 Open Issue 矩阵

| Issue | 问题与本轮处理 | 已有证据 | 当前结论 / 下一步 |
| --- | --- | --- | --- |
| [#22](https://github.com/hs150521/JLCEDA-MCP-Community/issues/22) | 原理图导线创建可能引发原生邻近网络合并；现有接触预检、语义回读和未知提交恢复只能识别或限制影响。 | 本轮未重新完成报告中的原场景验证。 | 保持开放，按原场景复测原生合并及实际网表。 |
| [#26](https://github.com/hs150521/JLCEDA-MCP-Community/issues/26) | 旧网络标签调用超时后，多个页面心跳消失；已有版本预检与失联诊断。 | 本轮未证明旧宿主级失联原场景已消除。 | 保持开放；原生挂起仍可能需要重启 EDA。 |
| [#30](https://github.com/hs150521/JLCEDA-MCP-Community/issues/30) | 交互式一次点击出现重复器件；已有退出模式核对与重叠副本处理。 | 本轮未完成原交互点击场景复验。 | 保持开放，核对实机点击、结束放置与最终图元集合。 |
| [#34](https://github.com/hs150521/JLCEDA-MCP-Community/issues/34) | 放置新器件时原生自动重编号已有器件；已有位号恢复与实际变更报告。 | 本轮未完成报告中连续放置和重编号场景复验。 | 保持开放，继续验证原生位号行为。 |
| [#37](https://github.com/hs150521/JLCEDA-MCP-Community/issues/37) | 原生自动布线立即报告失败或未遵守网络范围；已有请求范围和实物变化诊断。 | 诊断不能证明原生路由成功或筛选生效。 | 保持开放；当前仍属 EDA BETA API 限制。 |
| [#68](https://github.com/hs150521/JLCEDA-MCP-Community/issues/68) | 特定 0603 自动创建超时。报告引用为错误 33 字符 UUID；改为设备库查验，使用实际完整 DeviceItem 创建，查无设备则不启动创建。 | 本地回归通过；2.3.5 无效引用立即返回 `DEVICE_NOT_FOUND`，随后正确系统库 C23221/C96346/C84376/C110775 的 4 型号自动放置批次全部成功，合计约 8.9 秒。 | 新版无效引用预检与正确记录批量放置实测通过，可按该修复范围评估关闭。 |
| [#69](https://github.com/hs150521/JLCEDA-MCP-Community/issues/69) | 通用 Pin 修改接口用于 ComponentPin 时 NC 不保持且 Y 翻转；改走真实实例，仅支持 NC 与引脚号。失败恢复要求完整连接回读及所属器件全部引脚真实状态。 | 本地实例与完整连接恢复回归通过；2.3.5 实机同一 ComponentPin 的 NC `true`→`false` 两次均 `verified:true`，目标坐标和同器件其他引脚不变。 | NC 原场景新版实测通过；失败恢复路径已本地验证，未在该成功操作中触发。 |
| [#70](https://github.com/hs150521/JLCEDA-MCP-Community/issues/70) | 覆铜批量重建方法缺失被误报为未打开 PCB；增加逐实例重建回退及明确能力缺失结果。 | 本地回归覆盖批量、实例回退和两者均缺失；2.3.5 实机 `rebuild all:true` 返回 `verified:true`，完整回读 1 个边框与 1 个填充。 | 新版重建与填充回读实测通过；各能力分支另保留本地回归证据。 |
| [#71](https://github.com/hs150521/JLCEDA-MCP-Community/issues/71) | PCB Attribute 的 `value` / `valueVisible` 被 Server schema 拒绝；补全契约与分发。 | 本地契约、分发和处理器回归通过；2.3.5 实机两字段修改成功，实际 Attribute 回读 `verified:true`。 | 新版原操作实测通过，可按该修复范围评估关闭。 |
| [#72](https://github.com/hs150521/JLCEDA-MCP-Community/issues/72) | 设备 `properties.name` 原生搜索返回无关器件；核对实际名称，必要时关键词回退后过滤。 | 本地名称过滤与回退回归通过；2.3.5 实机精确名称搜索只返回 1 条匹配记录，排除 20 条无关记录。 | 新版名称筛选实测通过，可按该修复范围评估关闭。 |
| [#73](https://github.com/hs150521/JLCEDA-MCP-Community/issues/73) | 板框轮廓仅因原生反向或起点变化被拒绝；闭合轮廓支持等价方向/起点，开放路径只接受完整反向。 | 本地回归覆盖闭合循环起点、开放路径完整反向及拒绝循环换起点、圆弧/曲线语义与真实差异；2.3.5 实机板框创建后的原生反向回读 `verified:true`。 | 新版反向轮廓原场景实测通过；其他比较边界保留本地证据。 |
| [#74](https://github.com/hs150521/JLCEDA-MCP-Community/issues/74) | 不同 0805 器件后续创建悬挂；与 #68 共用完整设备记录解析，保留子件重载。 | 2.3.4 完整记录连续创建已通过；2.3.5 `component_place_auto` 连续创建 C23221 / C96346 / C84376 / C110775 全部成功，4 型号批次约 8.9 秒。 | 新版连续不同型号自动放置实测通过，可按该修复范围评估关闭。 |
| [#75](https://github.com/hs150521/JLCEDA-MCP-Community/issues/75) | 制造导出提前构造其他 kind 的参数，导致无关格式或网表类型校验拒绝当前请求；改为仅计算选定 domain/kind 的分支。原理图 BOM CSV 是该共用根因的一个场景。 | 本地覆盖 PCB/原理图 BOM、文档、标准与仿真网表分支；2.3.5 实机原理图 CSV（740 B）、JLCEDA 网表（18,883 B）、PDF（35,886 B）及 PCB BOM CSV（334 B）均生成成功。 | 已测原理图格式与 PCB BOM 通过；仿真及其他导出保持本地回归证据，未声称全部实测。 |
| [#76](https://github.com/hs150521/JLCEDA-MCP-Community/issues/76) | DRC 详情深度丢失却误报未截断；增加有界详情 DTO、分页和截断诊断，真实分类树需按叶子详情分页。 | 首轮本地分页和传输回归通过，0 错误 fixture 不足验证非空详情；随后实机读到 28 个真实错误，旧版仅将 2 个子类别计为详情，`totalAvailableDetails:2` 且无 `nextOffset`，深层直线端点出现 `DetailLimitExceeded`。 | 保持开放；按真实原生分类树修正叶子详情分页，需重新构建后验证数量、端点字段、截断诊断和连续续页。 |
| [#77](https://github.com/hs150521/JLCEDA-MCP-Community/issues/77) | PCB 元数据部分修改失败缺少实际状态；增加 `after`、失败分类和字段差异，保留原有属性。 | 处理器与传输回归通过，确认真实不匹配继续阻止后续写入；2.3.5 实机 `supplierId` 与 `otherProperty` 修改及实际回读 `verified:true`。 | 新版正常字段修改实测通过；部分失败诊断与隔离路径保留本地证据，未由该成功操作触发。 |
| [#78](https://github.com/hs150521/JLCEDA-MCP-Community/issues/78) | `-90` 与 `270` 等价角度被拒绝；按模 360 度比较并给归一化诊断。 | 本地回归与连续写入传输测试通过，真实角度差异仍失败；2.3.5 实机请求 `-90`、实际 `270`，返回 `verified:true` 和 `modulo_360`。 | 新版等价角度实测通过，可按该修复范围评估关闭。 |
| [#79](https://github.com/hs150521/JLCEDA-MCP-Community/issues/79) | 过孔尺寸量化、直线拆分/合并导致误报；直线按共线覆盖核验，过孔创建与尺寸修改按 EDA 3.2.181 实测的 0.2 mil 最近格点核验。 | 本地处理器与传输回归通过；实机直线共线覆盖返回 2 个实际 ID 且 `verified:true`。原生尺寸采样确认 `15.7`→`15.8`、`19.73`→`19.8`；最新 `round_0_2_mil` 创建/修改路径待重新安装后复测。 | 保持开放至最终过孔实测；该规则只接受唯一的精确值或最近格点结果，不扩成任意误差区间。 |
| [#80](https://github.com/hs150521/JLCEDA-MCP-Community/issues/80) | 封装子过孔删除后保存/重开再生；已知父 ID 拒绝删除，其他成功只声明当前页内存范围。 | 本地归属预检与删除范围回归通过；实机 raw VIA 未提供父字段，不能据此认定独立过孔或持久删除。 | 保持开放，持久删除需要原封装子过孔场景及保存/重开证据。 |
| [#81](https://github.com/hs150521/JLCEDA-MCP-Community/issues/81) | 对象错误变成 `[object Object]` 或丢失原因；Bridge、主连接、中继与分发保留安全诊断字段。 | 本地 WebSocket / 中继 / 分发回归通过，覆盖 `reason`、`field`、`status` 和私有源字段不透传，已交叉审查。 | 待匹配新版本在实机触发可读原生错误确认。 |
| [#82](https://github.com/hs150521/JLCEDA-MCP-Community/issues/82) | 独立封装编辑器未连接或缺少上下文，不能作为普通 PCB 页控制。 | 本轮未实现独立 footprint 文档类型、会话与专用原生 API 路由。 | 保持开放，列入下一轮上下文及架构扩展。 |
| [#83](https://github.com/hs150521/JLCEDA-MCP-Community/issues/83) | NetPort 的 Name 绑定 Attribute 被读为 Text；以父图元属性与按 ID 查询纠正类型并保留父 ID。 | 最终 2.3.5 实机类型查询、单件读取及批量读取均返回 Attribute；单件与批量结果的真实父 ID、`key:"Name"`、值和坐标一致。 | 新版三条查询路径实测通过，可按该修复范围评估关闭。 |
| [#84](https://github.com/hs150521/JLCEDA-MCP-Community/issues/84) | 点导线修改成 L 形时原生生成三角环；调用前拒绝多线段转换，写后不匹配保留实际 `after`。 | 本地回归覆盖无原生调用的拒绝、正常线段修改及实际失败状态，已交叉审查。 | 待新扩展确认预拒绝和建议的新建/删除工作流。 |
| [#85](https://github.com/hs150521/JLCEDA-MCP-Community/issues/85) | 区域等价方向、循环起点及坐标四位小数回读被拒绝；与板框复用几何比较，多点写入要求显式闭合。 | 本地回归覆盖四位小数坐标、等价方向/起点及真实形变；2.3.5 实机显式闭合区域创建，原生反向与四位小数回读 `verified:true`。 | 新版已测创建场景通过；修改、循环起点及真实形变边界保留本地回归证据。 |

## 结果解释

### 原生几何归一化

PCB 器件旋转按模 360 度比较。板框闭合轮廓允许等价反向和起点循环移动；板框开放折线只接受完整路径反向，不接受循环换起点。区域仍按隐式闭合语义比较。坐标仅针对已观察的四位小数回读使用每坐标 `0.00005 mil` 容差，圆弧角度仍按原有 `1e-6` 度容差。它们会返回实际几何，无法等价的轮廓仍报告差异。

过孔创建与尺寸修改只接受精确尺寸或 EDA 3.2.181 实测的 0.2 mil 最近格点：`Math.round(requested * 5) / 5`。原生采样包含 `15.748`→`15.8`、`19.685`→`19.6`、`15.7`→`15.8` 与 `19.73`→`19.8`；`normalization` 返回请求值、实际尺寸与 `round_0_2_mil`。官方 API 未声明该公式，本轮仅核对实测的唯一结果，真实差异仍失败；最新工具创建和修改路径待最终实机复测。

PCB 器件创建若将设备或封装复制进工程库，实际引用可与输入库引用不同；仅在原生创建返回的来源引用与同 ID 实际回读一致时确认，并返回 `normalization.source`。覆铜创建与修改复用闭合轮廓等价比较，保留实际绕序、起点和坐标诊断，优先级等真实差异仍失败。两项新修复已有本地回归与两轮审查，待最终实机确认。

直线创建在原生 ID 的单件回读不能直接确认时，检查同网络、同层、同线宽的共线图元覆盖请求线段，返回实际图元集合。成功代表请求线段得到覆盖，原生图元边界可能不同。

### 已结束的部分写入与未知提交

ComponentPin 修改失败的恢复类型为 `schematic_connectivity_primitives`。使用 `bridge_recover_client action=readback`，设置 `readbackPath:"/bridge/jlceda/schematic/read"`、`readbackPayload:{"includeConnectivityPrimitives":true}`；语义快照包含 `pinId`、`x`、`y`、`rotation`、`noConnected`，须核对目标所属器件全部引脚的真实状态。只查询 `/context` 不能解除隔离；诊断要求宿主重启时先重启原 EDA 宿主。

PCB 器件部分修改会返回实际 `after`、`failureKind:"state_mismatch"` 和 `mismatches`，并以 `nativeCallSettled:true` 表明原生调用已结束。该结果仍保留 `commitUnknown` / `readbackRequired`，须按诊断完成同板器件回读；不应将其当成未执行而重复写入。

过孔删除的 `verified:true` 只在 `verificationScope:"current_page_memory"` 内成立；`durableDeletionVerified:false` 明确没有确认保存后的持久结果。已知父器件 ID 时拒绝直接删除，缺少父字段时归属未知。验证持久结果需要保存并重新打开 PCB，不能用当前页查询代替。

### DRC 详情分页

例如首次调用 `pcb_drc_check` 使用：

```json
{"offset": 0, "limit": 120}
```

后续使用返回的 `nextOffset`，直到该字段不再返回。`totalAvailableDetails` 是原生实际返回的详情数；`errorCount` 可以高于它。`nativeTruncated:true` 说明原生计数超过其详情列表，`serializationTruncated:true` 说明 Bridge 深度或大小限制影响本次输出。当前页问题集合变化时应重新开始读取；分页不能恢复原生没有提供的详情。

### 结构化错误

错误传输保留有界的 `message`、`name`、`code`、`reason`、`field`、`status`，包括工具分发后的文本原因与可用字段。原始错误对象的其他键和源文本不透传，以免诊断携带设计数据。

## 本地回归入口

以下命令包含本轮新回归；两轮本地全面审查、全量构建测试及 lint 已通过。2.3.5 已测原理图和 PCB 场景见上表；最新 PCB 修复由发布流程继续完成实机复测，DRC 非空详情与旧原场景仍待后续验证。

```powershell
cd mcp-server
npm test

cd ..\mcp-bridge
npm run test:schematic-components
npm run test:schematic-read
npm run test:schematic-wires
npm run test:pcb-connectivity
npm run test:pcb-components
npm run test:pcb-pours
npm run test:pcb-routing
npm run test:pcb-outline
npm run test:pcb-region
npm run test:pcb-read
npm run test:2.1
npm run typecheck
```

2.3.4 的 `board_setup` 继续提供 Board、原理图与 PCB 的创建或关联工作流；本轮未将它改为自动打开 PCB 或自动导入原理图变更。历史发布说明见 [v2.3.4](releases/v2.3.4.md)。
