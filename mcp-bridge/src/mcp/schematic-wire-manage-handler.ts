import { getEdaRuntime, isPlainObjectRecord, preserveBoundedArray, toSafeErrorMessage } from '../utils.ts';
import { handleSchematicConnectivityTask } from './schematic-connectivity-handler.ts';
import { handleSchematicReadTask } from './schematic-read-handler.ts';

type Action = 'read' | 'modify' | 'delete';

interface WireState {
	primitiveId: string;
	line: unknown;
	net: string;
	color: string | null;
	lineWidth: number | null;
	lineType: number | null;
}

interface PageSnapshot {
	pageUuid: string;
	wires: Array<{ primitiveId: string; line: unknown; net: string }>;
	netLabels: Array<{ parentWireId: string; net: string }>;
}

interface WireApi extends Record<string, unknown> {
	getAll: () => Promise<unknown>;
	modify?: (primitiveId: string, property: Record<string, unknown>) => Promise<unknown>;
	delete?: (primitiveId: string) => Promise<unknown>;
}

const SCOPE = 'current_schematic_page';
const NATIVE_RESULT_UNKNOWN = /timed?\s*out|ETIMEDOUT|disconnect|connection\s+(?:closed|lost|reset|aborted)|socket\s+(?:closed|hang up)|transport\s+(?:closed|lost)|websocket.*(?:closed|not open)|ECONNRESET|ECONNABORTED|EPIPE/i;
const COORDINATE_EPSILON = 1e-6;

function requiredId(value: unknown): string {
	if (typeof value !== 'string' || !value.trim())
		throw new TypeError('primitiveId must be a non-empty string.');
	return value.trim();
}

function wireApi(runtime: Record<string, unknown>): WireApi {
	const api = runtime.sch_PrimitiveWire;
	if (!isPlainObjectRecord(api) || typeof api.getAll !== 'function')
		throw new TypeError('EDA sch_PrimitiveWire.getAll is unavailable. Open a schematic page first.');
	return api as WireApi;
}

function state<T>(primitive: unknown, name: string): T {
	const getter = isPlainObjectRecord(primitive) ? primitive[`getState_${name}`] : undefined;
	if (typeof getter !== 'function')
		throw new TypeError(`EDA wire getState_${name} is unavailable.`);
	return getter.call(primitive) as T;
}

function readWire(primitive: unknown): WireState {
	const primitiveId = state<unknown>(primitive, 'PrimitiveId');
	const line = state<unknown>(primitive, 'Line');
	const net = state<unknown>(primitive, 'Net');
	const color = state<unknown>(primitive, 'Color');
	const lineWidth = state<unknown>(primitive, 'LineWidth');
	const lineType = state<unknown>(primitive, 'LineType');
	if (typeof primitiveId !== 'string' || !primitiveId.trim() || finiteLinePaths(line) === null || typeof net !== 'string'
		|| (color !== null && typeof color !== 'string')
		|| (lineWidth !== null && (typeof lineWidth !== 'number' || !Number.isFinite(lineWidth)))
		|| (lineType !== null && (typeof lineType !== 'number' || !Number.isInteger(lineType)))) {
		throw new TypeError('EDA wire has incomplete ID, net, or style state.');
	}
	const outputLine = Array.isArray(line)
		? preserveBoundedArray(line.map(part => Array.isArray(part) ? preserveBoundedArray([...part]) : part))
		: line;
	return { primitiveId, line: outputLine, net, color, lineWidth, lineType };
}

async function pageSnapshot(): Promise<PageSnapshot | { ok: false; error: string; errorCode?: string }> {
	const response = await handleSchematicReadTask({ includeConnectivityPrimitives: true, internalConnectivityOnly: true });
	if (!isPlainObjectRecord(response) || response.ok !== true) {
		return {
			ok: false,
			error: isPlainObjectRecord(response) ? String(response.error ?? 'schematic_read failed') : 'schematic_read failed',
			...(isPlainObjectRecord(response) && typeof response.errorCode === 'string' ? { errorCode: response.errorCode } : {}),
		};
	}
	const snapshot: unknown = JSON.parse(String(response.connectivityPrimitivesSnapshot));
	if (!isPlainObjectRecord(snapshot) || snapshot.complete !== true || typeof response.pageUuid !== 'string'
		|| !Array.isArray(snapshot.wires) || !Array.isArray(snapshot.netLabels)) {
		throw new TypeError('schematic_read did not return a complete current-page connectivity snapshot.');
	}
	return {
		pageUuid: response.pageUuid,
		wires: snapshot.wires as PageSnapshot['wires'],
		netLabels: snapshot.netLabels as PageSnapshot['netLabels'],
	};
}

