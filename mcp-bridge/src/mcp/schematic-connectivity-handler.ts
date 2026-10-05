import type { SchematicPinAdapter } from '../bridge/protocol.ts';
import { resolveContractTimeoutMs } from '../bridge/bridge-contract.ts';
import { getEdaRuntime, getSyncState, isPlainObjectRecord, preserveBoundedArray, toSerializableAsync } from '../utils.ts';
import { handleSchematicReadTask } from './schematic-read-handler.ts';

interface Point { x: number; y: number }
interface Segment { start: Point; end: Point }
type ConnectivityAction = 'wire_preview' | 'wire_create' | 'netport_create' | 'netport_move';
// EDA readback may differ from grid coordinates by a few floating-point ulps.
const COORDINATE_EPSILON = 1e-6;
const MAX_WIRE_LINE_COORDINATES = 512;
const WIRE_READBACK_ATTEMPTS = 12;
const WIRE_READBACK_INTERVAL_MS = 250;
const WIRE_RESULT_RESERVE_MS = 1000;

function unknownCommitAfterReadback(action: Exclude<ConnectivityAction, 'wire_preview'>, error: unknown, context: Record<string, unknown>): Record<string, unknown> {
	return {
		ok: false,
		action,
		...context,
		reason: 'post_write_readback_failed',
		error: error instanceof Error ? error.message : String(error),
		commitUnknown: true,
		readbackRequired: true,
		nativeCallSettled: true,
	};
}

function unknownNativeWrite(action: Exclude<ConnectivityAction, 'wire_preview'>, error: unknown, context: Record<string, unknown>): Record<string, unknown> {
	const message = error instanceof Error ? error.message : String(error);
	if (!/timed?\s*out|ETIMEDOUT|disconnect|connection\s+(?:closed|lost|reset|aborted)|socket\s+(?:closed|hang up)|transport\s+(?:closed|lost)|websocket.*(?:closed|not open)|ECONNRESET|ECONNABORTED|EPIPE/i.test(message))
		throw error;
	return {
		ok: false,
		action,
		...context,
		reason: 'native_call_result_unknown',
		error: message,
		commitUnknown: true,
		readbackRequired: true,
		nativeCallSettled: false,
	};
}

interface WireState {
	id: string;
	net: string;
	line: unknown;
	segments: Segment[];
}

interface ComponentState {
	id: string;
	type: string;
	net: string;
	x: number;
	y: number;
	primitive: Record<string, unknown>;
}

interface WireNetLabel {
	id: string;
	parentWireId: string;
	net: string;
	x: number | null;
	y: number | null;
}

function requiredNumber(value: unknown, name: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value))
		throw new TypeError(`${name} must be a finite number.`);
	return value;
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== 'string' || value.trim().length === 0)
		throw new TypeError(`${name} must be a non-empty string.`);
	return value.trim();
}

async function currentSchematicPageUuid(eda: Record<string, unknown>): Promise<string> {
	const api = eda.dmt_Schematic;
	const editor = eda.dmt_SelectControl;
	if (!isPlainObjectRecord(api) || typeof api.getCurrentSchematicPageInfo !== 'function'
		|| !isPlainObjectRecord(editor) || typeof editor.getCurrentDocumentInfo !== 'function') {
		throw new TypeError('EDA current schematic page or editor document API is unavailable.');
	}
	const [page, document] = await Promise.all([api.getCurrentSchematicPageInfo(), editor.getCurrentDocumentInfo()]);
	if (!isPlainObjectRecord(page) || typeof page.uuid !== 'string' || !page.uuid.trim()
		|| !isPlainObjectRecord(document) || document.uuid !== page.uuid) {
		throw new Error('The active schematic page and editor document are not synchronized.');
	}
	return page.uuid.trim();
}

async function assertSameSchematicPage(eda: Record<string, unknown>, expected: string, operation = 'NetPort move'): Promise<void> {
	if (await currentSchematicPageUuid(eda) !== expected)
		throw new Error(`The active schematic page changed during the ${operation}.`);
}

function sameCoordinate(first: number, second: number): boolean {
	return Math.abs(first - second) <= COORDINATE_EPSILON;
}

function samePoint(first: Point, second: Point): boolean {
	return sameCoordinate(first.x, second.x) && sameCoordinate(first.y, second.y);
}

function segmentsFromFlatLine(line: unknown): Segment[] {
	if (!Array.isArray(line) || line.length < 4 || line.length % 2 !== 0 || line.some(value => typeof value !== 'number' || !Number.isFinite(value)))
		return [];
	const segments: Segment[] = [];
	for (let index = 0; index + 3 < line.length; index += 2) {
		const start = { x: line[index] as number, y: line[index + 1] as number };
		const end = { x: line[index + 2] as number, y: line[index + 3] as number };
		if (start.x !== end.x || start.y !== end.y)
			segments.push({ start, end });
	}
	return segments;
}

