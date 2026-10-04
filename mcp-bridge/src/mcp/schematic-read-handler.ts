/**
 * ------------------------------------------------------------------------
 * 名称：桥接原理图语义读取任务处理
 * 说明：实时扫描当前原理图，输出以电路语义为核心的结构化 JSON。
 *       数据来源：sch_PrimitiveComponent（器件与引脚）、sch_PrimitiveWire（导线网络名）。
 *       完全基于 EDA 内存状态，无需生成网表文件，刚修改/刚放置的器件立即可见。
 * 作者：Lion
 * 邮箱：chengbin@3578.cn
 * 日期：2026-03-31
 * ------------------------------------------------------------------------
 */

import { getSyncState, isPlainObjectRecord, safeCall } from '../utils';

class PageNotReadyError extends Error {}

interface PageContext {
	pageUuid: string;
	documentUuid: string;
}

async function readPageContext(): Promise<PageContext> {
	try {
		const [page, document] = await Promise.all([
			eda.dmt_Schematic.getCurrentSchematicPageInfo(),
			eda.dmt_SelectControl.getCurrentDocumentInfo(),
		]);
		const pageUuid = typeof page?.uuid === 'string' ? page.uuid.trim() : '';
		const documentUuid = typeof document?.uuid === 'string' ? document.uuid.trim() : '';
		if (!pageUuid || !documentUuid || pageUuid !== documentUuid)
			throw new PageNotReadyError('当前原理图图页与编辑器文档尚未同步，请稍后重试。');
		return { pageUuid, documentUuid };
	}
	catch (error: unknown) {
		if (error instanceof PageNotReadyError)
			throw error;
		throw new PageNotReadyError('无法确认当前原理图图页与编辑器文档，请稍后重试。');
	}
}

async function assertSamePageContext(expected: PageContext): Promise<void> {
	const current = await readPageContext();
	if (current.pageUuid !== expected.pageUuid || current.documentUuid !== expected.documentUuid)
		throw new PageNotReadyError('读取期间原理图图页已切换，请重试。');
}

async function assertCurrentComponentIds(components: unknown[]): Promise<string[]> {
	const ids = components.map(component => getSyncState<string>(component, 'getState_PrimitiveId', ''));
	const currentIds = await safeCall<unknown>(() => Promise.resolve(eda.sch_PrimitiveComponent.getAllPrimitiveId(undefined, false)));
	if (!Array.isArray(currentIds) || currentIds.some(id => typeof id !== 'string' || !id))
		throw new PageNotReadyError('无法确认当前原理图图元 ID 列表，图页可能尚未加载完成，请重试。');
	const currentIdSet = new Set(currentIds);
	if (ids.some(id => !id) || new Set(ids).size !== ids.length || currentIdSet.size !== currentIds.length
		|| ids.length !== currentIds.length || ids.some(id => !currentIdSet.has(id))) {
		throw new PageNotReadyError('当前原理图器件列表与图元 ID 列表不一致，图页可能尚未加载完成，请重试。');
	}
	return ids;
}

async function readCurrentComponentIdsOnly(): Promise<{ ok: true; componentIds: string[]; data?: string } | { ok: false; error: string }> {
	const components = await safeCall<unknown>(() => Promise.resolve(eda.sch_PrimitiveComponent.getAll(undefined, false)));
	if (!Array.isArray(components))
		return { ok: false, error: '器件列表获取失败，sch_PrimitiveComponent.getAll 未返回数组。' };
	return { ok: true, componentIds: await assertCurrentComponentIds(components) };
}

function requiredState<T>(primitive: unknown, getter: string): T {
	const method = primitive && typeof primitive === 'object' ? (primitive as Record<string, unknown>)[getter] : undefined;
	if (typeof method !== 'function')
		throw new Error(`原理图连接图元回读不完整：${getter} 不可用。`);
	const value = method.call(primitive) as T | null | undefined;
	if (value === undefined || value === null)
		throw new Error(`原理图连接图元回读不完整：${getter} 未返回状态。`);
	return value;
}