async function assertSamePage(runtime: Record<string, unknown>, expected: string): Promise<void> {
	const schematic = runtime.dmt_Schematic;
	const select = runtime.dmt_SelectControl;
	if (!isPlainObjectRecord(schematic) || typeof schematic.getCurrentSchematicPageInfo !== 'function'
		|| !isPlainObjectRecord(select) || typeof select.getCurrentDocumentInfo !== 'function') {
		throw new Error('Current schematic page and editor document cannot be confirmed.');
	}
	const [page, document] = await Promise.all([schematic.getCurrentSchematicPageInfo(), select.getCurrentDocumentInfo()]);
	if (!isPlainObjectRecord(page) || !isPlainObjectRecord(document) || page.uuid !== expected || document.uuid !== expected)
		throw new Error('The active schematic page changed during the wire operation.');
}

async function readCurrentWires(api: WireApi, snapshot: PageSnapshot): Promise<WireState[]> {
	const raw = await api.getAll();
	if (!Array.isArray(raw))
		throw new TypeError('EDA sch_PrimitiveWire.getAll did not return an array.');
	const wires = raw.map(readWire);
	const snapshotById = new Map(snapshot.wires.map(wire => [wire.primitiveId, wire]));
	if (wires.length !== snapshotById.size || new Set(wires.map(wire => wire.primitiveId)).size !== wires.length
		|| wires.some(wire => !snapshotById.has(wire.primitiveId)
			|| lineGeometryKey(wire.line) !== lineGeometryKey(snapshotById.get(wire.primitiveId)!.line))) {
		throw new Error('Current-page wire list changed during read; retry after the schematic page loads.');
	}
	return wires;
}

function normalizedLine(value: unknown): number[] {
	if (!Array.isArray(value) || value.length < 4 || value.length > 512 || value.length % 2 !== 0
		|| value.some(coordinate => typeof coordinate !== 'number' || !Number.isFinite(coordinate))) {
		throw new TypeError('line must contain 2 to 256 [x,y] points as a flat numeric array.');
	}
	const line = [...value] as number[];
	for (let index = 0; index < line.length - 2; index += 2) {
		const dx = Math.abs(line[index] - line[index + 2]);
		const dy = Math.abs(line[index + 1] - line[index + 3]);
		if (dx <= COORDINATE_EPSILON && dy <= COORDINATE_EPSILON)
			throw new TypeError(`line segment ${index / 2} is too short.`);
		if (dx > COORDINATE_EPSILON && dy > COORDINATE_EPSILON)
			throw new TypeError(`line segment ${index / 2} must be horizontal or vertical.`);
		if (dx <= COORDINATE_EPSILON)
			line[index + 2] = line[index];
		else
			line[index + 3] = line[index + 1];
	}
	return preserveBoundedArray(line);
}

function flatPaths(value: unknown): number[][] {
	if (!Array.isArray(value))
		return [];
	if (!Array.isArray(value[0]))
		return [value as number[]];
	if (value.every(part => Array.isArray(part) && part.length === 2))
		return [value.flat() as number[]];
	return value.filter(part => Array.isArray(part) && part.length >= 4) as number[][];
}

function finiteLinePaths(value: unknown): number[][] | null {
	if (!Array.isArray(value) || value.length === 0)
		return null;
	const paths: unknown[] = !Array.isArray(value[0])
		? [value]
		: value.every(part => Array.isArray(part) && part.length === 2) ? [value.flat()] : value;
	if (paths.some(path => !Array.isArray(path) || path.length < 4 || path.length % 2 !== 0
		|| path.some(coordinate => typeof coordinate !== 'number' || !Number.isFinite(coordinate)))) {
		return null;
	}
	return paths as number[][];
}

function requiredProperty(value: unknown): Record<string, unknown> {
	if (!isPlainObjectRecord(value) || Object.keys(value).length === 0)
		throw new TypeError('property must be a non-empty object.');
	for (const [key, item] of Object.entries(value)) {
		switch (key) {
			case 'line':
				normalizedLine(item);
				break;
			case 'net':
				if (typeof item !== 'string')
					throw new TypeError('net must be a string.');
				break;
			case 'color':
				if (item !== null && typeof item !== 'string')
					throw new TypeError('color must be a string or null.');
				break;
			case 'lineWidth':
				if (item !== null && (typeof item !== 'number' || !Number.isFinite(item) || item < 1 || item > 10))
					throw new TypeError('lineWidth must be 1-10 or null.');
				break;
			case 'lineType':
				if (item !== null && (typeof item !== 'number' || !Number.isInteger(item) || item < 0 || item > 3))
					throw new TypeError('lineType must be 0-3 or null.');
				break;
			default: throw new TypeError(`Unsupported wire property: ${key}.`);
		}
	}
	return value;
}