function segmentsFromWireLine(line: unknown): Segment[] {
	if (!Array.isArray(line))
		return [];
	if (Array.isArray(line[0])) {
		if (line.some(part => !Array.isArray(part) || part.length % 2 !== 0 || part.some(value => typeof value !== 'number' || !Number.isFinite(value))))
			return [];
		if (line.every(part => Array.isArray(part) && part.length === 2))
			return segmentsFromFlatLine(line.flat());
		return line.flatMap(part => segmentsFromFlatLine(part));
	}
	return segmentsFromFlatLine(line);
}

function readableWireLine(line: unknown): boolean {
	const flat = (path: unknown): boolean => Array.isArray(path) && path.length >= 4 && path.length % 2 === 0
		&& path.every(value => typeof value === 'number' && Number.isFinite(value));
	if (!Array.isArray(line) || line.length === 0)
		return false;
	if (!Array.isArray(line[0]))
		return flat(line);
	if (line.every(part => Array.isArray(part) && part.length === 2))
		return line.length >= 2 && line.every(part => part.every((value: unknown) => typeof value === 'number' && Number.isFinite(value)));
	return line.every(flat);
}

function orientation(a: Point, b: Point, c: Point): number {
	return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function orientationSign(a: Point, b: Point, c: Point): number {
	const cross = orientation(a, b, c);
	const tolerance = COORDINATE_EPSILON * Math.hypot(b.x - a.x, b.y - a.y);
	if (cross > tolerance)
		return 1;
	if (cross < -tolerance)
		return -1;
	return 0;
}

function pointOnSegment(point: Point, segment: Segment): boolean {
	return orientationSign(segment.start, segment.end, point) === 0
		&& point.x >= Math.min(segment.start.x, segment.end.x) - COORDINATE_EPSILON
		&& point.x <= Math.max(segment.start.x, segment.end.x) + COORDINATE_EPSILON
		&& point.y >= Math.min(segment.start.y, segment.end.y) - COORDINATE_EPSILON
		&& point.y <= Math.max(segment.start.y, segment.end.y) + COORDINATE_EPSILON;
}

function wireApi(eda: Record<string, unknown>): Record<string, unknown> {
	const api = eda.sch_PrimitiveWire;
	if (!isPlainObjectRecord(api) || typeof api.getAll !== 'function')
		throw new TypeError('EDA sch_PrimitiveWire.getAll API is unavailable.');
	return api;
}

async function readWires(api: Record<string, unknown>): Promise<WireState[]> {
	const result = await (api.getAll as () => Promise<unknown>).call(api);
	if (!Array.isArray(result))
		throw new TypeError('EDA sch_PrimitiveWire.getAll did not return an array.');
	return result.map((primitive: unknown) => {
		const line = getSyncState<unknown>(primitive, 'getState_Line', null);
		const id = String(getSyncState(primitive, 'getState_PrimitiveId', ''));
		if (!id)
			throw new TypeError('EDA wire has no primitive ID, so safe intersection checks are unavailable.');
		if (!readableWireLine(line))
			throw new TypeError(`EDA wire ${id} has no readable line geometry, so safe intersection checks are unavailable.`);
		// A native point wire has valid coordinates but contributes no contact segment.
		const segments = segmentsFromWireLine(line);
		return {
			id,
			net: String(getSyncState(primitive, 'getState_Net', '')),
			line,
			segments,
		};
	});
}

async function readWiresBeforeDeadline(api: Record<string, unknown>, deadline: number): Promise<WireState[] | null> {
	const remainingMs = deadline - Date.now();
	if (remainingMs <= 0)
		return null;
	let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;
	try {
		return await Promise.race([
			readWires(api),
			new Promise<null>((resolve) => {
				timeoutId = globalThis.setTimeout(() => resolve(null), remainingMs);
			}),
		]);
	}
	finally {
		if (timeoutId !== undefined)
			globalThis.clearTimeout(timeoutId);
	}
}

function componentApi(eda: Record<string, unknown>): Record<string, unknown> {
	const api = eda.sch_PrimitiveComponent;
	if (!isPlainObjectRecord(api) || typeof api.getAll !== 'function')
		throw new TypeError('EDA sch_PrimitiveComponent.getAll API is unavailable.');
	return api;
}

async function readComponents(api: Record<string, unknown>): Promise<ComponentState[]> {
	const components: ComponentState[] = [];
	for (const type of ['netport', 'netflag'] as const) {
		const result = await (api.getAll as (type: string, allPages: boolean) => Promise<unknown>).call(api, type, false);
		if (!Array.isArray(result))
			throw new TypeError(`EDA sch_PrimitiveComponent.getAll(${type}) did not return an array.`);
		for (const primitive of result) {
			if (!isPlainObjectRecord(primitive))
				throw new TypeError(`EDA ${type} has no readable state.`);
			const id = getSyncState<unknown>(primitive, 'getState_PrimitiveId', null);
			const net = getSyncState<unknown>(primitive, 'getState_Net', null);
			const x = getSyncState<unknown>(primitive, 'getState_X', null);
			const y = getSyncState<unknown>(primitive, 'getState_Y', null);
			if (typeof id !== 'string' || !id.trim() || typeof net !== 'string' || !net.trim()
				|| typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) {
				throw new TypeError(`EDA ${type} has incomplete ID, net, or coordinates; safe connection checks are unavailable.`);
			}
			components.push({ id, type, net, x, y, primitive });
		}
	}
	return components;
}

async function readWireNetLabels(eda: Record<string, unknown>): Promise<WireNetLabel[]> {
	const api = eda.sch_PrimitiveAttribute;
	if (!isPlainObjectRecord(api) || typeof api.getAll !== 'function')
		throw new TypeError('EDA sch_PrimitiveAttribute.getAll API is unavailable.');
	const result = await (api.getAll as () => Promise<unknown>).call(api);
	if (!Array.isArray(result))
		throw new TypeError('EDA sch_PrimitiveAttribute.getAll did not return an array.');
	// Pro stores wire labels as NET attributes. Their display coordinates can be
	// away from the wire, so use the parent ID for those labels.
	return result.filter(isPlainObjectRecord).filter(primitive => String(getSyncState(primitive, 'getState_Key', '')) === 'NET').map((primitive) => {
		const x = getSyncState<unknown>(primitive, 'getState_X', null);
		const y = getSyncState<unknown>(primitive, 'getState_Y', null);
		const net = getSyncState<unknown>(primitive, 'getState_Value', null);
		if (typeof net !== 'string')
			throw new TypeError('EDA NET attribute has no readable value, so safe connection checks are unavailable.');
		return {
			id: String(getSyncState(primitive, 'getState_PrimitiveId', '')),
			parentWireId: String(getSyncState(primitive, 'getState_ParentPrimitiveId', '')),
			net: net.trim(),
			x: typeof x === 'number' && Number.isFinite(x) ? x : null,
			y: typeof y === 'number' && Number.isFinite(y) ? y : null,
		};
	});
}

function unparentedLabels(labels: WireNetLabel[]): Array<WireNetLabel & Point> {
	return labels.filter((label): label is WireNetLabel & Point => !label.parentWireId && label.net.length > 0 && label.x !== null && label.y !== null);
}

function wireSnapshot(wire: WireState): string {
	return JSON.stringify({ line: wire.line, net: wire.net });
}

function allowedWireIds(value: unknown): Set<string> {
	if (value === undefined)
		return new Set();
	if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || id.trim().length === 0))
		throw new TypeError('allowedWireIds must be an array of non-empty primitive IDs.');
	return new Set(value.map(id => (id as string).trim()));
}

