import { getEdaRuntime, isPlainObjectRecord, preserveBoundedArray, toSafeErrorMessage } from '../utils.ts';
import { comparePcbPolygonSource } from './pcb-polygon-equivalence.ts';

type Action = 'read' | 'create' | 'modify' | 'delete';
type Kind = 'line' | 'arc' | 'polyline';
type PolygonSource = Array<'L' | 'ARC' | 'CARC' | 'C' | 'R' | 'CIRCLE' | number>;
type Primitive = Record<string, unknown> & { primitiveId: string; layer: number };

const PATH_SCOPE = 'current_pcb_page';
const BOARD_OUTLINE_LAYER = 11;
const API_NAME: Record<Kind, string> = {
	line: 'pcb_PrimitiveLine',
	arc: 'pcb_PrimitiveArc',
	polyline: 'pcb_PrimitivePolyline',
};
const FIELDS: Record<Kind, ReadonlySet<string>> = {
	line: new Set(['startX', 'startY', 'endX', 'endY', 'lineWidth', 'primitiveLock']),
	arc: new Set(['startX', 'startY', 'endX', 'endY', 'arcAngle', 'lineWidth', 'interactiveMode', 'primitiveLock']),
	polyline: new Set(['polygonSource', 'lineWidth', 'primitiveLock']),
};
const POLYGON_COMMANDS = new Set(['L', 'ARC', 'CARC', 'C', 'R', 'CIRCLE']);
const NATIVE_RESULT_UNKNOWN = /timed?\s*out|ETIMEDOUT|disconnect|connection\s+(?:closed|lost|reset|aborted)|socket\s+(?:closed|hang up)|transport\s+(?:closed|lost)|websocket.*(?:closed|not open)|ECONNRESET|ECONNABORTED|EPIPE/i;

function requiredId(value: unknown, field: string): string {
	if (typeof value !== 'string' || !value.trim())
		throw new TypeError(`${field} must be a non-empty string.`);
	return value.trim();
}

function numberValue(value: unknown, field: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value))
		throw new TypeError(`${field} must be a finite number.`);
	return value;
}

function polygonSource(value: unknown): PolygonSource {
	if (!Array.isArray(value) || value.length === 0 || value.some(item =>
		!(typeof item === 'number' && Number.isFinite(item))
		&& !(typeof item === 'string' && POLYGON_COMMANDS.has(item)))) {
		throw new TypeError('polygonSource must be a non-empty polygon source array.');
	}
	return preserveBoundedArray([...value] as PolygonSource);
}

function readState(raw: unknown, method: string): unknown {
	const getter = (raw as Record<string, unknown> | null)?.[method];
	if (typeof getter !== 'function')
		throw new TypeError(`EDA PCB board outline getter ${method} is unavailable.`);
	return getter.call(raw);
}

function api(runtime: Record<string, unknown>, name: string, methods: string[]): Record<string, unknown> {
	const value = runtime[name];
	if (!isPlainObjectRecord(value) || methods.some(method => typeof value[method] !== 'function'))
		throw new TypeError(`EDA ${name} ${methods.join('/')} API is unavailable. Open a PCB first.`);
	return value;
}

async function pageUuid(runtime: Record<string, unknown>): Promise<string> {
	const documentApi = api(runtime, 'dmt_Pcb', ['getCurrentPcbInfo']);
	const current = await (documentApi.getCurrentPcbInfo as () => Promise<unknown>).call(documentApi);
	if (!isPlainObjectRecord(current))
		throw new TypeError('EDA current PCB is unavailable.');
	return requiredId(current.uuid, 'EDA current PCB UUID');
}

async function assertSamePage(runtime: Record<string, unknown>, expected: string): Promise<void> {
	if (await pageUuid(runtime) !== expected)
		throw new Error('The active PCB changed during the board outline operation.');
}

function primitiveApi(runtime: Record<string, unknown>, kind: Kind, methods: string[]): Record<string, unknown> {
	return api(runtime, API_NAME[kind], methods);
}