function segments(value: unknown): string[] {
	if (!Array.isArray(value))
		return [];
	const paths = Array.isArray(value[0])
		? value.every(part => Array.isArray(part) && part.length === 2) ? [value.flat()] : value
		: [value];
	const intervals = new Map<string, Array<[number, number]>>();
	const otherSegments: string[] = [];
	for (const path of paths) {
		if (!Array.isArray(path))
			continue;
		for (let index = 0; index + 3 < path.length; index += 2) {
			const coordinates = [path[index], path[index + 1], path[index + 2], path[index + 3]];
			if (coordinates.some(coordinate => typeof coordinate !== 'number' || !Number.isFinite(coordinate)))
				continue;
			const [x1, y1, x2, y2] = (coordinates as number[]).map(coordinate => Math.round(coordinate / COORDINATE_EPSILON));
			if (x1 === x2 && y1 === y2)
				continue;
			if (x1 === x2 || y1 === y2) {
				const key = x1 === x2 ? `V:${x1}` : `H:${y1}`;
				const first = x1 === x2 ? y1 : x1;
				const second = x1 === x2 ? y2 : x2;
				const group = intervals.get(key) ?? [];
				group.push([Math.min(first, second), Math.max(first, second)]);
				intervals.set(key, group);
			}
			else {
				otherSegments.push(`D:${[[x1, y1], [x2, y2]].map(point => point.join(',')).sort().join('|')}`);
			}
		}
	}
	const result = [...otherSegments];
	for (const [key, group] of intervals) {
		group.sort((first, second) => first[0] - second[0]);
		let [start, end] = group[0];
		for (const [nextStart, nextEnd] of group.slice(1)) {
			if (nextStart <= end) {
				end = Math.max(end, nextEnd);
			}
			else {
				result.push(`${key}:${start}:${end}`);
				[start, end] = [nextStart, nextEnd];
			}
		}
		result.push(`${key}:${start}:${end}`);
	}
	return result.sort();
}

function lineGeometryKey(value: unknown): string {
	const normalizedSegments = segments(value);
	if (normalizedSegments.length > 0)
		return JSON.stringify(normalizedSegments);
	// Native schematics can contain point wires. Keep their coordinates when comparing readbacks.
	return JSON.stringify(finiteLinePaths(value));
}

function requestedValuesMatch(after: WireState, property: Record<string, unknown>): boolean {
	return Object.entries(property).every(([key, expected]) => {
		if (key === 'line')
			return JSON.stringify(segments(after.line)) === JSON.stringify(segments(expected));
		return after[key as keyof WireState] === expected;
	});
}

function wireStateKey(wire: WireState): string {
	return JSON.stringify({ line: lineGeometryKey(wire.line), net: wire.net, color: wire.color, lineWidth: wire.lineWidth, lineType: wire.lineType });
}

function unknownNativeWrite(action: 'modify' | 'delete', primitiveId: string, before: WireState, error: unknown): Record<string, unknown> {
	const message = toSafeErrorMessage(error);
	if (!NATIVE_RESULT_UNKNOWN.test(message))
		throw error;
	return { ok: false, action, scope: SCOPE, primitiveId, before, reason: 'native_call_result_unknown', error: message, commitUnknown: true, readbackRequired: true, nativeCallSettled: false };
}

function unknownAfterWrite(action: 'modify' | 'delete', primitiveId: string, before: WireState, error: unknown, details: Record<string, unknown> = {}): Record<string, unknown> {
	return { ok: false, action, scope: SCOPE, primitiveId, before, ...details, reason: 'post_write_readback_failed', error: toSafeErrorMessage(error), commitUnknown: true, readbackRequired: true, nativeCallSettled: true };
}