function segmentsConnect(first: Segment, second: Segment): boolean {
	return pointOnSegment(first.start, second)
		|| pointOnSegment(first.end, second)
		|| pointOnSegment(second.start, first)
		|| pointOnSegment(second.end, first);
}

function effectiveWireNets(wires: WireState[], components: ComponentState[], labels: WireNetLabel[]): Map<string, Set<string>> {
	const parent = wires.map((_, index) => index);
	const root = (index: number): number => {
		while (parent[index] !== index) {
			parent[index] = parent[parent[index]];
			index = parent[index];
		}
		return index;
	};
	for (let first = 0; first < wires.length; first++) {
		for (let second = first + 1; second < wires.length; second++) {
			if (wires[first].segments.some(a => wires[second].segments.some(b => segmentsConnect(a, b))))
				parent[root(second)] = root(first);
		}
	}
	const namesByRoot = new Map<number, Set<string>>();
	const addName = (index: number, name: string): void => {
		if (!name)
			return;
		const group = root(index);
		const names = namesByRoot.get(group) ?? new Set<string>();
		names.add(name);
		namesByRoot.set(group, names);
	};
	const labelsByWireId = new Map<string, Set<string>>();
	for (const label of labels) {
		if (!label.parentWireId)
			continue;
		const names = labelsByWireId.get(label.parentWireId) ?? new Set<string>();
		names.add(label.net);
		labelsByWireId.set(label.parentWireId, names);
	}
	for (const label of unparentedLabels(labels)) {
		for (const wire of wires) {
			if (!wire.segments.some(segment => pointOnSegment(label, segment)))
				continue;
			const names = labelsByWireId.get(wire.id) ?? new Set<string>();
			names.add(label.net);
			labelsByWireId.set(wire.id, names);
		}
	}
	const labeledGroups = new Set<number>();
	for (let index = 0; index < wires.length; index++) {
		const labelNames = labelsByWireId.get(wires[index].id);
		if (!labelNames)
			continue;
		labeledGroups.add(root(index));
		for (const name of labelNames)
			addName(index, name);
	}
	// A NET attribute names the entire connected group. The cached net getter
	// on another wire in that group can also lag behind an attribute change.
	for (let index = 0; index < wires.length; index++) {
		if (!labeledGroups.has(root(index)))
			addName(index, wires[index].net);
	}
	for (const component of components) {
		if ((component.type !== 'netport' && component.type !== 'netflag') || !component.net)
			continue;
		for (let index = 0; index < wires.length; index++) {
			if (wires[index].segments.some(segment => pointOnSegment({ x: component.x, y: component.y }, segment)))
				addName(index, component.net);
		}
	}
	return new Map(wires.map((wire, index) => [wire.id, namesByRoot.get(root(index)) ?? new Set<string>()]));
}