function validWireLine(value: unknown): boolean {
	const flat = (part: unknown): boolean => Array.isArray(part) && part.length >= 4 && part.length % 2 === 0
		&& part.every(coordinate => typeof coordinate === 'number' && Number.isFinite(coordinate));
	if (flat(value))
		return true;
	if (!Array.isArray(value) || value.length === 0)
		return false;
	if (value.every(part => Array.isArray(part) && part.length === 2
		&& part.every(coordinate => typeof coordinate === 'number' && Number.isFinite(coordinate)))) {
		return value.length >= 2;
	}
	return value.every(flat);
}

interface ConnectivityPrimitiveSnapshot {
	scope: 'current_schematic_page';
	complete: true;
	pageUuid: string;
	wireCount: number;
	wires: Array<{ primitiveId: string; net: string; line: unknown }>;
	netPortCount: number;
	netPorts: Array<{ primitiveId: string; net: string; x: number; y: number }>;
	netFlagCount: number;
	netFlags: Array<{ primitiveId: string; net: string; x: number; y: number }>;
	netLabelCount: number;
	netLabels: Array<{ primitiveId: string; parentWireId: string; net: string; x: number | null; y: number | null }>;
}

async function readConnectivityPrimitives(pageUuid: string): Promise<ConnectivityPrimitiveSnapshot> {
	const rawWires = await eda.sch_PrimitiveWire.getAll();
	const wireIds = await eda.sch_PrimitiveWire.getAllPrimitiveId();
	const rawNetPorts = await eda.sch_PrimitiveComponent.getAll('netport' as ESCH_PrimitiveComponentType, false);
	const rawNetFlags = await eda.sch_PrimitiveComponent.getAll('netflag' as ESCH_PrimitiveComponentType, false);
	const rawAttributes = await eda.sch_PrimitiveAttribute.getAll();
	if (!Array.isArray(rawWires) || !Array.isArray(wireIds) || !Array.isArray(rawNetPorts) || !Array.isArray(rawNetFlags) || !Array.isArray(rawAttributes))
		throw new Error('原理图连接图元回读不完整：导线、器件或网络属性列表不是数组。');
	const wires = rawWires.map((wire) => {
		const primitiveId = requiredState<string>(wire, 'getState_PrimitiveId');
		const line = requiredState<unknown>(wire, 'getState_Line');
		if (typeof primitiveId !== 'string' || !primitiveId.trim() || !validWireLine(line))
			throw new Error('原理图连接图元回读不完整：导线 ID 或几何缺失。');
		return {
			primitiveId,
			// Unnamed wires legitimately have no cached net name; NET attributes are listed below.
			net: getSyncState<string>(wire, 'getState_Net', ''),
			line,
		};
	});
	const wireIdSet = new Set(wireIds);
	if (wireIds.some(id => typeof id !== 'string' || !id) || wireIds.length !== wireIdSet.size
		|| wireIdSet.size !== wires.length
		|| new Set(wires.map(wire => wire.primitiveId)).size !== wires.length
		|| wires.some(wire => !wireIdSet.has(wire.primitiveId))) {
		throw new PageNotReadyError('当前原理图导线列表与图元 ID 列表不一致，图页可能尚未加载完成，请重试。');
	}
	const netPorts = rawNetPorts.map((component) => {
		const primitiveId = requiredState<string>(component, 'getState_PrimitiveId');
		const net = requiredState<string>(component, 'getState_Net');
		const x = requiredState<number>(component, 'getState_X');
		const y = requiredState<number>(component, 'getState_Y');
		if (typeof primitiveId !== 'string' || !primitiveId.trim() || typeof net !== 'string' || !net.trim()
			|| !Number.isFinite(x) || !Number.isFinite(y)) {
			throw new Error('原理图连接图元回读不完整：NetPort ID 或坐标缺失。');
		}
		return { primitiveId, net, x, y };
	});
	const netFlags = rawNetFlags.map((component) => {
		const primitiveId = requiredState<string>(component, 'getState_PrimitiveId');
		const net = requiredState<string>(component, 'getState_Net');
		const x = requiredState<number>(component, 'getState_X');
		const y = requiredState<number>(component, 'getState_Y');
		if (typeof primitiveId !== 'string' || !primitiveId.trim() || typeof net !== 'string' || !net.trim()
			|| !Number.isFinite(x) || !Number.isFinite(y)) {
			throw new Error('原理图连接图元回读不完整：NetFlag ID、网络或坐标缺失。');
		}
		return { primitiveId, net, x, y };
	});
	const netLabels = rawAttributes.filter(attribute => getSyncState<string>(attribute, 'getState_Key', '') === 'NET').map((attribute) => {
		const primitiveId = requiredState<string>(attribute, 'getState_PrimitiveId');
		const x = getSyncState<unknown>(attribute, 'getState_X', null);
		const y = getSyncState<unknown>(attribute, 'getState_Y', null);
		if (typeof primitiveId !== 'string' || !primitiveId.trim())
			throw new Error('原理图连接图元回读不完整：网络标签 ID 缺失。');
		return {
			primitiveId,
			parentWireId: getSyncState<string>(attribute, 'getState_ParentPrimitiveId', ''),
			net: requiredState<string>(attribute, 'getState_Value'),
			x: typeof x === 'number' && Number.isFinite(x) ? x : null,
			y: typeof y === 'number' && Number.isFinite(y) ? y : null,
		};
	});
	return {
		scope: 'current_schematic_page',
		complete: true,
		pageUuid,
		wireCount: wires.length,
		wires,
		netPortCount: netPorts.length,
		netPorts,
		netFlagCount: netFlags.length,
		netFlags,
		netLabelCount: netLabels.length,
		netLabels,
	};
}

