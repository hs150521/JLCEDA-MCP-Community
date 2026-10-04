/**
 * ------------------------------------------------------------------------
 * 名称：桥接 API 调用任务处理
 * 说明：解析调用路径并执行对应 EDA API。
 * 作者：Lion
 * 邮箱：chengbin@3578.cn
 * 日期：2026-03-12
 * 备注：仅处理 api/invoke 任务。
 * ------------------------------------------------------------------------
 */

import type { SchematicPinAdapter } from '../bridge/protocol.ts';
import type { AutoRoutingSnapshot } from './pcb-auto-routing-observation';
import { isReadOnlyBridgeRequest } from '../bridge/bridge-contract';
import { getSyncState, isPlainObjectRecord, preserveBoundedArray, safeCall, toSafeErrorMessage, toSerializableAsync } from '../utils';
import { AutoRoutingPageChangedError, compareAutoRoutingSnapshots, readAutoRoutingSnapshot, unavailableAutoRoutingObservation } from './pcb-auto-routing-observation';
import { tryModifySchematicComponentPin } from './schematic-component-pin-edit.ts';
import { resolveSchematicLibraryComponent } from './schematic-library-component.ts';

const PCB_AUTO_LAYOUT = 'eda.pcb_document.autolayout';
const PCB_AUTO_ROUTING = 'eda.pcb_document.autorouting';
const PCB_COMPONENT_GET_ALL = 'eda.pcb_primitivecomponent.getall';
const SCHEMATIC_COMPONENT_GET_ALL_IDS = 'eda.sch_primitivecomponent.getallprimitiveid';
const PCB_ROUTING_READBACKS = new Map([
	['eda.pcb_primitiveline.getall', 'line'],
	['eda.pcb_primitivearc.getall', 'arc'],
	['eda.pcb_primitivepolyline.getall', 'polyline'],
	['eda.pcb_primitivevia.getall', 'via'],
]);
const SCHEMATIC_PAGES_GET_ALL = 'eda.dmt_schematic.getallschematicpagesinfo';
let pendingAutoLayoutPcbUuid: string | undefined;

function isUnknownNativeRpcResult(errorMessage: string): boolean {
	return /timed?\s*out|ETIMEDOUT|disconnect|connection\s+(?:closed|lost|reset|aborted)|socket\s+(?:closed|hang up)|transport\s+(?:closed|lost)|websocket.*(?:closed|not open)|ECONNRESET|ECONNABORTED|EPIPE/i.test(errorMessage);
}

function pcbComponentPosition(component: unknown): { primitiveId: string; designator: string; x: number; y: number; rotation: number } | undefined {
	const raw = isPlainObjectRecord(component) ? component : {};
	const primitiveId = String(getSyncState(component, 'getState_PrimitiveId', raw.primitiveId ?? raw.uuid ?? ''));
	const designator = String(getSyncState(component, 'getState_Designator', raw.designator ?? ''));
	const x = Number(getSyncState(component, 'getState_X', raw.x));
	const y = Number(getSyncState(component, 'getState_Y', raw.y));
	const rotation = Number(getSyncState(component, 'getState_Rotation', raw.rotation));
	if (!primitiveId || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(rotation))
		return undefined;
	return { primitiveId, designator, x, y, rotation };
}