/** 返回实际共线段在请求段上的有效覆盖区间。 */
function requestedSegmentInterval(actual: Segment, requested: Segment): { start: number; end: number } | undefined {
	const horizontal = sameCoordinate(requested.start.y, requested.end.y);
	const axis = horizontal ? 'x' : 'y';
	const other = horizontal ? 'y' : 'x';
	if (!sameCoordinate(actual.start[other], requested.start[other]) || !sameCoordinate(actual.end[other], requested.start[other]))
		return undefined;
	const low = Math.min(requested.start[axis], requested.end[axis]);
	const high = Math.max(requested.start[axis], requested.end[axis]);
	const start = Math.max(low, Math.min(actual.start[axis], actual.end[axis]));
	const end = Math.min(high, Math.max(actual.start[axis], actual.end[axis]));
	return end - start > COORDINATE_EPSILON ? { start, end } : undefined;
}

function overlapsRequestedPath(wire: WireState, requested: Segment[]): boolean {
	return wire.segments.some(actual => requested.some(segment => requestedSegmentInterval(actual, segment) !== undefined));
}

function coveringWireIds(wires: WireState[], requested: Segment[]): string[] | undefined {
	const result = new Set<string>();
	for (const segment of requested) {
		const horizontal = sameCoordinate(segment.start.y, segment.end.y);
		const low = Math.min(horizontal ? segment.start.x : segment.start.y, horizontal ? segment.end.x : segment.end.y);
		const high = Math.max(horizontal ? segment.start.x : segment.start.y, horizontal ? segment.end.x : segment.end.y);
		const intervals = wires.flatMap(wire => wire.segments.flatMap((actual) => {
			const interval = requestedSegmentInterval(actual, segment);
			return interval ? [{ ...interval, id: wire.id }] : [];
		})).sort((a, b) => a.start - b.start);
		let covered = low;
		for (const interval of intervals) {
			if (interval.start > covered + COORDINATE_EPSILON)
				break;
			if (interval.end > covered) {
				covered = interval.end;
				result.add(interval.id);
			}
			if (covered >= high - COORDINATE_EPSILON)
				break;
		}
		if (covered < high - COORDINATE_EPSILON)
			return undefined;
	}
	return [...result];
}