// 引脚连接点坐标键，用于在坐标→网络名映射中查找。
// 使用 Math.round 消除 EDA 坐标中的浮点精度误差（如 324.99999999999994 vs 325）。
function buildPinCoordinateKey(x: number, y: number): string {
	return `${Math.round(x)}_${Math.round(y)}`;
}

// 从多段线坐标中提取相邻端点对，并接入位于线段中部的端口和引脚。
// getState_Line 可以返回平铺坐标、连续点数组，或多段平铺坐标数组。
function addWireEdgesToAdjacencyGraph(
	lineData: unknown,
	graph: Map<string, Set<string>>,
	connectionPoints: Array<{ x: number; y: number }>,
	wireVertices?: Array<{ x: number; y: number }>,
): void {
	if (!Array.isArray(lineData) || lineData.length === 0) {
		return;
	}

	function addEdge(keyA: string, keyB: string): void {
		if (keyA === keyB) {
			return;
		}
		let setA = graph.get(keyA);
		if (!setA) {
			setA = new Set();
			graph.set(keyA, setA);
		}
		setA.add(keyB);
		let setB = graph.get(keyB);
		if (!setB) {
			setB = new Set();
			graph.set(keyB, setB);
		}
		setB.add(keyA);
	}

	function addFlatEdges(flatLine: unknown[]): void {
		for (let i = 0; i + 3 < flatLine.length; i += 2) {
			const x1 = Math.round(flatLine[i] as number);
			const y1 = Math.round(flatLine[i + 1] as number);
			const x2 = Math.round(flatLine[i + 2] as number);
			const y2 = Math.round(flatLine[i + 3] as number);
			const startKey = buildPinCoordinateKey(x1, y1);
			wireVertices?.push({ x: x1, y: y1 }, { x: x2, y: y2 });
			addEdge(startKey, buildPinCoordinateKey(x2, y2));
			for (const point of connectionPoints) {
				const { x, y } = point;
				if ((x - x1) * (y2 - y1) !== (y - y1) * (x2 - x1)
					|| x < Math.min(x1, x2) || x > Math.max(x1, x2)
					|| y < Math.min(y1, y2) || y > Math.max(y1, y2)) {
					continue;
				}
				addEdge(startKey, buildPinCoordinateKey(x, y));
			}
		}
	}

	if (Array.isArray(lineData[0])) {
		const parts = lineData as unknown[][];
		if (parts.every(part => Array.isArray(part) && part.length === 2)) {
			// [[x1,y1], [x2,y2], ...] 是一条连续多段线。
			addFlatEdges(parts.flat());
		}
		else {
			// [[x1,y1,x2,y2], ...] 中每个子数组是一条独立线段或多段线。
			for (const part of parts) {
				if (Array.isArray(part))
					addFlatEdges(part);
			}
		}
	}
	else {
		addFlatEdges(lineData);
	}
}