function pcbRoutingPrimitive(primitive: unknown, kind: string): Record<string, unknown> | undefined {
	const raw = isPlainObjectRecord(primitive) ? primitive : {};
	const state = (name: string): unknown => getSyncState(primitive, `getState_${name}`, raw[name.charAt(0).toLowerCase() + name.slice(1)]);
	const primitiveId = state('PrimitiveId');
	if (typeof primitiveId !== 'string' || primitiveId.length === 0)
		return undefined;
	// getSyncState treats null as a missing value; here null is the EDA's
	// explicit state for unnetted board-outline and silkscreen polylines.
	const nativeNet = typeof raw.getState_Net === 'function' ? raw.getState_Net.call(primitive) : undefined;
	const net = nativeNet === undefined ? raw.net : nativeNet;
	if (typeof net !== 'string' && net !== null)
		return undefined;
	const primitiveLock = state('PrimitiveLock');
	if (typeof primitiveLock !== 'boolean')
		return undefined;
	const entry: Record<string, unknown> = { primitiveId, net, primitiveLock };
	if (kind === 'via') {
		for (const field of ['X', 'Y', 'HoleDiameter', 'Diameter']) {
			const value = state(field);
			if (typeof value !== 'number' || !Number.isFinite(value))
				return undefined;
			entry[field.charAt(0).toLowerCase() + field.slice(1)] = value;
		}
		const viaType = state('ViaType');
		if (typeof viaType !== 'string' && (typeof viaType !== 'number' || !Number.isFinite(viaType)))
			return undefined;
		entry.viaType = viaType;
		return entry;
	}
	entry.layer = state('Layer');
	entry.lineWidth = state('LineWidth');
	if ((typeof entry.layer !== 'string' && (typeof entry.layer !== 'number' || !Number.isFinite(entry.layer)))
		|| typeof entry.lineWidth !== 'number' || !Number.isFinite(entry.lineWidth)) {
		return undefined;
	}
	if (kind === 'polyline') {
		const polygon = state('Polygon');
		const source = isPlainObjectRecord(polygon) && typeof polygon.getSource === 'function'
			? (polygon.getSource as () => unknown).call(polygon)
			: Array.isArray(polygon) ? polygon : isPlainObjectRecord(polygon) ? polygon.polygon : undefined;
		if (!Array.isArray(source) || source.length === 0 || source.some(part => typeof part !== 'string' && (typeof part !== 'number' || !Number.isFinite(part))))
			return undefined;
		entry.polygonSource = JSON.stringify(source);
		return entry;
	}
	for (const field of ['StartX', 'StartY', 'EndX', 'EndY']) {
		const value = state(field);
		if (typeof value !== 'number' || !Number.isFinite(value))
			return undefined;
		entry[field.charAt(0).toLowerCase() + field.slice(1)] = value;
	}
	if (kind === 'arc') {
		const angle = state('ArcAngle');
		const interactiveMode = state('InteractiveMode');
		if (typeof angle !== 'number' || !Number.isFinite(angle)
			|| typeof interactiveMode !== 'number' || !Number.isFinite(interactiveMode)) {
			return undefined;
		}
		entry.arcAngle = angle;
		entry.interactiveMode = interactiveMode;
	}
	return entry;
}

async function currentPcbUuid(): Promise<string | undefined> {
	const pcb = await Promise.resolve(eda.dmt_Pcb.getCurrentPcbInfo());
	return isPlainObjectRecord(pcb) && typeof pcb.uuid === 'string' ? pcb.uuid : undefined;
}

async function currentPcbLayoutContext(): Promise<{ pageKind: 'pcb'; pageUuid?: string; documentUuid?: string; projectUuid?: string }> {
	const [pcb, document, project] = await Promise.all([
		safeCall(() => eda.dmt_Pcb.getCurrentPcbInfo()),
		safeCall(() => eda.dmt_SelectControl.getCurrentDocumentInfo()),
		safeCall(() => eda.dmt_Project.getCurrentProjectInfo()),
	]);
	return {
		pageKind: 'pcb',
		pageUuid: pcb?.uuid,
		documentUuid: document?.uuid,
		projectUuid: document?.parentProjectUuid ?? project?.uuid,
	};
}

async function currentSchematicDeletePage(): Promise<string> {
	const [page, document] = await Promise.all([
		eda.dmt_Schematic.getCurrentSchematicPageInfo(),
		eda.dmt_SelectControl.getCurrentDocumentInfo(),
	]);
	const pageUuid = typeof page?.uuid === 'string' ? page.uuid.trim() : '';
	const documentUuid = typeof document?.uuid === 'string' ? document.uuid.trim() : '';
	if (!pageUuid || pageUuid !== documentUuid)
		throw new Error('当前原理图图页与编辑器文档尚未同步，已取消删除。');
	return pageUuid;
}

async function assertSchematicDeletePage(expected: string): Promise<void> {
	if (await currentSchematicDeletePage() !== expected)
		throw new Error('删除期间原理图图页已切换，已停止后续删除。');
}