async function handleWireAction(
	action: 'wire_preview' | 'wire_create',
	payload: Record<string, unknown>,
	eda: Record<string, unknown>,
	beforeNativeMutation?: () => void,
	nativeArgs?: unknown[],
): Promise<Record<string, unknown>> {
	const timeoutMs = action === 'wire_create'
		? resolveContractTimeoutMs(nativeArgs !== undefined ? '/bridge/jlceda/api/invoke' : '/bridge/jlceda/schematic/connectivity', payload)
		: 0;
	// raw API 允许 1 秒期限，结果余量不能占满整个任务；受控工具的 5 秒下限保持原余量。
	const readbackDeadline = action === 'wire_create' ? Date.now() + timeoutMs - Math.min(WIRE_RESULT_RESERVE_MS, timeoutMs / 5) : 0;
	const line = payload.line;
	const multiPath = nativeArgs !== undefined && Array.isArray(line) && Array.isArray(line[0]);
	const paths: unknown[] = multiPath ? line : [line];
	if (paths.reduce<number>((count, part) => count + (Array.isArray(part) ? part.length : 0), 0) > MAX_WIRE_LINE_COORDINATES)
		throw new RangeError(`line must contain at most ${MAX_WIRE_LINE_COORDINATES} coordinates.`);
	const normalizedPaths: number[][] = [];
	let segmentIndex = 0;
	for (const path of paths) {
		if (!Array.isArray(path) || path.length < (multiPath ? 2 : 4) || path.length % 2 !== 0
			|| path.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
			throw new TypeError('line must contain at least two distinct [x,y] points as a flat numeric array or connected native paths.');
		}
		const normalized = [...path] as number[];
		for (let index = 0; index + 3 < normalized.length; index += 2) {
			const start = { x: normalized[index], y: normalized[index + 1] };
			const end = { x: normalized[index + 2], y: normalized[index + 3] };
			const sameX = sameCoordinate(start.x, end.x);
			const sameY = sameCoordinate(start.y, end.y);
			if (sameX && sameY) {
				if (nativeArgs)
					continue;
				throw new TypeError(`line segment ${segmentIndex} is too short to create a wire.`);
			}
			if (!sameX && !sameY)
				return { ok: false, action, canCreate: false, reason: 'non_orthogonal_wire', requiresBend: true, segmentIndex, message: 'Add a bend point: SCH_PrimitiveWire.create only accepts horizontal and vertical wire segments.' };
			if (sameX)
				normalized[index + 2] = start.x;
			else
				normalized[index + 3] = start.y;
			segmentIndex++;
		}
		normalizedPaths.push(normalized);
	}
	const segments = normalizedPaths.flatMap(segmentsFromFlatLine);
	if (segments.length === 0)
		throw new TypeError('line must contain at least two distinct [x,y] points.');
	const normalizedLine = multiPath ? normalizedPaths : normalizedPaths[0];
	// 官方 Wire DTO 的 setState_Net 会大写网络名；raw 原生参数仍原样透传。
	const net = (nativeArgs
		? (payload.net === undefined || payload.net === null || payload.net === '' ? undefined : requiredString(payload.net, 'net'))
		: (payload.net === undefined ? undefined : requiredString(payload.net, 'net')))?.toUpperCase();
	const allowed = allowedWireIds(payload.allowedWireIds);
	const pageUuid = action === 'wire_create' ? await currentSchematicPageUuid(eda) : undefined;
	if (pageUuid && typeof payload.expectedSchematicWirePageUuid === 'string' && pageUuid !== payload.expectedSchematicWirePageUuid)
		throw new Error('The active schematic page changed before wire creation; no native write was started.');
	const api = wireApi(eda);
	const before = await readWires(api);
	const components = await readComponents(componentApi(eda));
	const labels = await readWireNetLabels(eda);
	const wireNets = effectiveWireNets(before, components, labels);
	const beforeById = new Map(before.map(wire => [wire.id, wireSnapshot(wire)]));
	const touched = before.filter(wire => wire.segments.some(existing => segments.some(proposed => segmentsConnect(existing, proposed))));
	const touchedPorts = components.filter(component => (component.type === 'netport' || component.type === 'netflag') && segments.some(segment => pointOnSegment({ x: component.x, y: component.y }, segment)));
	const touchedLabels = unparentedLabels(labels).filter(label => segments.some(segment => pointOnSegment(label, segment)));
	const conflictingNets = touched.filter(wire => net !== undefined && [...(wireNets.get(wire.id) ?? [])].some(name => name !== net));
	const conflictingPorts = touchedPorts.filter(component => net !== undefined && component.net.length > 0 && component.net !== net);
	const conflictingLabels = touchedLabels.filter(label => net !== undefined && label.net !== net);
	const touchedNetNames = new Set([...touched.flatMap(wire => [...(wireNets.get(wire.id) ?? [])]), ...touchedPorts.map(component => component.net), ...touchedLabels.map(label => label.net)].filter(name => name.length > 0));
	const unapproved = touched.filter(wire => !allowed.has(wire.id));
	const touches = touched.map(wire => ({ primitiveId: wire.id, net: wire.net, effectiveNets: [...(wireNets.get(wire.id) ?? [])], allowed: allowed.has(wire.id) }));
	const portTouches = touchedPorts.map(component => ({ primitiveId: component.id, net: component.net }));
	const labelTouches = touchedLabels.map(label => ({ primitiveId: label.id, net: label.net }));
	const canCreate = conflictingNets.length === 0 && conflictingPorts.length === 0 && conflictingLabels.length === 0 && touchedNetNames.size <= 1 && unapproved.length === 0;
	if (action === 'wire_preview' || !canCreate)
		return { ok: canCreate, action, canCreate, touches, portTouches, labelTouches, conflictingNetWireIds: conflictingNets.map(wire => wire.id), conflictingNetPortIds: conflictingPorts.map(component => component.id), conflictingNetLabelIds: conflictingLabels.map(label => label.id), mixedNamedNets: touchedNetNames.size > 1, unapprovedWireIds: unapproved.map(wire => wire.id) };
	if (typeof api.create !== 'function')
		throw new TypeError('EDA sch_PrimitiveWire.create API is unavailable.');
	const createArgs = nativeArgs ? [...nativeArgs] : [normalizedLine, net];
	createArgs[0] = normalizedLine;
	await assertSameSchematicPage(eda, pageUuid!, 'wire creation');
	beforeNativeMutation?.();
	let result: unknown;
	try {
		result = await (api.create as (...args: unknown[]) => Promise<unknown>).apply(api, createArgs);
	}
	catch (error: unknown) {
		return unknownNativeWrite('wire_create', error, { net: net ?? null, pageUuid });
	}
	try {
		const returnedPrimitiveId = String(getSyncState(result, 'getState_PrimitiveId', ''));
		let changedWireIds: string[] = [];
		let removedWireIds: string[] = [];
		let confirmedPrimitiveIds: string[] = [];
		const expectedNet = net ?? [...touchedNetNames][0];
		// 创建 ACK 可以早于图元可见。确认必须完整覆盖请求路径，且含本次有效变化；
		// 返回旧 ID 变化、或已有旧线覆盖，都不能单独证明创建完成。
		for (let attempt = 0; attempt < WIRE_READBACK_ATTEMPTS; attempt++) {
			if (attempt > 0) {
				if (readbackDeadline - Date.now() <= WIRE_READBACK_INTERVAL_MS)
					break;
				await new Promise<void>(resolve => globalThis.setTimeout(resolve, WIRE_READBACK_INTERVAL_MS));
			}
			const after = await readWiresBeforeDeadline(api, readbackDeadline);
			await assertSameSchematicPage(eda, pageUuid!, 'wire creation');
			if (!after)
				break;
			const afterIds = new Set(after.map(wire => wire.id));
			changedWireIds = after.filter(wire => beforeById.get(wire.id) !== wireSnapshot(wire)).map(wire => wire.id);
			removedWireIds = before.filter(wire => !afterIds.has(wire.id)).map(wire => wire.id);
			if (!coveringWireIds(after, segments) || !after.some(wire => changedWireIds.includes(wire.id) && overlapsRequestedPath(wire, segments)))
				continue;
			const [afterComponents, afterLabels] = await Promise.all([readComponents(componentApi(eda)), readWireNetLabels(eda)]);
			await assertSameSchematicPage(eda, pageUuid!, 'wire creation');
			const afterNets = effectiveWireNets(after, afterComponents, afterLabels);
			const candidates = after.filter(wire => expectedNet === undefined || (afterNets.get(wire.id)?.size === 1 && afterNets.get(wire.id)?.has(expectedNet)));
			const coveringIds = coveringWireIds(candidates, segments);
			const changedCoveringIds = candidates.filter(wire => changedWireIds.includes(wire.id) && overlapsRequestedPath(wire, segments)).map(wire => wire.id);
			const returnedWire = after.find(wire => wire.id === returnedPrimitiveId);
			if (!coveringIds || changedCoveringIds.length === 0
				|| (returnedWire && (!candidates.includes(returnedWire) || !overlapsRequestedPath(returnedWire, segments)))) {
				continue;
			}
			confirmedPrimitiveIds = [...new Set([...coveringIds, ...changedCoveringIds])];
			break;
		}
		const unexpectedChangedWireIds = changedWireIds.filter(id => beforeById.has(id) && !allowed.has(id));
		const unexpectedRemovedWireIds = removedWireIds.filter(id => !allowed.has(id));
		const committed = confirmedPrimitiveIds.length > 0;
		return {
			ok: committed && unexpectedChangedWireIds.length === 0 && unexpectedRemovedWireIds.length === 0,
			action,
			pageUuid,
			committed,
			commitUnknown: !committed || unexpectedChangedWireIds.length > 0 || unexpectedRemovedWireIds.length > 0,
			returnedPrimitiveId,
			confirmedPrimitiveId: committed ? (confirmedPrimitiveIds.includes(returnedPrimitiveId) ? returnedPrimitiveId : confirmedPrimitiveIds[0]) : null,
			confirmedPrimitiveIds: preserveBoundedArray(confirmedPrimitiveIds),
			returnedExistingWire: beforeById.has(returnedPrimitiveId),
			net: net ?? null,
			changedWireIds,
			removedWireIds,
			unexpectedChangedWireIds,
			unexpectedRemovedWireIds,
			touches,
			portTouches,
			labelTouches,
			readbackRequired: true,
			nativeCallSettled: true,
			...(nativeArgs ? { result: await toSerializableAsync(result) } : {}),
		};
	}
	catch (error: unknown) {
		return unknownCommitAfterReadback('wire_create', error, { returnedPrimitiveId: String(getSyncState(result, 'getState_PrimitiveId', '')), net: net ?? null, pageUuid });
	}
}