// BFS：沿导线邻接图将已知网络名传播到所有相连坐标。
function propagateNetworkNamesViaBFS(
	coordinateToNetworkNameMap: Map<string, string>,
	wireAdjacencyGraph: Map<string, Set<string>>,
): void {
	const queue: string[] = Array.from(coordinateToNetworkNameMap.keys());
	const visited = new Set<string>(queue);
	let head = 0;
	while (head < queue.length) {
		const currKey = queue[head++];
		const networkName = coordinateToNetworkNameMap.get(currKey)!;
		const neighbors = wireAdjacencyGraph.get(currKey);
		if (!neighbors) {
			continue;
		}
		for (const neighborKey of neighbors) {
			if (visited.has(neighborKey)) {
				continue;
			}
			visited.add(neighborKey);
			coordinateToNetworkNameMap.set(neighborKey, networkName);
			queue.push(neighborKey);
		}
	}
}

function readPinNcState(pin: unknown): boolean | null {
	const getter = isPlainObjectRecord(pin) ? pin.getState_NoConnected : undefined;
	if (typeof getter !== 'function')
		return null;
	try {
		// SDK 允许已存在的 getter 返回 undefined，表示没有 NC 标记。
		const value = getter.call(pin);
		return value === undefined ? false : typeof value === 'boolean' ? value : null;
	}
	catch {
		return null;
	}
}

