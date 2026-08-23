/**
 * ------------------------------------------------------------------------
 * 名称：API 索引任务处理器
 * 说明：提供原理图操作常用 API 的固定索引表（fullName + 描述），
 *       供 AI 快速定位目标 API 路径，再通过 api_search 获取完整签名。
 * 作者：Lion
 * 邮箱：chengbin@3578.cn
 * 日期：2026-03-25
 * 备注：索引为精选静态列表，不依赖 EDA 运行时，节省 token 消耗。
 * ------------------------------------------------------------------------
 */

import { preserveBoundedArray } from '../utils.ts';

interface ApiIndexEntry {
	fullName: string;
	summary: string;
}

// 精选原理图常用可调用 API 索引表。
const SCHEMATIC_API_INDEX: ApiIndexEntry[] = [
	// ── dmt_Schematic：原理图文档管理 ──────────────────────────────────────
	{ fullName: 'eda.dmt_Schematic.createSchematic', summary: '创建原理图' },
	{ fullName: 'eda.dmt_Schematic.createSchematicPage', summary: '创建原理图图页' },
	{ fullName: 'eda.dmt_Schematic.copySchematicPage', summary: '复制原理图图页' },
	{ fullName: 'eda.dmt_Schematic.modifySchematicName', summary: '修改原理图名称' },
	{ fullName: 'eda.dmt_Schematic.modifySchematicPageName', summary: '修改原理图图页名称' },
	{ fullName: 'eda.dmt_Schematic.reorderSchematicPages', summary: '重排原理图图页顺序' },
	{ fullName: 'eda.dmt_Schematic.getCurrentSchematicInfo', summary: '获取当前原理图的详细属性' },
	{ fullName: 'eda.dmt_Schematic.getCurrentSchematicPageInfo', summary: '获取当前原理图图页的详细属性' },
	{ fullName: 'eda.dmt_Schematic.getAllSchematicsInfo', summary: '获取工程内所有原理图的详细属性' },
	{ fullName: 'eda.dmt_Schematic.getAllSchematicPagesInfo', summary: '获取工程内所有原理图图页的详细属性' },
	{ fullName: 'eda.dmt_Schematic.deleteSchematicPage', summary: '删除原理图图页' },
	{ fullName: 'eda.dmt_Schematic.deleteSchematic', summary: '删除原理图' },
	{ fullName: 'eda.dmt_EditorControl.getCurrentRenderedAreaImage', summary: '获取当前画布渲染图像' },
	{ fullName: 'eda.dmt_Workspace.getCurrentWorkspaceInfo', summary: '获取当前工作区' },
	{ fullName: 'eda.dmt_Workspace.getAllWorkspacesInfo', summary: '获取所有工作区' },
	{ fullName: 'eda.dmt_Team.getCurrentTeamInfo', summary: '获取当前团队' },
	{ fullName: 'eda.dmt_Team.getAllTeamsInfo', summary: '获取直接团队' },
	{ fullName: 'eda.dmt_Team.getAllInvolvedTeamInfo', summary: '获取参与的团队' },
	{ fullName: 'eda.dmt_Project.getAllProjectsUuid', summary: '获取工程 UUID 列表' },
	{ fullName: 'eda.dmt_Project.getProjectInfo', summary: '获取工程属性' },
	{ fullName: 'eda.dmt_Board.getAllBoardsInfo', summary: '获取工程板卡清单' },
	{ fullName: 'eda.dmt_Schematic.getAllSchematicsInfo', summary: '获取工程原理图清单' },
	{ fullName: 'eda.dmt_Pcb.getAllPcbsInfo', summary: '获取工程 PCB 清单' },
	{ fullName: 'eda.dmt_Panel.getAllPanelsInfo', summary: '获取工程拼板清单' },
	{ fullName: 'eda.dmt_Folder.getAllFoldersUuid', summary: '获取文件夹 UUID 列表' },
	{ fullName: 'eda.dmt_Folder.getFolderInfo', summary: '获取文件夹属性' },
	{ fullName: 'eda.sys_FileManager.getDocumentSource', summary: '获取当前文档源代码' },
	{ fullName: 'eda.sys_FileManager.getDocumentFootprintSources', summary: '获取当前文档封装源代码' },
	{ fullName: 'eda.sys_FileManager.getProjectFile', summary: '导出当前工程原生归档' },
	{ fullName: 'eda.sys_FileManager.getDocumentFile', summary: '导出当前文档原生归档' },
	{ fullName: 'eda.sys_FileManager.getProjectFileByProjectUuid', summary: '按 UUID 导出工程原生归档' },
	{ fullName: 'eda.sys_Unit.getFrontendDataUnit', summary: '获取当前画布数据单位' },

	// ── sch_Document：画布文档操作 ─────────────────────────────────────────
	{ fullName: 'eda.sch_Document.save', summary: '保存文档' },
	{ fullName: 'eda.sch_Document.navigateToCoordinates', summary: '定位到画布坐标' },
	{ fullName: 'eda.sch_Document.navigateToRegion', summary: '定位到画布区域' },
	{ fullName: 'eda.sch_Document.getPrimitiveAtPoint', summary: '获取坐标点的图元' },
	{ fullName: 'eda.sch_Document.getPrimitivesInRegion', summary: '获取区域内所有图元' },
	{ fullName: 'eda.sch_Document.autoLayout', summary: '自动布局' },
	{ fullName: 'eda.sch_Document.autoRouting', summary: '自动布线' },

	// ── sch_Primitive：通用图元操作 ────────────────────────────────────────
	{ fullName: 'eda.sch_Primitive.getPrimitiveTypeByPrimitiveId', summary: '获取指定 ID 的图元类型' },
	{ fullName: 'eda.sch_Primitive.getPrimitiveByPrimitiveId', summary: '获取指定 ID 的图元的所有属性' },
	{ fullName: 'eda.sch_Primitive.getPrimitivesByPrimitiveId', summary: '批量获取多个图元 ID 的所有属性' },
	{ fullName: 'eda.sch_Primitive.getPrimitivesBBox', summary: '获取图元的 BBox（边界框）' },

	// ── sch_SelectControl：选中控制 ────────────────────────────────────────
	{ fullName: 'eda.sch_SelectControl.getAllSelectedPrimitives', summary: '查询所有已选中图元的图元对象' },
	{ fullName: 'eda.sch_SelectControl.getSelectedPrimitives', summary: '查询选中图元的所有参数' },
	{ fullName: 'eda.sch_SelectControl.doSelectPrimitives', summary: '使用图元 ID 选中图元' },
	{ fullName: 'eda.sch_SelectControl.clearSelected', summary: '清除选中' },
	{ fullName: 'eda.sch_SelectControl.getCurrentMousePosition', summary: '获取当前鼠标在画布上的位置' },

	// ── sch_PrimitiveComponent：器件 ───────────────────────────────────────
	{ fullName: 'eda.sch_PrimitiveComponent.create', summary: '创建器件' },
	{ fullName: 'eda.sch_PrimitiveComponent.createNetFlag', summary: '创建网络标识（电源/地等）' },
	{ fullName: 'eda.sch_PrimitiveComponent.createNetPort', summary: '创建网络端口' },
	{ fullName: 'eda.sch_PrimitiveComponent.placeComponentWithMouse', summary: '使用鼠标放置器件（交互式放置）' },
	{ fullName: 'eda.sch_PrimitiveComponent.delete', summary: '删除器件' },
	{ fullName: 'eda.sch_PrimitiveComponent.modify', summary: '修改器件属性' },
	{ fullName: 'eda.sch_PrimitiveComponent.get', summary: '获取器件的所有属性' },
	{ fullName: 'eda.sch_PrimitiveComponent.getAll', summary: '获取当前页所有器件' },
	{ fullName: 'eda.sch_PrimitiveComponent.getAllPrimitiveId', summary: '获取所有器件的图元 ID' },
	{ fullName: 'eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId', summary: '获取器件关联的所有引脚（含网络名）' },
	{ fullName: 'eda.sch_PrimitiveComponent.getAllPropertyNames', summary: '获取所有器件的属性名称集合' },

	// ── sch_PrimitiveWire：导线 ────────────────────────────────────────────
	{ fullName: 'eda.sch_PrimitiveWire.create', summary: '创建导线' },
	{ fullName: 'eda.sch_PrimitiveWire.delete', summary: '删除导线' },
	{ fullName: 'eda.sch_PrimitiveWire.modify', summary: '修改导线' },
	{ fullName: 'eda.sch_PrimitiveWire.get', summary: '获取导线属性' },
	{ fullName: 'eda.sch_PrimitiveWire.getAll', summary: '获取所有导线' },
	{ fullName: 'eda.sch_PrimitiveWire.getAllPrimitiveId', summary: '获取所有导线的图元 ID' },

	// ── sch_PrimitiveAttribute：属性/网络标签 ─────────────────────────────
	{ fullName: 'eda.sch_PrimitiveAttribute.create', summary: '创建属性' },
	{ fullName: 'eda.sch_PrimitiveAttribute.createNetLabel', summary: '创建网络标签' },
	{ fullName: 'eda.sch_PrimitiveAttribute.delete', summary: '删除属性' },
	{ fullName: 'eda.sch_PrimitiveAttribute.modify', summary: '修改属性' },
	{ fullName: 'eda.sch_PrimitiveAttribute.get', summary: '获取属性' },
	{ fullName: 'eda.sch_PrimitiveAttribute.getAll', summary: '获取所有属性' },

	// ── sch_PrimitiveText：文本 ────────────────────────────────────────────
	{ fullName: 'eda.sch_PrimitiveText.create', summary: '创建文本' },
	{ fullName: 'eda.sch_PrimitiveText.delete', summary: '删除文本' },
	{ fullName: 'eda.sch_PrimitiveText.modify', summary: '修改文本' },
	{ fullName: 'eda.sch_PrimitiveText.get', summary: '获取文本属性' },
	{ fullName: 'eda.sch_PrimitiveText.getAll', summary: '获取所有文本' },

	// ── sch_PrimitiveBus：总线 ─────────────────────────────────────────────
	{ fullName: 'eda.sch_PrimitiveBus.create', summary: '创建总线' },
	{ fullName: 'eda.sch_PrimitiveBus.delete', summary: '删除总线' },
	{ fullName: 'eda.sch_PrimitiveBus.modify', summary: '修改总线' },
	{ fullName: 'eda.sch_PrimitiveBus.get', summary: '获取总线属性' },
	{ fullName: 'eda.sch_PrimitiveBus.getAll', summary: '获取所有总线' },

	// ── sch_PrimitivePin：引脚 ─────────────────────────────────────────────
	{ fullName: 'eda.sch_PrimitivePin.create', summary: '创建引脚' },
	{ fullName: 'eda.sch_PrimitivePin.delete', summary: '删除引脚' },
	{ fullName: 'eda.sch_PrimitivePin.modify', summary: '修改引脚' },
	{ fullName: 'eda.sch_PrimitivePin.get', summary: '获取引脚属性' },
	{ fullName: 'eda.sch_PrimitivePin.getAll', summary: '获取所有引脚' },

	// ── sch_PrimitiveRectangle / Circle / Arc / Polygon：绘图图元 ─────────
	{ fullName: 'eda.sch_PrimitiveRectangle.create', summary: '创建矩形' },
	{ fullName: 'eda.sch_PrimitiveRectangle.delete', summary: '删除矩形' },
	{ fullName: 'eda.sch_PrimitiveRectangle.modify', summary: '修改矩形' },
	{ fullName: 'eda.sch_PrimitiveRectangle.getAll', summary: '获取所有矩形' },
	{ fullName: 'eda.sch_PrimitiveCircle.create', summary: '创建圆' },
	{ fullName: 'eda.sch_PrimitiveCircle.delete', summary: '删除圆' },
	{ fullName: 'eda.sch_PrimitiveCircle.modify', summary: '修改圆' },
	{ fullName: 'eda.sch_PrimitiveCircle.getAll', summary: '获取所有圆' },
	{ fullName: 'eda.sch_PrimitiveArc.create', summary: '创建圆弧' },
	{ fullName: 'eda.sch_PrimitiveArc.delete', summary: '删除圆弧' },
	{ fullName: 'eda.sch_PrimitiveArc.modify', summary: '修改圆弧' },
	{ fullName: 'eda.sch_PrimitiveArc.getAll', summary: '获取所有圆弧' },
	{ fullName: 'eda.sch_PrimitivePolygon.create', summary: '创建多边形' },
	{ fullName: 'eda.sch_PrimitivePolygon.delete', summary: '删除多边形' },
	{ fullName: 'eda.sch_PrimitivePolygon.modify', summary: '修改多边形' },
	{ fullName: 'eda.sch_PrimitivePolygon.getAll', summary: '获取所有多边形' },

	// ── sch_Drc：规则检查 ──────────────────────────────────────────────────
	{ fullName: 'eda.sch_Drc.check', summary: '执行 DRC 电气规则检查' },

	// ── sch_ManufactureData：生产数据 ──────────────────────────────────────
	{ fullName: 'eda.sch_ManufactureData.getBomFile', summary: '获取 BOM 文件' },
	{ fullName: 'eda.sch_ManufactureData.getNetlistFile', summary: '获取网表文件（Netlist）' },
	{ fullName: 'eda.sch_ManufactureData.getExportDocumentFile', summary: '获取导出文档文件' },

	// ── lib_Device：器件库搜索 ─────────────────────────────────────────────
	{ fullName: 'eda.lib_Device.search', summary: '搜索器件（按关键词）' },
	{ fullName: 'eda.lib_Device.get', summary: '获取器件的所有属性' },
	{ fullName: 'eda.lib_Device.getByLcscIds', summary: '使用立创 C 编号获取器件' },
	{ fullName: 'eda.lib_Device.searchByProperties', summary: '使用属性精确搜索器件' },

	// ── lib_LibrariesList：库 UUID 查询 ───────────────────────────────────
	{ fullName: 'eda.lib_LibrariesList.getSystemLibraryUuid', summary: '获取系统库的 UUID' },
	{ fullName: 'eda.lib_LibrariesList.getPersonalLibraryUuid', summary: '获取个人库的 UUID' },
	{ fullName: 'eda.lib_LibrariesList.getProjectLibraryUuid', summary: '获取工程库的 UUID' },
	{ fullName: 'eda.lib_LibrariesList.getAllLibrariesList', summary: '获取所有库的列表' },
	{ fullName: 'eda.lib_Classification.getAllClassificationTree', summary: '获取库分类树' },
	{ fullName: 'eda.lib_3DModel.search', summary: '搜索 3D 模型库资产' },
	{ fullName: 'eda.lib_3DModel.get', summary: '按 UUID 获取 3D 模型库资产' },
	{ fullName: 'eda.lib_Cbb.search', summary: '搜索复用模块库资产' },
	{ fullName: 'eda.lib_Cbb.get', summary: '按 UUID 获取复用模块库资产' },
	{ fullName: 'eda.lib_PanelLibrary.search', summary: '搜索面板库资产' },
	{ fullName: 'eda.lib_PanelLibrary.get', summary: '按 UUID 获取面板库资产' },

	// ── sch_Netlist：网表 ──────────────────────────────────────────────────
	{ fullName: 'eda.sch_Netlist.setNetlist', summary: '更新网表' },
	{ fullName: 'eda.sch_Net.getCurrentProjectAllNets', summary: '获取原理图工程网络' },
	{ fullName: 'eda.sch_Net.getAllNets', summary: '获取原理图网络' },
	{ fullName: 'eda.sch_Net.getNet', summary: '按名称获取原理图网络' },
	{ fullName: 'eda.sch_Net.getAllNetsName', summary: '获取原理图网络名称' },

	// ── sch_Utils：工具 ────────────────────────────────────────────────────
	{ fullName: 'eda.sch_Utils.splitLines', summary: '拆分多段线' },

	// PCB document inspection and analysis APIs exposed by the pinned 0.4.15 catalog.
	{ fullName: 'eda.pcb_Document.getCanvasOrigin', summary: '获取 PCB 画布原点' },
	{ fullName: 'eda.pcb_Document.convertCanvasOriginToDataOrigin', summary: '将画布坐标转换为数据坐标' },
	{ fullName: 'eda.pcb_Document.convertDataOriginToCanvasOrigin', summary: '将数据坐标转换为画布坐标' },
	{ fullName: 'eda.pcb_Document.getPrimitiveAtPoint', summary: '获取坐标点的 PCB 图元' },
	{ fullName: 'eda.pcb_Document.getPrimitivesInRegion', summary: '获取 PCB 区域内的图元' },
	{ fullName: 'eda.pcb_Document.navigateToCoordinates', summary: '定位 PCB 画布坐标' },
	{ fullName: 'eda.pcb_Document.navigateToRegion', summary: '定位 PCB 画布区域' },
	{ fullName: 'eda.pcb_Document.zoomToBoardOutline', summary: '缩放至 PCB 板框' },
	{ fullName: 'eda.pcb_Document.getCurrentFilterConfiguration', summary: '获取 PCB 当前过滤器配置' },
	{ fullName: 'eda.pcb_SelectControl.getAllSelectedPrimitives_PrimitiveId', summary: '获取 PCB 已选图元 ID' },
	{ fullName: 'eda.pcb_SelectControl.getAllSelectedPrimitives', summary: '获取 PCB 已选图元对象' },
	{ fullName: 'eda.pcb_Net.getNet', summary: '按名称获取 PCB 网络' },
	{ fullName: 'eda.pcb_Net.getNetLength', summary: '获取 PCB 网络长度' },
	{ fullName: 'eda.pcb_Net.getNetColor', summary: '获取 PCB 网络颜色' },
	{ fullName: 'eda.pcb_Net.getAllPrimitivesByNet', summary: '获取 PCB 网络关联图元' },
	{ fullName: 'eda.pcb_Drc.getCurrentRuleConfiguration', summary: '获取当前 PCB 规则配置' },
	{ fullName: 'eda.pcb_Drc.getCurrentRuleConfigurationName', summary: '获取当前 PCB 规则配置名称' },
	{ fullName: 'eda.pcb_Drc.getDefaultRuleConfigurationName', summary: '获取默认 PCB 规则配置名称' },
	{ fullName: 'eda.pcb_Drc.getAllNetClasses', summary: '获取 PCB 网络类' },
	{ fullName: 'eda.pcb_Drc.getAllDifferentialPairs', summary: '获取 PCB 差分对' },
	{ fullName: 'eda.pcb_Drc.getAllEqualLengthNetGroups', summary: '获取 PCB 等长网络组' },
	{ fullName: 'eda.pcb_Drc.getAllPadPairGroups', summary: '获取 PCB 焊盘对组' },
	{ fullName: 'eda.pcb_Drc.createNetClass', summary: '创建 PCB 网络类' },
	{ fullName: 'eda.pcb_Drc.deleteNetClass', summary: '删除 PCB 网络类' },
	{ fullName: 'eda.pcb_Drc.modifyNetClassName', summary: '重命名 PCB 网络类' },
	{ fullName: 'eda.pcb_Drc.addNetToNetClass', summary: '向 PCB 网络类添加网络' },
	{ fullName: 'eda.pcb_Drc.removeNetFromNetClass', summary: '从 PCB 网络类移除网络' },
	{ fullName: 'eda.pcb_Drc.createDifferentialPair', summary: '创建 PCB 差分对' },
	{ fullName: 'eda.pcb_Drc.deleteDifferentialPair', summary: '删除 PCB 差分对' },
	{ fullName: 'eda.pcb_Drc.modifyDifferentialPairName', summary: '重命名 PCB 差分对' },
	{ fullName: 'eda.pcb_Drc.modifyDifferentialPairPositiveNet', summary: '设置差分对正网络' },
	{ fullName: 'eda.pcb_Drc.modifyDifferentialPairNegativeNet', summary: '设置差分对负网络' },
	{ fullName: 'eda.pcb_Drc.createEqualLengthNetGroup', summary: '创建 PCB 等长网络组' },
	{ fullName: 'eda.pcb_Drc.deleteEqualLengthNetGroup', summary: '删除 PCB 等长网络组' },
	{ fullName: 'eda.pcb_Drc.modifyEqualLengthNetGroupName', summary: '重命名 PCB 等长网络组' },
	{ fullName: 'eda.pcb_Drc.addNetToEqualLengthNetGroup', summary: '向等长网络组添加网络' },
	{ fullName: 'eda.pcb_Drc.removeNetFromEqualLengthNetGroup', summary: '从等长网络组移除网络' },
	{ fullName: 'eda.pcb_Drc.createPadPairGroup', summary: '创建 PCB 焊盘对组' },
	{ fullName: 'eda.pcb_Drc.deletePadPairGroup', summary: '删除 PCB 焊盘对组' },
	{ fullName: 'eda.pcb_Drc.modifyPadPairGroupName', summary: '重命名 PCB 焊盘对组' },
	{ fullName: 'eda.pcb_Drc.addPadPairToPadPairGroup', summary: '向焊盘对组添加焊盘对' },
	{ fullName: 'eda.pcb_Drc.removePadPairFromPadPairGroup', summary: '从焊盘对组移除焊盘对' },
	{ fullName: 'eda.pcb_Layer.getAllLayers', summary: '获取 PCB 图层' },
	{ fullName: 'eda.pcb_ManufactureData.getFlyingProbeTestFile', summary: '导出 PCB 飞针测试文件' },
	{ fullName: 'eda.lib_Device.get', summary: '按 UUID 获取器件库资产' },
	{ fullName: 'eda.lib_Symbol.get', summary: '按 UUID 获取符号库资产' },
	{ fullName: 'eda.lib_Symbol.getRenderImage', summary: '渲染符号库预览图像' },
	{ fullName: 'eda.lib_Footprint.get', summary: '按 UUID 获取封装库资产' },
	{ fullName: 'eda.lib_Footprint.getRenderImage', summary: '渲染封装库预览图像' },
	{ fullName: 'eda.pcb_SelectControl.getCurrentMousePosition', summary: 'PCB mouse position' },
	{ fullName: 'eda.pcb_SelectControl.doSelectPrimitives', summary: 'Select PCB primitives' },
	{ fullName: 'eda.pcb_SelectControl.clearSelected', summary: 'Clear PCB selection' },
	{ fullName: 'eda.pcb_Primitive.getPrimitiveTypeByPrimitiveId', summary: 'Get PCB primitive type' },
	{ fullName: 'eda.pcb_Primitive.getPrimitiveByPrimitiveId', summary: 'Get PCB primitive' },
	{ fullName: 'eda.pcb_Primitive.getPrimitivesByPrimitiveId', summary: 'Get PCB primitives' },
	{ fullName: 'eda.pcb_Primitive.getPrimitivesBBox', summary: 'Get PCB primitive bounds' },
	{ fullName: 'eda.sch_Document.getCurrentFilterConfiguration', summary: 'Get schematic filter configuration' },
	{ fullName: 'eda.sch_SelectControl.getAllSelectedPrimitives_PrimitiveId', summary: 'Get selected schematic primitive IDs' },
];

/**
 * 处理 API 索引查询任务。
 * @param payload 任务参数，可选 owner 字段用于按命名空间过滤。
 * @returns 索引结果。
 */
export async function handleApiIndexTask(payload: unknown): Promise<unknown> {
	let ownerFilter = '';
	if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
		ownerFilter = String((payload as Record<string, unknown>).owner ?? '').trim().toLowerCase();
	}

	const index = ownerFilter
		? SCHEMATIC_API_INDEX.filter(entry => entry.fullName.toLowerCase().includes(ownerFilter))
		: SCHEMATIC_API_INDEX;

	return {
		ok: true,
		total: index.length,
		index: preserveBoundedArray(index),
	};
}