function readPrimitive(kind: Kind, raw: unknown): Primitive {
	const common = {
		primitiveId: requiredId(readState(raw, 'getState_PrimitiveId'), 'EDA primitiveId'),
		net: readState(raw, 'getState_Net'),
		layer: numberValue(readState(raw, 'getState_Layer'), 'EDA layer'),
		lineWidth: numberValue(readState(raw, 'getState_LineWidth'), 'EDA lineWidth'),
		primitiveLock: readState(raw, 'getState_PrimitiveLock'),
	};
	if ((common.net !== null && typeof common.net !== 'string') || typeof common.primitiveLock !== 'boolean')
		throw new TypeError('EDA board outline net or lock state is invalid.');
	if (kind === 'polyline') {
		const polygon = readState(raw, 'getState_Polygon');
		return { ...common, polygonSource: polygonSource(readState(polygon, 'getSource')) };
	}
	const endpoints = {
		...common,
		startX: numberValue(readState(raw, 'getState_StartX'), 'EDA startX'),
		startY: numberValue(readState(raw, 'getState_StartY'), 'EDA startY'),
		endX: numberValue(readState(raw, 'getState_EndX'), 'EDA endX'),
		endY: numberValue(readState(raw, 'getState_EndY'), 'EDA endY'),
	};
	return kind === 'arc'
		? { ...endpoints, arcAngle: numberValue(readState(raw, 'getState_ArcAngle'), 'EDA arcAngle'), interactiveMode: numberValue(readState(raw, 'getState_InteractiveMode'), 'EDA interactiveMode') }
		: endpoints;
}

async function getOne(runtime: Record<string, unknown>, kind: Kind, id: string, expectedPage: string): Promise<Primitive | undefined> {
	const objectApi = primitiveApi(runtime, kind, ['get']);
	const raw = await (objectApi.get as (value: string) => Promise<unknown>).call(objectApi, id);
	await assertSamePage(runtime, expectedPage);
	if (raw == null)
		return undefined;
	let result: Primitive;
	try {
		result = readPrimitive(kind, raw);
	}
	catch (error: unknown) {
		// EDA may return an ID-only placeholder after deleting a primitive.
		if (!(await getAllPrimitiveIds(runtime, kind, expectedPage)).includes(id))
			return undefined;
		throw error;
	}
	return result.layer === BOARD_OUTLINE_LAYER ? result : undefined;
}

async function getAll(runtime: Record<string, unknown>, kind: Kind): Promise<Primitive[]> {
	const objectApi = primitiveApi(runtime, kind, ['getAll']);
	const raw = await (objectApi.getAll as (net?: string, layer?: number) => Promise<unknown>).call(objectApi, undefined, BOARD_OUTLINE_LAYER);
	if (!Array.isArray(raw))
		throw new TypeError(`EDA ${API_NAME[kind]}.getAll did not return an array.`);
	return preserveBoundedArray(raw.map(item => readPrimitive(kind, item)).filter(item => item.layer === BOARD_OUTLINE_LAYER));
}

async function getAllPrimitiveIds(runtime: Record<string, unknown>, kind: Kind, expectedPage: string): Promise<string[]> {
	const objectApi = primitiveApi(runtime, kind, ['getAll']);
	const raw = await (objectApi.getAll as () => Promise<unknown>).call(objectApi);
	if (!Array.isArray(raw))
		throw new TypeError(`EDA ${API_NAME[kind]}.getAll did not return an array.`);
	const ids = preserveBoundedArray(raw.map(item => requiredId(readState(item, 'getState_PrimitiveId'), 'EDA primitiveId')));
	await assertSamePage(runtime, expectedPage);
	return ids;
}