/** raw API 与受控工具共用接触预检和完整路径回读，保留五个原生参数。 */
export async function handleSchematicWireCreate(payload: Record<string, unknown>, nativeArgs: unknown[], beforeNativeMutation?: () => void): Promise<Record<string, unknown>> {
	const eda = getEdaRuntime();
	if (!eda)
		throw new TypeError('EDA runtime is unavailable.');
	return handleWireAction('wire_create', { ...payload, line: nativeArgs[0], net: nativeArgs[1] }, eda, beforeNativeMutation, nativeArgs);
}

async function handleNetPortMove(payload: Record<string, unknown>, eda: Record<string, unknown>): Promise<unknown> {
	const id = requiredString(payload.id, 'id');
	const x = requiredNumber(payload.x, 'x');
	const y = requiredNumber(payload.y, 'y');
	const target = { x, y };
	const pageUuid = await currentSchematicPageUuid(eda);
	const api = componentApi(eda);
	const components = await readComponents(api);
	await assertSameSchematicPage(eda, pageUuid);
	const current = components.find(component => component.id === id);
	if (!current)
		throw new Error(`Current schematic page does not contain primitive ${id}.`);
	if (current.type !== 'netport')
		throw new TypeError(`Primitive ${id} is ${current.type || 'unknown'}, not a NetPort.`);
	// Page identity needs the complete primitive inventory, not a second full
	// semantic netlist scan before the native move.
	const pageReadback = await handleSchematicReadTask({ includeConnectivityPrimitives: true, internalConnectivityOnly: true });
	if (!isPlainObjectRecord(pageReadback) || pageReadback.ok !== true || pageReadback.pageUuid !== pageUuid
		|| typeof pageReadback.connectivityPrimitivesSnapshot !== 'string') {
		throw new Error(`Cannot verify the NetPort's current page: ${isPlainObjectRecord(pageReadback) ? String(pageReadback.error ?? 'schematic_read failed') : 'schematic_read failed'}`);
	}
	const pagePrimitives: unknown = JSON.parse(pageReadback.connectivityPrimitivesSnapshot);
	const netPorts = isPlainObjectRecord(pagePrimitives) ? pagePrimitives.netPorts : undefined;
	const currentOnPage = Array.isArray(netPorts) ? netPorts.find(port => isPlainObjectRecord(port) && port.primitiveId === id) : undefined;
	if (!isPlainObjectRecord(currentOnPage) || currentOnPage.net !== current.net
		|| !samePoint({ x: Number(currentOnPage.x), y: Number(currentOnPage.y) }, current)) {
		throw new Error(`NetPort ${id} is not confirmed on the active schematic page.`);
	}
	await assertSameSchematicPage(eda, pageUuid);
	if (samePoint(current, target)) {
		const netlistReadback = await readTargetNetwork(current.net);
		await assertSameSchematicPage(eda, pageUuid);
		return { ok: netlistReadback.available, action: 'netport_move', pageUuid, id, net: current.net, from: { x: current.x, y: current.y }, to: target, unchanged: true, ...(!netlistReadback.available ? { reason: 'semantic_readback_unavailable' } : {}), netlistReadback, semanticScope: 'current_schematic_page_hierarchical_port' };
	}
	const otherPort = components.find(component => component.id !== id && (component.type === 'netport' || component.type === 'netflag') && samePoint(component, target) && component.net !== current.net);
	const wires = await readWires(wireApi(eda));
	await assertSameSchematicPage(eda, pageUuid);
	const labels = await readWireNetLabels(eda);
	await assertSameSchematicPage(eda, pageUuid);
	const wireNets = effectiveWireNets(wires, components, labels);
	const otherLabel = unparentedLabels(labels).find(label => samePoint(label, target) && label.net !== current.net);
	const foreignWire = wires.find(wire => [...(wireNets.get(wire.id) ?? [])].some(name => name !== current.net) && wire.segments.some(segment => pointOnSegment({ x, y }, segment)));
	if (otherPort || otherLabel || foreignWire)
		return { ok: false, action: 'netport_move', reason: 'target_net_conflict', id, target: { x, y }, conflictingPrimitiveIds: [otherPort?.id, otherLabel?.id, foreignWire?.id].filter(Boolean) };
	const primitive = typeof current.primitive.toAsync === 'function'
		? (current.primitive.toAsync as () => unknown).call(current.primitive)
		: current.primitive;
	if (!isPlainObjectRecord(primitive) || typeof primitive.setState_X !== 'function' || typeof primitive.setState_Y !== 'function' || typeof primitive.done !== 'function')
		throw new TypeError('EDA NetPort state setters or done API are unavailable.');
	await assertSameSchematicPage(eda, pageUuid);
	(primitive.setState_X as (value: number) => unknown).call(primitive, x);
	(primitive.setState_Y as (value: number) => unknown).call(primitive, y);
	try {
		await Promise.resolve((primitive.done as () => unknown).call(primitive));
	}
	catch (error: unknown) {
		return unknownNativeWrite('netport_move', error, { id, net: current.net, from: { x: current.x, y: current.y }, to: target });
	}
	try {
		await assertSameSchematicPage(eda, pageUuid);
		const observed = (await readComponents(api)).find(component => component.id === id);
		await assertSameSchematicPage(eda, pageUuid);
		const verified = Boolean(observed && samePoint(observed, target) && observed.net === current.net && observed.type === 'netport');
		const netlistReadback = await readTargetNetwork(current.net);
		await assertSameSchematicPage(eda, pageUuid);
		if (!netlistReadback.available)
			throw new Error(`Cannot verify the NetPort network after move: ${netlistReadback.error}`);
		return {
			ok: verified,
			action: 'netport_move',
			pageUuid,
			id,
			net: current.net,
			from: { x: current.x, y: current.y },
			to: { x, y },
			observed: observed ? { x: observed.x, y: observed.y, net: observed.net } : null,
			netlistReadback,
			commitUnknown: !verified,
			readbackRequired: true,
			semanticScope: 'current_schematic_page_hierarchical_port',
		};
	}
	catch (error: unknown) {
		return unknownCommitAfterReadback('netport_move', error, { id, net: current.net, from: { x: current.x, y: current.y }, to: target });
	}
}