// 在对象上解析段名，要求精确匹配。
function resolveSegmentKey(target: Record<string, unknown>, segment: string): string {
	if (segment in target) {
		return segment;
	}

	const normalizedSegment = segment.toLowerCase();
	for (const key of Object.keys(target)) {
		if (key.toLowerCase() !== normalizedSegment) {
			continue;
		}
		return key;
	}

	throw new Error(`调用路径不存在: ${segment}`);
}

// 禁止访问的 JS 内置属性名，防止 prototype pollution。
const FORBIDDEN_SEGMENT_NAMES = new Set(['__proto__', 'prototype', 'constructor']);

// 解析调用目标。
function resolveApiCallable(apiFullName: string): { callable: (...args: unknown[]) => unknown; thisArg: unknown; resolvedPath: string } {
	const normalized = apiFullName.trim();
	if (normalized.length === 0) {
		throw new Error('缺少 apiFullName。');
	}

	const segments = normalized.split('.');
	if (segments.length < 3 || segments[0].toLowerCase() !== 'eda' || segments.some(item => item.length === 0)) {
		throw new Error(`apiFullName 格式非法: "${apiFullName}"。正确格式为 eda.模块名.方法名（以“.”分隔的至少三段路径）。`);
	}

	if (segments.some(s => FORBIDDEN_SEGMENT_NAMES.has(s))) {
		throw new Error(`apiFullName 包含非法属性名。`);
	}

	let current: unknown = eda;
	for (let index = 1; index < segments.length - 1; index += 1) {
		if (!isPlainObjectRecord(current)) {
			throw new Error(`调用路径无效: ${normalized}`);
		}

		const segment = segments[index];
		const segmentKey = resolveSegmentKey(current, segment);
		current = current[segmentKey];
	}

	if (!isPlainObjectRecord(current)) {
		throw new Error(`调用目标无效: ${apiFullName}`);
	}

	const methodKey = resolveSegmentKey(current, segments[segments.length - 1]);
	const callable = current[methodKey];
	if (typeof callable !== 'function') {
		throw new TypeError(`目标不可调用: ${apiFullName}`);
	}

	return {
		callable: callable as (...args: unknown[]) => unknown,
		thisArg: current,
		resolvedPath: normalized,
	};
}

/**
 * 处理 API 调用任务。
 * @param payload 任务参数。
 * @returns 调用结果。
 */