async function verifyBoardLayer(runtime: Record<string, unknown>): Promise<void> {
	const layerApi = api(runtime, 'pcb_Layer', ['getAllLayers']);
	const layers = await (layerApi.getAllLayers as () => Promise<unknown>).call(layerApi);
	if (!Array.isArray(layers))
		throw new TypeError('EDA pcb_Layer.getAllLayers did not return an array.');
	const board = layers.find(item => isPlainObjectRecord(item) && item.id === BOARD_OUTLINE_LAYER);
	if (!isPlainObjectRecord(board) || board.layerStatus === 0 || board.locked === true)
		throw new TypeError('PCB board outline layer 11 is unavailable, disabled, or locked.');
}

function validatedProperty(kind: Kind, value: unknown): Record<string, unknown> {
	if (!isPlainObjectRecord(value) || Object.keys(value).length === 0)
		throw new TypeError('property must be a non-empty object.');
	const result: Record<string, unknown> = {};
	for (const [field, item] of Object.entries(value)) {
		if (!FIELDS[kind].has(field))
			throw new TypeError(`Unsupported board outline ${kind} property: ${field}.`);
		if (field === 'polygonSource') {
			result[field] = polygonSource(item);
		}
		else if (field === 'primitiveLock') {
			if (typeof item !== 'boolean')
				throw new TypeError('primitiveLock must be a boolean.');
			result[field] = item;
		}
		else if (field === 'interactiveMode') {
			if (item !== 1 && item !== 2)
				throw new TypeError('interactiveMode must be 1 or 2.');
			result[field] = item;
		}
		else {
			const number = numberValue(item, field);
			if (field === 'lineWidth' && number <= 0)
				throw new RangeError('lineWidth must be positive.');
			result[field] = number;
		}
	}
	return result;
}

function createProperty(kind: Kind, payload: Record<string, unknown>): Record<string, unknown> {
	const fields = kind === 'polyline'
		? ['polygonSource', 'lineWidth', 'primitiveLock']
		: ['startX', 'startY', 'endX', 'endY', ...(kind === 'arc' ? ['arcAngle', 'interactiveMode'] : []), 'lineWidth', 'primitiveLock'];
	const property = validatedProperty(kind, Object.fromEntries(fields.filter(field => payload[field] !== undefined).map(field => [field, payload[field]])));
	const required = kind === 'polyline' ? ['polygonSource'] : ['startX', 'startY', 'endX', 'endY', ...(kind === 'arc' ? ['arcAngle'] : [])];
	for (const field of required) {
		if (property[field] === undefined)
			throw new TypeError(`${field} is required for board outline ${kind} creation.`);
	}
	return property;
}

function createPolygon(runtime: Record<string, unknown>, source: PolygonSource): unknown {
	const mathApi = api(runtime, 'pcb_MathPolygon', ['createPolygon']);
	const polygon = (mathApi.createPolygon as (value: PolygonSource) => unknown).call(mathApi, source);
	if (polygon == null)
		throw new TypeError('EDA pcb_MathPolygon.createPolygon rejected polygonSource.');
	return polygon;
}

function matchesRequested(actual: Primitive, requested: Record<string, unknown>): boolean {
	return Object.entries(requested).every(([field, wanted]) => {
		const observed = actual[field];
		if (field === 'polygonSource')
			return comparePcbPolygonSource(observed, wanted, 'polyline').equivalent;
		return typeof observed === 'number' && typeof wanted === 'number' ? Math.abs(observed - wanted) <= 1e-6 : observed === wanted;
	});
}

function polygonNormalization(actual: Primitive, requested: Record<string, unknown>): Record<string, unknown> {
	if (requested.polygonSource === undefined)
		return {};
	const comparison = comparePcbPolygonSource(actual.polygonSource, requested.polygonSource, 'polyline');
	if (!comparison.equivalent || !comparison.normalized)
		return {};
	const { equivalent: _equivalent, normalized: _normalized, ...diagnostic } = comparison;
	return { normalization: { field: 'polygonSource', ...diagnostic } };
}