export async function handleSchematicWireManageTask(payload: unknown): Promise<unknown> {
	if (!isPlainObjectRecord(payload))
		throw new TypeError('schematic_wire_manage payload must be an object.');
	const action = payload.action as Action;
	if (action !== 'read' && action !== 'modify' && action !== 'delete')
		throw new TypeError('action must be read, modify, or delete.');
	const primitiveId = payload.primitiveId === undefined && action === 'read' ? undefined : requiredId(payload.primitiveId);
	const property = action === 'modify' ? requiredProperty(payload.property) : undefined;
	const runtime = getEdaRuntime();
	if (!runtime)
		throw new TypeError('EDA runtime is unavailable.');
	const api = wireApi(runtime);
	if (action === 'modify' && typeof api.modify !== 'function')
		throw new TypeError('EDA sch_PrimitiveWire.modify is unavailable.');
	if (action === 'delete' && typeof api.delete !== 'function')
		throw new TypeError('EDA sch_PrimitiveWire.delete is unavailable.');
	const snapshot = await pageSnapshot();
	if ('ok' in snapshot)
		return snapshot;
	const wires = await readCurrentWires(api, snapshot);
	await assertSamePage(runtime, snapshot.pageUuid);
	if (action === 'read') {
		const selected = primitiveId ? wires.find(wire => wire.primitiveId === primitiveId) : undefined;
		return { ok: true, action, scope: SCOPE, complete: true, pageUuid: snapshot.pageUuid, wireCount: wires.length, ...(primitiveId ? { primitiveId, wire: selected ?? null } : { wiresSnapshot: JSON.stringify(wires) }) };
	}
	const before = wires.find(wire => wire.primitiveId === primitiveId);
	if (!before)
		return { ok: false, action, scope: SCOPE, pageUuid: snapshot.pageUuid, primitiveId, reason: 'wire_not_found' };
	if (action === 'modify' && property!.line !== undefined && segments(before.line).length === 0
		&& segments(normalizedLine(property!.line)).length > 1) {
		return {
			ok: false,
			action,
			scope: SCOPE,
			pageUuid: snapshot.pageUuid,
			primitiveId,
			reason: 'point_wire_path_conversion_unsupported',
			before,
			requested: { ...property!, line: preserveBoundedArray(normalizedLine(property!.line)) },
			applied: false,
			verified: false,
			nativeCallAttempted: false,
			guidance: 'EDA 原生接口可能把点导线转换为闭合三角形。请用 schematic_connectivity_action wire_create 新建目标路径，核对几何与连接后，再显式删除不再需要的点导线。',
		};
	}
	const approvedOtherWireIds = new Set<string>();
	if (action === 'modify' && (property!.line !== undefined || property!.net !== undefined)) {
		const lines = property!.line === undefined ? flatPaths(before.line) : [normalizedLine(property!.line)];
		if (lines.length === 0)
			return { ok: false, action, scope: SCOPE, primitiveId, reason: 'wire_geometry_unavailable' };
		const allowedWireIds = Array.isArray(payload.allowedWireIds) ? payload.allowedWireIds : [];
		const expectedNet = snapshot.netLabels.find(label => label.parentWireId === primitiveId && label.net)?.net || before.net;
		const previews: Record<string, unknown>[] = [];
		for (const line of lines) {
			const preview = await handleSchematicConnectivityTask({ action: 'wire_preview', line, net: expectedNet || undefined, allowedWireIds: [primitiveId, ...allowedWireIds] });
			if (!isPlainObjectRecord(preview) || preview.canCreate !== true)
				return { ok: false, action, scope: SCOPE, pageUuid: snapshot.pageUuid, primitiveId, reason: 'wire_contact_conflict', previewSnapshot: JSON.stringify(preview) };
			previews.push(preview);
			if (property!.line !== undefined && Array.isArray(preview.touches)) {
				for (const touch of preview.touches) {
					if (isPlainObjectRecord(touch) && typeof touch.primitiveId === 'string' && touch.primitiveId !== primitiveId
						&& allowedWireIds.includes(touch.primitiveId)) {
						approvedOtherWireIds.add(touch.primitiveId);
					}
				}
			}
		}
		if (property!.net !== undefined && property!.net !== before.net) {
			const otherWireTouches = previews.some(preview => Array.isArray(preview.touches)
				&& preview.touches.some(touch => isPlainObjectRecord(touch) && touch.primitiveId !== primitiveId));
			const namedTerminalTouches = previews.some(preview => (Array.isArray(preview.portTouches) && preview.portTouches.length > 0)
				|| (Array.isArray(preview.labelTouches) && preview.labelTouches.length > 0))
			|| snapshot.netLabels.some(label => label.parentWireId === primitiveId);
			if (otherWireTouches || namedTerminalTouches)
				return { ok: false, action, scope: SCOPE, pageUuid: snapshot.pageUuid, primitiveId, reason: 'connected_wire_net_change', previewsSnapshot: JSON.stringify(previews) };
		}
		await assertSamePage(runtime, snapshot.pageUuid);
	}
	await assertSamePage(runtime, snapshot.pageUuid);
	if (action === 'modify') {
		const update = { ...property!, ...(property!.line === undefined ? {} : { line: normalizedLine(property!.line) }) };
		try {
			await api.modify!.call(api, primitiveId!, update);
		}
		catch (error: unknown) { return unknownNativeWrite(action, primitiveId!, before, error); }
		try {
			const afterSnapshot = await pageSnapshot();
			if ('ok' in afterSnapshot)
				throw new Error(afterSnapshot.error);
			if (afterSnapshot.pageUuid !== snapshot.pageUuid)
				throw new Error('The active schematic page changed after modifying the wire.');
			const afterWires = await readCurrentWires(api, afterSnapshot);
			const after = afterWires.find(wire => wire.primitiveId === primitiveId);
			await assertSamePage(runtime, snapshot.pageUuid);

			const beforeById = new Map(wires.map(wire => [wire.primitiveId, wireStateKey(wire)]));
			const afterIds = new Set(afterWires.map(wire => wire.primitiveId));
			const changedOtherWireIds = afterWires.filter(wire => wire.primitiveId !== primitiveId
				&& beforeById.has(wire.primitiveId) && beforeById.get(wire.primitiveId) !== wireStateKey(wire)).map(wire => wire.primitiveId);
			const removedOtherWireIds = wires.filter(wire => wire.primitiveId !== primitiveId && !afterIds.has(wire.primitiveId)).map(wire => wire.primitiveId);
			const addedWireIds = afterWires.filter(wire => !beforeById.has(wire.primitiveId)).map(wire => wire.primitiveId);
			const unexpectedOtherWireIds = [...changedOtherWireIds, ...removedOtherWireIds].filter(id => !approvedOtherWireIds.has(id));
			if (!after || !requestedValuesMatch(after, update)) {
				const changedWireIds = preserveBoundedArray([
					...afterWires.filter(wire => beforeById.has(wire.primitiveId) && beforeById.get(wire.primitiveId) !== wireStateKey(wire)).map(wire => wire.primitiveId),
					...wires.filter(wire => !afterIds.has(wire.primitiveId)).map(wire => wire.primitiveId),
					...addedWireIds,
				]);
				return unknownAfterWrite(action, primitiveId!, before, new Error('EDA wire state differs from the requested modification.'), {
					pageUuid: snapshot.pageUuid,
					after: after ?? null,
					requested: update,
					changedWireIds,
					changedOtherWireIds: preserveBoundedArray(changedOtherWireIds),
					removedOtherWireIds: preserveBoundedArray(removedOtherWireIds),
					addedWireIds: preserveBoundedArray(addedWireIds),
					unexpectedOtherWireIds: preserveBoundedArray(unexpectedOtherWireIds),
				});
			}
			if (unexpectedOtherWireIds.length > 0 || addedWireIds.length > 0) {
				return { ok: false, action, scope: SCOPE, pageUuid: snapshot.pageUuid, primitiveId, before, after, reason: 'unexpected_wire_changes', changedOtherWireIds, removedOtherWireIds, addedWireIds, unexpectedOtherWireIds, commitUnknown: true, readbackRequired: true, nativeCallSettled: true };
			}
			return { ok: true, action, scope: SCOPE, pageUuid: snapshot.pageUuid, primitiveId, verified: true, before, after, changedOtherWireIds, removedOtherWireIds };
		}
		catch (error: unknown) { return unknownAfterWrite(action, primitiveId!, before, error); }
	}
	let deletionResult: unknown;
	try {
		deletionResult = await api.delete!.call(api, primitiveId!);
	}
	catch (error: unknown) { return unknownNativeWrite(action, primitiveId!, before, error); }
	try {
		const afterSnapshot = await pageSnapshot();
		if ('ok' in afterSnapshot)
			throw new Error(afterSnapshot.error);
		if (afterSnapshot.pageUuid !== snapshot.pageUuid)
			throw new Error('The active schematic page changed after deleting the wire.');
		const after = await readCurrentWires(api, afterSnapshot);
		await assertSamePage(runtime, snapshot.pageUuid);
		if (after.some(wire => wire.primitiveId === primitiveId)) {
			if (deletionResult === false)
				return { ok: false, action, scope: SCOPE, pageUuid: snapshot.pageUuid, primitiveId, reason: 'native_delete_rejected', before };
			throw new Error('EDA wire remains after delete.');
		}
		return { ok: true, action, scope: SCOPE, pageUuid: snapshot.pageUuid, primitiveId, deleted: true, verified: true, before, wireCountAfter: after.length };
	}
	catch (error: unknown) { return unknownAfterWrite(action, primitiveId!, before, error); }
}