export async function handleApiInvokeTask(payload: unknown, reportPinAdapter?: (adapter: SchematicPinAdapter) => void): Promise<unknown> {
	if (!isPlainObjectRecord(payload)) {
		throw new Error('invoke 任务参数必须为对象。');
	}

	const apiFullName = String(payload.apiFullName ?? '').trim();
	const { callable, thisArg, resolvedPath } = resolveApiCallable(apiFullName);
	const invokeArgs = Array.isArray(payload.args) ? payload.args : [];
	const normalizedPath = resolvedPath.toLowerCase();
	const routingProps = normalizedPath === PCB_AUTO_ROUTING && isPlainObjectRecord(invokeArgs[0]) ? invokeArgs[0] : undefined;
	const requestedRoutingNets = Array.isArray(routingProps?.RoutingNets)
		&& routingProps.RoutingNets.every((net: unknown) => typeof net === 'string')
		? [...routingProps.RoutingNets] as string[]
		: undefined;
	if (payload.includeCompletePositions !== undefined
		&& (payload.includeCompletePositions !== true || normalizedPath !== PCB_COMPONENT_GET_ALL || invokeArgs.length !== 0)) {
		throw new TypeError('includeCompletePositions is only supported for eda.pcb_PrimitiveComponent.getAll with no arguments.');
	}
	if (payload.includeCompleteRouting !== undefined
		&& (payload.includeCompleteRouting !== true || !PCB_ROUTING_READBACKS.has(normalizedPath) || invokeArgs.length !== 0)) {
		throw new TypeError('includeCompleteRouting is only supported for PCB routing primitive getAll methods with no arguments.');
	}
	if (payload.includeCompleteSchematicComponentIds !== undefined
		&& (payload.includeCompleteSchematicComponentIds !== true || normalizedPath !== SCHEMATIC_COMPONENT_GET_ALL_IDS
			|| invokeArgs.length !== 2 || invokeArgs[0] !== null || invokeArgs[1] !== false)) {
		throw new TypeError('includeCompleteSchematicComponentIds requires eda.sch_PrimitiveComponent.getAllPrimitiveId with args [null, false].');
	}

	if (normalizedPath === 'eda.sch_primitivepin.modify') {
		const adapted = await tryModifySchematicComponentPin(invokeArgs, reportPinAdapter);
		if (adapted)
			return { apiFullName: resolvedPath, ...adapted };
		reportPinAdapter?.('native_pin');
	}
	if (normalizedPath === 'eda.sch_primitivecomponent.create') {
		const resolved = await resolveSchematicLibraryComponent(invokeArgs[0], invokeArgs[3]);
		if (resolved.ok === false)
			return { apiFullName: resolvedPath, ...resolved };
		invokeArgs[0] = resolved.component;
		invokeArgs[3] = resolved.subPartName;
	}

	// EDA 3.x 的 modify 会在省略 otherProperty 时清空已有的 BOM 属性。
	if (normalizedPath === 'eda.sch_primitivecomponent.modify' && typeof invokeArgs[0] === 'string' && isPlainObjectRecord(invokeArgs[1]) && !Object.hasOwn(invokeArgs[1], 'otherProperty')) {
		const module = thisArg as { get?: (id: string) => Promise<unknown> };
		if (typeof module.get !== 'function') {
			throw new TypeError('无法读取器件原有属性，已取消可能清空 BOM 属性的修改。');
		}
		const component = await Promise.resolve(module.get.call(thisArg, invokeArgs[0]));
		if (!component) {
			throw new Error(`找不到器件图元 ${invokeArgs[0]}，未执行修改。`);
		}
		const getOtherProperty = (component as Record<string, unknown>).getState_OtherProperty;
		if (typeof getOtherProperty !== 'function') {
			throw new TypeError('无法读取器件原有 BOM 属性，已取消可能清空 BOM 属性的修改。');
		}
		let otherProperty: unknown;
		try {
			otherProperty = getOtherProperty.call(component);
		}
		catch {
			throw new TypeError('无法读取器件原有 BOM 属性，已取消可能清空 BOM 属性的修改。');
		}
		if (otherProperty !== undefined && !isPlainObjectRecord(otherProperty)) {
			throw new TypeError('无法读取器件原有 BOM 属性，已取消可能清空 BOM 属性的修改。');
		}
		invokeArgs[1] = { ...invokeArgs[1], otherProperty: otherProperty === undefined ? {} : { ...otherProperty } };
	}

	// EDA 3.x 的数组重载可能仅删除首项。只接受可逐项核验的 ID。
	if (normalizedPath === 'eda.sch_primitivecomponent.delete') {
		if (!(typeof invokeArgs[0] === 'string' && invokeArgs[0].trim())
			&& !(Array.isArray(invokeArgs[0]) && invokeArgs[0].every(id => typeof id === 'string' && id.trim()))) {
			throw new TypeError('原理图器件删除只接受单个 ID 或 ID 数组。');
		}
		const module = thisArg as {
			getAll?: (componentType?: unknown, allSchematicPages?: boolean) => Promise<unknown>;
			getAllPrimitiveId?: (componentType?: unknown, allSchematicPages?: boolean) => Promise<string[]>;
		};
		if (typeof module.getAllPrimitiveId !== 'function') {
			throw new TypeError('无法核对器件图元列表，已取消删除。');
		}
		const pageUuid = await currentSchematicDeletePage();
		if (typeof payload.expectedSchematicDeletePageUuid === 'string'
			&& pageUuid !== payload.expectedSchematicDeletePageUuid) {
			throw new Error('删除前原理图图页已切换，已取消删除。');
		}
		const readCurrentIds = async (): Promise<string[]> => {
			const current = await Promise.resolve(module.getAllPrimitiveId!.call(thisArg, undefined, false));
			await assertSchematicDeletePage(pageUuid);
			if (!Array.isArray(current) || current.some(id => typeof id !== 'string' || !id)
				|| new Set(current).size !== current.length) {
				throw new TypeError('无法核对当前页器件图元列表，已停止删除。');
			}
			return current;
		};
		const ids = (typeof invokeArgs[0] === 'string' ? [invokeArgs[0]] : invokeArgs[0]) as string[];
		const deletedIds: string[] = [];
		const failedIds: string[] = [];
		let deleteAttempted = false;
		let remaining = await readCurrentIds();
		const callDelete = async (target: unknown): Promise<string | undefined> => {
			try {
				await Promise.resolve(callable.call(thisArg, target));
				return undefined;
			}
			catch (error: unknown) {
				const message = toSafeErrorMessage(error);
				if (isUnknownNativeRpcResult(message))
					return message;
				throw error;
			}
		};
		const unknownDeleteResult = (id: string, index: number, error: string): Record<string, unknown> => ({
			apiFullName: resolvedPath,
			ok: false,
			result: false,
			reason: 'native_delete_result_unknown',
			error,
			deletedIds,
			failedIds,
			uncertainIds: [id],
			notAttemptedIds: ids.slice(index + 1),
			commitUnknown: true,
			readbackRequired: true,
			nativeCallSettled: false,
		});
		for (const [index, id] of ids.entries()) {
			try {
				await assertSchematicDeletePage(pageUuid);
			}
			catch (error: unknown) {
				if (!deleteAttempted)
					throw error;
				return {
					apiFullName: resolvedPath,
					ok: false,
					result: false,
					reason: 'post_write_readback_failed',
					error: toSafeErrorMessage(error),
					deletedIds,
					failedIds,
					uncertainIds: [],
					notAttemptedIds: ids.slice(index),
					commitUnknown: true,
					readbackRequired: true,
					nativeCallSettled: true,
				};
			}
			if (!remaining.includes(id)) {
				failedIds.push(id);
				continue;
			}
			deleteAttempted = true;
			const initialDeleteError = await callDelete(id);
			if (initialDeleteError)
				return unknownDeleteResult(id, index, initialDeleteError);
			try {
				remaining = await readCurrentIds();
				if (remaining.includes(id)) {
					if (typeof module.getAll !== 'function')
						throw new TypeError('无法核对当前页器件对象，删除结果尚未确认。');
					const currentObjects = await Promise.resolve(module.getAll.call(thisArg, undefined, false));
					await assertSchematicDeletePage(pageUuid);
					if (!Array.isArray(currentObjects))
						throw new TypeError('无法读取当前页器件对象，已停止删除。');
					const currentObjectIds = currentObjects.map(item => getSyncState(item, 'getState_PrimitiveId', ''));
					const currentIdSet = new Set(remaining);
					if (currentObjectIds.length !== remaining.length
						|| new Set(currentObjectIds).size !== currentObjectIds.length
						|| currentObjectIds.some(objectId => !objectId || !currentIdSet.has(objectId))) {
						throw new TypeError('当前页器件对象与图元 ID 列表不一致，删除结果尚未确认。');
					}
					const liveObject = currentObjects.find(item => getSyncState(item, 'getState_PrimitiveId', '') === id);
					if (!liveObject)
						throw new TypeError('当前页器件对象与图元 ID 列表不一致，删除结果尚未确认。');
					const fallbackDeleteError = await callDelete(liveObject);
					if (fallbackDeleteError)
						return unknownDeleteResult(id, index, fallbackDeleteError);
					remaining = await readCurrentIds();
				}
				(remaining.includes(id) ? failedIds : deletedIds).push(id);
			}
			catch (error: unknown) {
				return {
					apiFullName: resolvedPath,
					ok: false,
					result: false,
					reason: 'post_write_readback_failed',
					error: toSafeErrorMessage(error),
					deletedIds,
					failedIds,
					uncertainIds: [id],
					notAttemptedIds: ids.slice(index + 1),
					commitUnknown: true,
					readbackRequired: true,
					nativeCallSettled: true,
				};
			}
		}
		return { apiFullName: resolvedPath, pageUuid, result: failedIds.length === 0, deletedIds, failedIds };
	}

	if (normalizedPath === PCB_AUTO_LAYOUT && pendingAutoLayoutPcbUuid) {
		return {
			apiFullName: resolvedPath,
			ok: false,
			commitState: 'unknown',
			retryBlocked: true,
			pcbUuid: pendingAutoLayoutPcbUuid,
			verification: 'Activate the timed-out PCB and read all components with eda.pcb_PrimitiveComponent.getAll() before another autoLayout call.',
		};
	}
	const layoutContext = normalizedPath === PCB_AUTO_LAYOUT ? await currentPcbLayoutContext() : undefined;
	const layoutPcbUuid = layoutContext?.pageUuid;
	if (normalizedPath === PCB_AUTO_LAYOUT && !layoutPcbUuid)
		throw new Error('无法确认当前 PCB 身份，未启动自动布局。');
	if (normalizedPath === PCB_AUTO_LAYOUT && typeof payload.expectedPcbUuid === 'string' && payload.expectedPcbUuid !== layoutPcbUuid)
		throw new Error('PCB page changed between task start and autoLayout invocation; the operation was not started.');
	const readbackPcbUuid = normalizedPath === PCB_COMPONENT_GET_ALL && invokeArgs.length === 0 && pendingAutoLayoutPcbUuid
		? await currentPcbUuid()
		: undefined;
	const observedRoutingNets = requestedRoutingNets?.length && requestedRoutingNets.length <= 3
		&& requestedRoutingNets.every(net => net.trim().length > 0)
		&& new Set(requestedRoutingNets).size === requestedRoutingNets.length
		? requestedRoutingNets
		: undefined;
	const routingPcbUuid = normalizedPath === PCB_AUTO_ROUTING && observedRoutingNets ? await currentPcbUuid() : undefined;
	if (normalizedPath === PCB_AUTO_ROUTING && observedRoutingNets && !routingPcbUuid)
		throw new Error('无法确认当前 PCB 身份，未启动自动布线。');
	let routingBefore: AutoRoutingSnapshot | undefined;
	let routingBeforeError: unknown;
	if (normalizedPath === PCB_AUTO_ROUTING && observedRoutingNets) {
		try {
			routingBefore = await readAutoRoutingSnapshot(observedRoutingNets, routingPcbUuid);
		}
		catch (error: unknown) {
			if (error instanceof AutoRoutingPageChangedError)
				throw error;
			routingBeforeError = error;
		}
		if (await currentPcbUuid() !== routingPcbUuid)
			throw new Error('The active PCB changed before autoRouting invocation; the operation was not started.');
	}
	let invokeResult: unknown;
	try {
		invokeResult = await Promise.resolve(callable.apply(thisArg, invokeArgs));
	}
	catch (error: unknown) {
		if (normalizedPath === PCB_AUTO_LAYOUT && /RPC Call autoLayout Timed Out/i.test(toSafeErrorMessage(error))) {
			pendingAutoLayoutPcbUuid = layoutPcbUuid;
			return {
				apiFullName: resolvedPath,
				ok: false,
				commitState: 'unknown',
				retryBlocked: true,
				pcbUuid: layoutPcbUuid,
				layoutContext,
				error: toSafeErrorMessage(error),
				verification: 'Auto layout may still commit. Activate this PCB and read all component positions with eda.pcb_PrimitiveComponent.getAll() before retrying.',
			};
		}
		if (normalizedPath === PCB_AUTO_ROUTING && /RPC Call autoRouting Timed Out/i.test(toSafeErrorMessage(error))) {
			let routingObservation: Record<string, unknown> | undefined;
			if (routingBefore && observedRoutingNets) {
				try {
					const routingAfter = await readAutoRoutingSnapshot(observedRoutingNets, routingBefore.pageUuid);
					routingObservation = compareAutoRoutingSnapshots(routingBefore, routingAfter);
				}
				catch (readbackError: unknown) {
					routingObservation = unavailableAutoRoutingObservation(readbackError);
				}
			}
			else if (routingBeforeError) {
				routingObservation = unavailableAutoRoutingObservation(routingBeforeError);
			}
			return {
				apiFullName: resolvedPath,
				...(requestedRoutingNets !== undefined ? { requestedRoutingNets } : {}),
				...(routingObservation ? { routingObservation } : {}),
				ok: false,
				commitState: 'unknown',
				commitUnknown: true,
				retryBlocked: true,
				error: toSafeErrorMessage(error),
				verification: 'The requested-net observation is provisional and does not prove routing completion or selection scope. Restart the original EDA host, then read back every PCB track, via, and net before retrying.',
			};
		}
		const errorMessage = toSafeErrorMessage(error);
		if (!isReadOnlyBridgeRequest('/bridge/jlceda/api/invoke', payload) && isUnknownNativeRpcResult(errorMessage)) {
			return {
				apiFullName: resolvedPath,
				...(requestedRoutingNets !== undefined ? { requestedRoutingNets } : {}),
				ok: false,
				commitUnknown: true,
				readbackRequired: true,
				nativeCallSettled: false,
				error: errorMessage,
			};
		}
		throw error;
	}
	if (payload.includeCompleteRouting === true) {
		if (!Array.isArray(invokeResult))
			throw new TypeError('PCB routing primitive readback returned an invalid list.');
		const routingPrimitives = invokeResult.map(primitive => pcbRoutingPrimitive(primitive, PCB_ROUTING_READBACKS.get(normalizedPath)!));
		if (routingPrimitives.some(primitive => !primitive))
			throw new TypeError('PCB routing primitive readback omitted an ID or geometry.');
		return {
			apiFullName: resolvedPath,
			result: await toSerializableAsync(invokeResult),
			routingPrimitives: preserveBoundedArray(routingPrimitives),
			routingPrimitiveCount: routingPrimitives.length,
		};
	}
	if (payload.includeCompleteSchematicComponentIds === true) {
		if (!Array.isArray(invokeResult) || invokeResult.some(id => typeof id !== 'string' || !id.trim())
			|| new Set(invokeResult).size !== invokeResult.length) {
			return { apiFullName: resolvedPath, ok: false, error: 'Current schematic component ID readback was incomplete.' };
		}
		const components = await Promise.resolve(eda.sch_PrimitiveComponent.getAll(undefined, false));
		if (!Array.isArray(components))
			return { apiFullName: resolvedPath, ok: false, error: 'Current schematic component state readback was incomplete.' };
		const schematicComponentStates = components.map((component) => {
			const otherProperty = getSyncState<unknown>(component, 'getState_OtherProperty', undefined) ?? {};
			return {
				primitiveId: getSyncState(component, 'getState_PrimitiveId', ''),
				designator: getSyncState(component, 'getState_Designator', ''),
				otherPropertyJson: isPlainObjectRecord(otherProperty) ? JSON.stringify(otherProperty) : undefined,
			};
		});
		if (schematicComponentStates.length !== invokeResult.length
			|| schematicComponentStates.some(state => typeof state.primitiveId !== 'string' || !state.primitiveId.trim()
				|| typeof state.designator !== 'string' || typeof state.otherPropertyJson !== 'string')
			|| new Set(schematicComponentStates.map(state => state.primitiveId)).size !== invokeResult.length
			|| schematicComponentStates.some(state => !invokeResult.includes(state.primitiveId))) {
			return { apiFullName: resolvedPath, ok: false, error: 'Current schematic component state readback was incomplete.' };
		}
		return {
			apiFullName: resolvedPath,
			result: await toSerializableAsync(invokeResult),
			schematicComponentIds: preserveBoundedArray([...invokeResult]),
			schematicComponentCount: invokeResult.length,
			schematicComponentStates: preserveBoundedArray(schematicComponentStates),
		};
	}
	if (normalizedPath === PCB_COMPONENT_GET_ALL && invokeArgs.length === 0 && Array.isArray(invokeResult)) {
		const autoLayoutReadbackPerformed = Boolean(pendingAutoLayoutPcbUuid && pendingAutoLayoutPcbUuid === readbackPcbUuid);
		if (autoLayoutReadbackPerformed || payload.includeCompletePositions === true) {
			const componentPositions = invokeResult.map(pcbComponentPosition);
			if (componentPositions.some(position => !position)) {
				return {
					apiFullName: resolvedPath,
					ok: false,
					...(pendingAutoLayoutPcbUuid ? { commitState: 'unknown', retryBlocked: true, pcbUuid: pendingAutoLayoutPcbUuid } : {}),
					error: 'The PCB component readback omitted an ID or position.',
				};
			}
			const readbackDetails: Record<string, unknown> = {};
			if (autoLayoutReadbackPerformed) {
				pendingAutoLayoutPcbUuid = undefined;
				readbackDetails.autoLayoutReadbackPerformed = true;
				readbackDetails.verification = 'Compare this complete component position and rotation snapshot with the pre-layout snapshot before deciding whether to retry.';
			}
			return {
				apiFullName: resolvedPath,
				result: await toSerializableAsync(invokeResult),
				componentPositions: preserveBoundedArray(componentPositions),
				componentCount: componentPositions.length,
				...readbackDetails,
			};
		}
	}
	if (normalizedPath === SCHEMATIC_PAGES_GET_ALL && invokeArgs.length === 0 && Array.isArray(invokeResult)) {
		const schematicPages = invokeResult.map(page => isPlainObjectRecord(page)
			? { uuid: page.uuid, parentSchematicUuid: page.parentSchematicUuid, name: page.name }
			: undefined);
		if (schematicPages.some(page => !page || typeof page.uuid !== 'string' || typeof page.parentSchematicUuid !== 'string'))
			return { apiFullName: resolvedPath, ok: false, error: 'Schematic page inventory omitted a UUID or parent schematic UUID.' };
		return {
			apiFullName: resolvedPath,
			result: await toSerializableAsync(invokeResult),
			schematicPages: preserveBoundedArray(schematicPages),
			pageCount: schematicPages.length,
		};
	}
	if (normalizedPath === PCB_AUTO_ROUTING && isPlainObjectRecord(invokeResult)) {
		const failedNets = Array.isArray(invokeResult.failedNets) && invokeResult.failedNets.length > 0;
		const reportedFailedNetsOutsideSelection = requestedRoutingNets?.length && Array.isArray(invokeResult.failedNets)
			? invokeResult.failedNets.filter((net: unknown): net is string => typeof net === 'string' && !requestedRoutingNets.includes(net))
			: [];
		const reportedTotalNetsCountExceedsSelection = requestedRoutingNets !== undefined
			&& requestedRoutingNets.length > 0
			&& typeof invokeResult.totalNetsCount === 'number'
			&& invokeResult.totalNetsCount > requestedRoutingNets.length;
		const selectionScopeUnconfirmed = reportedFailedNetsOutsideSelection.length > 0 || reportedTotalNetsCountExceedsSelection;
		const selectionDetails: Record<string, unknown> = {};
		if (requestedRoutingNets !== undefined)
			selectionDetails.requestedRoutingNets = requestedRoutingNets;
		if (requestedRoutingNets?.length) {
			selectionDetails.reportedFailedNetsOutsideSelection = reportedFailedNetsOutsideSelection;
			selectionDetails.reportedTotalNetsCountExceedsSelection = reportedTotalNetsCountExceedsSelection;
			selectionDetails.selectionScopeUnconfirmed = selectionScopeUnconfirmed;
		}
		const partialCount = typeof invokeResult.totalNetsCount === 'number'
			&& typeof invokeResult.successNetsCount === 'number'
			&& invokeResult.successNetsCount < invokeResult.totalNetsCount;
		const incomplete = invokeResult.success === false || failedNets || partialCount || selectionScopeUnconfirmed;
		if (!incomplete)
			return { apiFullName: resolvedPath, result: await toSerializableAsync(invokeResult), ...selectionDetails };
		return {
			apiFullName: resolvedPath,
			result: await toSerializableAsync(invokeResult),
			...selectionDetails,
			ok: false,
			routingState: invokeResult.success === false && invokeResult.successNetsCount === 0 && invokeResult.duration === 0 ? 'not_started' : 'incomplete',
			verification: 'Check PCB tracks, vias, and DRC before treating this routing attempt as complete.',
		};
	}

	return {
		apiFullName: resolvedPath,
		result: await toSerializableAsync(invokeResult),
	};
}