// 扫描原理图并输出电路语义 JSON 字符串。
async function readSchematicCircuit(): Promise<{ ok: true; data: string; componentIds: string[] } | { ok: false; error: string }> {
	// ── 第一步：仅获取当前图页的器件实例 ──────────────────────────────────
	const componentListRaw = await safeCall<unknown>(() => Promise.resolve(eda.sch_PrimitiveComponent.getAll(undefined, false)));
	if (!Array.isArray(componentListRaw)) {
		return { ok: false, error: '器件列表获取失败，sch_PrimitiveComponent.getAll 未返回数组。' };
	}
	const componentIds = await assertCurrentComponentIds(componentListRaw);
	const pinsByComponentId = new Map<string, unknown[]>();
	const connectionPoints: Array<{ x: number; y: number }> = [];
	for (const rawComponent of componentListRaw) {
		const net = getSyncState<string>(rawComponent, 'getState_Net', '');
		if (net.length > 0) {
			connectionPoints.push({
				x: Math.round(getSyncState<number>(rawComponent, 'getState_X', 0)),
				y: Math.round(getSyncState<number>(rawComponent, 'getState_Y', 0)),
			});
			continue;
		}
		const designator = getSyncState<string>(rawComponent, 'getState_Designator', '');
		if (!designator && getSyncState<string>(rawComponent, 'getState_ComponentType', '') !== 'part')
			continue;
		const primitiveId = getSyncState<string>(rawComponent, 'getState_PrimitiveId', '');
		const pinsRaw = await safeCall<unknown>(() => Promise.resolve(eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(primitiveId)));
		if (!Array.isArray(pinsRaw))
			return { ok: false, error: `器件 ${designator} 的引脚列表读取失败或格式异常。` };
		const pins = pinsRaw;
		pinsByComponentId.set(primitiveId, pins);
		for (const rawPin of pins) {
			connectionPoints.push({
				x: Math.round(getSyncState<number>(rawPin, 'getState_X', 0)),
				y: Math.round(getSyncState<number>(rawPin, 'getState_Y', 0)),
			});
		}
	}
	// ── 第二步：构建坐标→网络名映射（BFS 沿导线传播） ──────────────────────
	// 种子来源 1：网络标志器件坐标（VCC/GND 等），net name = getState_Net()。
	// 种子来源 2：导线自身携带网络名（非电源网络，如 NET1/NET2 等自动命名网络）。
	// BFS：以种子坐标为起点，沿导线邻接图传播网络名到所有相连坐标。
	const coordinateToNetworkNameMap: Map<string, string> = new Map();

	// 收集所有导线，构建坐标邻接图，同时将有网络名的导线端点作为种子。
	const wireAdjacencyGraph: Map<string, Set<string>> = new Map();
	const wireListRaw = await safeCall<unknown>(() => Promise.resolve(eda.sch_PrimitiveWire.getAll()));
	if (!Array.isArray(wireListRaw))
		return { ok: false, error: '导线列表获取失败，sch_PrimitiveWire.getAll 未返回数组。' };
	if (Array.isArray(wireListRaw)) {
		// 先收集全部导线端点，下一轮才可将 T 形支线接到主线中段。
		const wireVertices: Array<{ x: number; y: number }> = [];
		for (const rawWire of wireListRaw) {
			const lineData: unknown = getSyncState<unknown>(rawWire, 'getState_Line', null);
			addWireEdgesToAdjacencyGraph(lineData, wireAdjacencyGraph, [], wireVertices);
		}
		const allConnectionPoints = [...connectionPoints, ...wireVertices];
		for (const rawWire of wireListRaw) {
			const lineData: unknown = getSyncState<unknown>(rawWire, 'getState_Line', null);
			addWireEdgesToAdjacencyGraph(lineData, wireAdjacencyGraph, allConnectionPoints);
			// 导线自身已有网络名时，将其所有端点作为种子。
			const wireName = getSyncState<string>(rawWire, 'getState_Net', '');
			if (wireName.length > 0 && Array.isArray(lineData)) {
				const flat = Array.isArray(lineData[0])
					? (lineData as number[][]).flatMap(p => p)
					: (lineData as number[]);
				for (let i = 0; i + 1 < flat.length; i += 2) {
					const key = buildPinCoordinateKey(flat[i], flat[i + 1]);
					if (!coordinateToNetworkNameMap.has(key)) {
						coordinateToNetworkNameMap.set(key, wireName);
					}
				}
			}
		}
	}

	// 将网络标志器件坐标写入种子映射（优先级高于导线自身名称，允许覆盖）。
	for (const rawComponent of componentListRaw) {
		const netFlagNetworkName = getSyncState<string>(rawComponent, 'getState_Net', '');
		if (netFlagNetworkName.length > 0) {
			const x = getSyncState<number>(rawComponent, 'getState_X', 0);
			const y = getSyncState<number>(rawComponent, 'getState_Y', 0);
			coordinateToNetworkNameMap.set(buildPinCoordinateKey(x, y), netFlagNetworkName);
		}
	}

	// BFS 传播：从所有种子坐标出发，沿导线邻接图扩散网络名。
	propagateNetworkNamesViaBFS(coordinateToNetworkNameMap, wireAdjacencyGraph);

	// ── 第三步：遍历器件，组装语义输出结构 ──────────────────────────────────
	interface PinSemanticInfo {
		pinNumber: string;
		pinId: string | null;
		x: number | null;
		y: number | null;
		rotation: number | null;
		noConnected: boolean | null;
		pinSignalName: string;
		pinElectricalType: string;
		connectedNetworkName: string;
		hasNoConnectMark: boolean;
	}

	interface ComponentSemanticInfo {
		componentInstanceId: string;
		componentDesignator: string;
		componentSymbolName: string;
		schematicSubPartName: string;
		pins: PinSemanticInfo[];
	}

	const networkToPinRefSetMap: Map<string, Set<string>> = new Map();
	const components: ComponentSemanticInfo[] = [];

	for (const rawComponent of componentListRaw) {
		const componentDesignator = getSyncState<string>(rawComponent, 'getState_Designator', '');
		const netFlagNetworkName = getSyncState<string>(rawComponent, 'getState_Net', '');

		if (componentDesignator.length === 0 && netFlagNetworkName.length === 0
			&& getSyncState<string>(rawComponent, 'getState_ComponentType', '') !== 'part') {
			continue;
		}

		if (netFlagNetworkName.length > 0) {
			// 网络标志器件（VCC/GND 等）：以网络名作为位号，展示为单引脚语义条目。
			const primitiveId = getSyncState<string>(rawComponent, 'getState_PrimitiveId', '');
			const pinRef = `${netFlagNetworkName}.1`;
			let networkPinSet = networkToPinRefSetMap.get(netFlagNetworkName);
			if (!networkPinSet) {
				networkPinSet = new Set();
				networkToPinRefSetMap.set(netFlagNetworkName, networkPinSet);
			}
			networkPinSet.add(pinRef);
			components.push({
				componentInstanceId: primitiveId,
				componentDesignator: netFlagNetworkName,
				componentSymbolName: netFlagNetworkName,
				schematicSubPartName: '',
				pins: [{
					pinNumber: '1',
					pinId: null,
					x: null,
					y: null,
					rotation: null,
					noConnected: null,
					pinSignalName: netFlagNetworkName,
					pinElectricalType: 'power',
					connectedNetworkName: netFlagNetworkName,
					hasNoConnectMark: false,
				}],
			});
			continue;
		}

		// 普通器件：获取所有引脚并查找连接网络名。
		const primitiveId = getSyncState<string>(rawComponent, 'getState_PrimitiveId', '');
		const pins: PinSemanticInfo[] = [];
		for (const rawPin of pinsByComponentId.get(primitiveId) ?? []) {
			const pinNumber = getSyncState<string>(rawPin, 'getState_PinNumber', '');
			const pinSignalName = getSyncState<string>(rawPin, 'getState_PinName', '');
			const pinElectricalType = getSyncState<string>(rawPin, 'getState_pinType', getSyncState<string>(rawPin, 'getState_PinType', ''));
			const pinConnectionX = getSyncState<number>(rawPin, 'getState_X', 0);
			const pinConnectionY = getSyncState<number>(rawPin, 'getState_Y', 0);
			const noConnected = readPinNcState(rawPin);
			const hasNoConnectMark = noConnected ?? false;
			const pinId = getSyncState<unknown>(rawPin, 'getState_PrimitiveId', undefined);
			const rawX = getSyncState<unknown>(rawPin, 'getState_X', undefined);
			const rawY = getSyncState<unknown>(rawPin, 'getState_Y', undefined);
			const rawRotation = getSyncState<unknown>(rawPin, 'getState_Rotation', undefined);

			const coordinateKey = buildPinCoordinateKey(pinConnectionX, pinConnectionY);
			const connectedNetworkName = coordinateToNetworkNameMap.get(coordinateKey) ?? '';

			if (connectedNetworkName.length > 0) {
				const pinRef = `${componentDesignator || primitiveId}.${pinNumber || pinSignalName}`;
				let networkPinSet = networkToPinRefSetMap.get(connectedNetworkName);
				if (!networkPinSet) {
					networkPinSet = new Set();
					networkToPinRefSetMap.set(connectedNetworkName, networkPinSet);
				}
				networkPinSet.add(pinRef);
			}

			pins.push({
				pinNumber,
				pinSignalName,
				pinElectricalType,
				connectedNetworkName,
				hasNoConnectMark,
				pinId: typeof pinId === 'string' && pinId ? pinId : null,
				x: typeof rawX === 'number' && Number.isFinite(rawX) ? rawX : null,
				y: typeof rawY === 'number' && Number.isFinite(rawY) ? rawY : null,
				rotation: typeof rawRotation === 'number' && Number.isFinite(rawRotation) ? rawRotation : null,
				noConnected,
			});
		}

		components.push({
			componentInstanceId: primitiveId,
			componentDesignator,
			componentSymbolName: getSyncState<string>(rawComponent, 'getState_Name', ''),
			schematicSubPartName: getSyncState<string>(rawComponent, 'getState_SubPartName', ''),
			pins,
		});
	}

	// ── 第四步：将网络映射转为按网络名排序的数组 ────────────────────────────
	interface NetworkSemanticInfo {
		networkName: string;
		connectedPinRefs: string[];
	}

	const networks: NetworkSemanticInfo[] = [];
	for (const [networkName, pinRefSet] of networkToPinRefSetMap) {
		networks.push({
			networkName,
			connectedPinRefs: Array.from(pinRefSet).sort(),
		});
	}
	networks.sort((a, b) => a.networkName.localeCompare(b.networkName));

	// ── 第五步：执行 DRC 检查 ────────────────────────────────────────────────
	const drcRawResult = await safeCall<unknown>(() => Promise.resolve(eda.sch_Drc.check(false, false, true)));
	const drcCheckPassed = drcRawResult === true;

	return {
		ok: true,
		componentIds,
		data: JSON.stringify({
			drcCheckPassed,
			componentCount: components.length,
			networkCount: networks.length,
			components,
			networks,
		}),
	};
}