async function readTargetNetwork(net: string): Promise<{ available: boolean; error?: string; found?: boolean; connectedPinRefs?: unknown[] }> {
	try {
		const response = await handleSchematicReadTask({});
		if (!isPlainObjectRecord(response) || response.ok !== true || typeof response.schematicCircuitSnapshot !== 'string')
			return { available: false, error: isPlainObjectRecord(response) ? String(response.error ?? 'schematic_read failed') : 'schematic_read failed' };
		const snapshot: unknown = JSON.parse(response.schematicCircuitSnapshot);
		if (!isPlainObjectRecord(snapshot) || !Array.isArray(snapshot.networks))
			return { available: false, error: 'schematic_read returned no network list' };
		const network = snapshot.networks.find(item => isPlainObjectRecord(item) && item.networkName === net);
		const connectedPinRefs = isPlainObjectRecord(network) && Array.isArray(network.connectedPinRefs) ? network.connectedPinRefs : [];
		return {
			available: true,
			found: Boolean(network),
			connectedPinRefs,
		};
	}
	catch (error: unknown) {
		return { available: false, error: error instanceof Error ? error.message : String(error) };
	}
}

async function handleNetPortCreate(payload: Record<string, unknown>, eda: Record<string, unknown>): Promise<unknown> {
	const net = requiredString(payload.net, 'net');
	const x = requiredNumber(payload.x, 'x');
	const y = requiredNumber(payload.y, 'y');
	const target = { x, y };
	const direction = payload.direction === undefined ? 'BI' : requiredString(payload.direction, 'direction');
	if (direction !== 'IN' && direction !== 'OUT' && direction !== 'BI')
		throw new TypeError('direction must be IN, OUT, or BI.');
	const api = componentApi(eda);
	if (typeof api.createNetPort !== 'function')
		throw new TypeError('EDA sch_PrimitiveComponent.createNetPort API is unavailable.');
	const before = await readComponents(api);
	const wires = await readWires(wireApi(eda));
	const labels = await readWireNetLabels(eda);
	const wireNets = effectiveWireNets(wires, before, labels);
	const otherPort = before.find(component => (component.type === 'netport' || component.type === 'netflag') && samePoint(component, target) && component.net !== net);
	const existingPort = before.find(component => component.type === 'netport' && samePoint(component, target) && component.net === net);
	const otherLabel = unparentedLabels(labels).find(label => samePoint(label, target) && label.net !== net);
	const foreignWire = wires.find(wire => [...(wireNets.get(wire.id) ?? [])].some(name => name !== net) && wire.segments.some(segment => pointOnSegment({ x, y }, segment)));
	if (otherPort || otherLabel || foreignWire)
		return { ok: false, action: 'netport_create', reason: 'target_net_conflict', target: { x, y }, conflictingPrimitiveIds: [otherPort?.id, otherLabel?.id, foreignWire?.id].filter(Boolean) };
	// The documented component API has no NetPort direction getter; position and net cannot prove a match.
	if (existingPort)
		return { ok: false, action: 'netport_create', reason: 'existing_port_direction_unverified', net, requestedDirection: direction, target: { x, y }, conflictingPrimitiveIds: [existingPort.id] };
	let created: unknown;
	try {
		created = await (api.createNetPort as (direction: 'IN' | 'OUT' | 'BI', net: string, x: number, y: number) => Promise<unknown>).call(api, direction, net, x, y);
	}
	catch (error: unknown) {
		return unknownNativeWrite('netport_create', error, { direction, net, position: target });
	}
	const returnedId = String(getSyncState(created, 'getState_PrimitiveId', ''));
	try {
		const beforeIds = new Set(before.map(component => component.id));
		const observed = (await readComponents(api)).find(component => !beforeIds.has(component.id) && component.type === 'netport' && component.net === net && samePoint(component, target) && (!returnedId || component.id === returnedId));
		const verified = Boolean(observed && observed.type === 'netport' && observed.net === net && samePoint(observed, target));
		const netlistReadback = await readTargetNetwork(net);
		return {
			ok: verified,
			action: 'netport_create',
			primitiveId: observed?.id || returnedId,
			direction,
			net,
			position: { x, y },
			primitiveVerified: verified,
			netlistReadback,
			commitUnknown: !verified,
			semanticScope: 'current_schematic_page_hierarchical_port',
		};
	}
	catch (error: unknown) {
		return unknownCommitAfterReadback('netport_create', error, { primitiveId: returnedId, direction, net, position: target });
	}
}

export async function handleSchematicConnectivityTask(payload: unknown, _reportPinAdapter?: (adapter: SchematicPinAdapter) => void, beforeNativeMutation?: () => void): Promise<unknown> {
	if (!isPlainObjectRecord(payload))
		throw new TypeError('schematic_connectivity_action payload must be an object.');
	const action = payload.action as ConnectivityAction;
	if (action !== 'wire_preview' && action !== 'wire_create' && action !== 'netport_create' && action !== 'netport_move')
		throw new TypeError('action must be wire_preview, wire_create, netport_create, or netport_move.');
	const eda = getEdaRuntime();
	if (!eda)
		throw new TypeError('EDA runtime is unavailable.');
	if (action === 'netport_move')
		return handleNetPortMove(payload, eda);
	if (action === 'netport_create')
		return handleNetPortCreate(payload, eda);
	return handleWireAction(action, payload, eda, beforeNativeMutation);
}