function unknownWrite(action: Exclude<Action, 'read'>, error: unknown, context: Record<string, unknown>, nativeCallSettled: boolean): Record<string, unknown> {
	const message = toSafeErrorMessage(error);
	if (!nativeCallSettled && !NATIVE_RESULT_UNKNOWN.test(message))
		throw error;
	return { ok: false, action, scope: PATH_SCOPE, ...context, reason: nativeCallSettled ? 'post_write_readback_failed' : 'native_call_result_unknown', error: message, commitUnknown: true, readbackRequired: true, nativeCallSettled };
}

export async function handlePcbBoardOutlineManageTask(payload: unknown): Promise<unknown> {
	if (!isPlainObjectRecord(payload))
		throw new TypeError('pcb_board_outline_manage payload must be an object.');
	const action = payload.action as Action;
	if (action !== 'read' && action !== 'create' && action !== 'modify' && action !== 'delete')
		throw new TypeError('action must be read, create, modify, or delete.');
	const kind = payload.kind as Kind | undefined;
	if (kind !== undefined && kind !== 'line' && kind !== 'arc' && kind !== 'polyline')
		throw new TypeError('kind must be line, arc, or polyline.');
	if (action !== 'read' && kind === undefined)
		throw new TypeError('kind is required for a board outline write.');
	const primitiveId = action === 'modify' || action === 'delete' || payload.primitiveId !== undefined
		? requiredId(payload.primitiveId, 'primitiveId')
		: undefined;
	if (action === 'read' && (kind === undefined) !== (primitiveId === undefined))
		throw new TypeError('A targeted read requires both kind and primitiveId.');
	const requested = action === 'modify'
		? validatedProperty(kind!, payload.property)
		: action === 'create' ? createProperty(kind!, payload) : undefined;
	const runtime = getEdaRuntime();
	if (!runtime)
		throw new TypeError('EDA runtime is unavailable.');
	const currentPage = await pageUuid(runtime);
	if (action === 'read') {
		if (kind !== undefined) {
			const primitive = await getOne(runtime, kind, primitiveId!, currentPage);
			return { ok: true, action, scope: PATH_SCOPE, pageUuid: currentPage, kind, primitiveId, found: primitive !== undefined, primitive: primitive ?? null };
		}
		const [lines, arcs, polylines] = await Promise.all(['line', 'arc', 'polyline'].map(item => getAll(runtime, item as Kind)));
		await assertSamePage(runtime, currentPage);
		return { ok: true, action, scope: PATH_SCOPE, pageUuid: currentPage, complete: true, lineCount: lines.length, arcCount: arcs.length, polylineCount: polylines.length, lines, arcs, polylines };
	}
	const writeKind = kind!;
	const objectApi = primitiveApi(runtime, writeKind, [action, 'get', ...(action === 'create' ? ['getAll'] : [])]);
	const context: Record<string, unknown> = { pageUuid: currentPage, kind: writeKind, ...(primitiveId ? { primitiveId } : {}) };
	const before = primitiveId ? await getOne(runtime, writeKind, primitiveId, currentPage) : undefined;
	if (primitiveId && !before)
		throw new TypeError(`PCB board outline ${writeKind} ${primitiveId} does not exist on the current page.`);
	const beforeIds = action === 'create' ? await getAllPrimitiveIds(runtime, writeKind, currentPage) : undefined;
	if (beforeIds)
		context.beforePrimitiveIds = beforeIds;
	await verifyBoardLayer(runtime);
	const nativeProperty = requested === undefined ? undefined : { ...requested };
	if (nativeProperty?.polygonSource) {
		nativeProperty.polygon = createPolygon(runtime, nativeProperty.polygonSource as PolygonSource);
		delete nativeProperty.polygonSource;
	}
	await assertSamePage(runtime, currentPage);
	let nativeResult: unknown;
	try {
		if (action === 'create') {
			if (writeKind === 'line')
				nativeResult = await (objectApi.create as (...args: unknown[]) => Promise<unknown>).call(objectApi, '', BOARD_OUTLINE_LAYER, requested!.startX, requested!.startY, requested!.endX, requested!.endY, requested!.lineWidth, requested!.primitiveLock);
			else if (writeKind === 'arc')
				nativeResult = await (objectApi.create as (...args: unknown[]) => Promise<unknown>).call(objectApi, '', BOARD_OUTLINE_LAYER, requested!.startX, requested!.startY, requested!.endX, requested!.endY, requested!.arcAngle, requested!.lineWidth, requested!.interactiveMode, requested!.primitiveLock);
			else
				nativeResult = await (objectApi.create as (...args: unknown[]) => Promise<unknown>).call(objectApi, '', BOARD_OUTLINE_LAYER, nativeProperty!.polygon, requested!.lineWidth, requested!.primitiveLock);
		}
		else if (action === 'modify') {
			nativeResult = await (objectApi.modify as (...args: unknown[]) => Promise<unknown>).call(objectApi, primitiveId, nativeProperty);
		}
		else {
			nativeResult = await (objectApi.delete as (...args: unknown[]) => Promise<unknown>).call(objectApi, primitiveId);
		}
	}
	catch (error: unknown) {
		return unknownWrite(action, error, context, false);
	}
	try {
		await assertSamePage(runtime, currentPage);
		if (action === 'create') {
			const afterIds = await getAllPrimitiveIds(runtime, writeKind, currentPage);
			const addedIds = afterIds.filter(id => !beforeIds!.includes(id));
			if (addedIds.length === 0) {
				return { ok: false, action, scope: PATH_SCOPE, ...context, reason: 'native_create_no_effect', applied: false, verified: false, nativeCallSettled: true };
			}
			const all = await getAll(runtime, writeKind);
			await assertSamePage(runtime, currentPage);
			const added = all.filter(item => addedIds.includes(item.primitiveId));
			const returnedId = nativeResult == null || nativeResult === false ? undefined : requiredId(readState(nativeResult, 'getState_PrimitiveId'), 'EDA created primitiveId');
			const created = returnedId ? added.find(item => item.primitiveId === returnedId) : added.length === 1 ? added[0] : undefined;
			if (!created || addedIds.length !== 1 || added.length !== 1)
				throw new Error('EDA did not read back exactly one matching new board outline primitive.');
			const requestedMismatches = Object.entries(requested!).filter(([field, expected]) =>
				!matchesRequested(created, { [field]: expected })).map(([field, expected]) => {
				const actual = created[field];
				return { field, expected, actual: Array.isArray(actual) ? preserveBoundedArray([...actual]) : actual };
			});
			if (created.net !== '' && created.net !== null)
				requestedMismatches.push({ field: 'net', expected: '', actual: created.net });
			if (requestedMismatches.length) {
				return {
					ok: false,
					action,
					scope: PATH_SCOPE,
					pageUuid: currentPage,
					kind: writeKind,
					primitiveId: created.primitiveId,
					reason: 'create_readback_mismatch',
					applied: true,
					verified: false,
					before: null,
					after: created,
					requestedMismatches,
				};
			}
			return { ok: true, action, scope: PATH_SCOPE, pageUuid: currentPage, kind: writeKind, primitiveId: created.primitiveId, primitive: created, verified: true, ...polygonNormalization(created, requested!) };
		}
		if (action === 'delete') {
			const ids = await getAllPrimitiveIds(runtime, writeKind, currentPage);
			if (nativeResult === false || ids.includes(primitiveId!))
				throw new Error('EDA board outline primitive still exists after delete.');
			return { ok: true, action, scope: PATH_SCOPE, pageUuid: currentPage, kind: writeKind, primitiveId, deleted: true, verified: true };
		}
		const observed = await getOne(runtime, writeKind, primitiveId!, currentPage);
		if (!observed || !matchesRequested(observed, requested!))
			throw new Error('EDA board outline readback differs from the requested properties.');
		return { ok: true, action, scope: PATH_SCOPE, pageUuid: currentPage, kind: writeKind, primitiveId, primitive: observed, verified: true, ...polygonNormalization(observed, requested!) };
	}
	catch (error: unknown) {
		return unknownWrite(action, error, context, true);
	}
}