/**
 * 处理原理图语义读取任务。
 * @param payload 可选完整连接图元回读参数。
 * @returns 读取结果，含完整电路语义快照。
 */
export async function handleSchematicReadTask(payload: unknown): Promise<unknown> {
	const includeConnectivityPrimitives = payload && typeof payload === 'object' && 'includeConnectivityPrimitives' in payload
		&& (payload as { includeConnectivityPrimitives?: unknown }).includeConnectivityPrimitives === true;
	// Internal wire management needs page and primitive identity without running a full netlist and DRC scan.
	const connectivityOnly = includeConnectivityPrimitives && payload && typeof payload === 'object' && 'internalConnectivityOnly' in payload
		&& (payload as { internalConnectivityOnly?: unknown }).internalConnectivityOnly === true;
	try {
		const context = await readPageContext();
		const result = connectivityOnly ? await readCurrentComponentIdsOnly() : await readSchematicCircuit();
		if (!result.ok)
			return { ok: false, error: result.error };
		const connectivityPrimitives = includeConnectivityPrimitives
			? await readConnectivityPrimitives(context.pageUuid)
			: undefined;
		if (connectivityPrimitives) {
			const componentIds = new Set(result.componentIds);
			if ([...connectivityPrimitives.netPorts, ...connectivityPrimitives.netFlags]
				.some(primitive => !componentIds.has(primitive.primitiveId))) {
				throw new PageNotReadyError('当前图页连接图元与器件列表不一致，请等待图页加载完成后重试。');
			}
		}
		await assertSamePageContext(context);
		return {
			ok: true,
			pageUuid: context.pageUuid,
			...(result.data === undefined ? {} : { schematicCircuitSnapshot: result.data }),
			// A JSON string preserves every item through Bridge serialization, which otherwise caps arrays at 120.
			...(connectivityPrimitives ? { connectivityPrimitivesSnapshot: JSON.stringify(connectivityPrimitives) } : {}),
		};
	}
	catch (error: unknown) {
		return {
			ok: false,
			...(error instanceof PageNotReadyError ? { errorCode: 'PAGE_NOT_READY', reason: 'page_not_ready' } : {}),
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
