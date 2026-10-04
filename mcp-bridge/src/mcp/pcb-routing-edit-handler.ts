import { getEdaRuntime, getSyncState, isPlainObjectRecord, preserveBoundedArray, toSafeErrorMessage } from '../utils.ts';
import { pcbViaDimensionMode, pcbViaDimensionNormalization } from './pcb-native-normalization.ts';

type Action = 'read' | 'create' | 'modify' | 'delete';
type Kind = 'line' | 'arc' | 'polyline' | 'via';
type PolygonSource = Array<'L' | 'ARC' | 'CARC' | 'C' | 'R' | 'CIRCLE' | number>;
type Primitive = Record<string, unknown> & { primitiveId: string; net: string; primitiveLock: boolean };

const SCOPE = 'current_pcb_page';
const NATIVE_RESULT_UNKNOWN = /timed?\s*out|ETIMEDOUT|disconnect|connection\s+(?:closed|lost|reset|aborted)|socket\s+(?:closed|hang up)|transport\s+(?:closed|lost)|websocket.*(?:closed|not open)|ECONNRESET|ECONNABORTED|EPIPE/i;
const POLYGON_COMMANDS = new Set(['L', 'ARC', 'CARC', 'C', 'R', 'CIRCLE']);
const API_NAME: Record<Kind, string> = {
	line: 'pcb_PrimitiveLine',
	arc: 'pcb_PrimitiveArc',
	polyline: 'pcb_PrimitivePolyline',
	via: 'pcb_PrimitiveVia',
};
const FIELDS: Record<Kind, ReadonlySet<string>> = {
	line: new Set(['net', 'layer', 'startX', 'startY', 'endX', 'endY', 'lineWidth', 'primitiveLock']),
	arc: new Set(['net', 'layer', 'startX', 'startY', 'endX', 'endY', 'arcAngle', 'lineWidth', 'interactiveMode', 'primitiveLock']),
	polyline: new Set(['net', 'layer', 'polygonSource', 'lineWidth', 'primitiveLock']),
	via: new Set(['net', 'x', 'y', 'holeDiameter', 'diameter', 'primitiveLock']),
};

function requiredId(value: unknown, field: string): string {
	if (typeof value !== 'string' || !value.trim())
		throw new TypeError(`${field} must be a non-empty string.`);
	return value.trim();
}

function stringValue(value: unknown, field: string): string {
	if (typeof value !== 'string')
		throw new TypeError(`${field} must be a string.`);
	return value;
}

function finiteNumber(value: unknown, field: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value))
		throw new TypeError(`${field} must be a finite number.`);
	return value;
}

function positiveNumber(value: unknown, field: string): number {
	const number = finiteNumber(value, field);
	if (number <= 0)
		throw new RangeError(`${field} must be positive.`);
	return number;
}

function copperLayer(value: unknown): number {
	const layer = finiteNumber(value, 'layer');
	if (!isCopperLayer(layer))
		throw new TypeError('layer must be a copper layer ID (1, 2, or 15 through 44).');
	return layer;
}

function isCopperLayer(layer: number): boolean {
	return Number.isInteger(layer) && (layer === 1 || layer === 2 || (layer >= 15 && layer <= 44));
}

function booleanValue(value: unknown, field: string): boolean {
	if (typeof value !== 'boolean')
		throw new TypeError(`${field} must be a boolean.`);
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

function readState(primitive: unknown, method: string): unknown {
	const getter = (primitive as Record<string, unknown> | null)?.[method];
	if (typeof getter !== 'function')
		throw new TypeError(`EDA PCB routing getter ${method} is unavailable.`);
	return getter.call(primitive);
}

function readPrimitive(kind: Kind, raw: unknown): Primitive {
	const base = {
		primitiveId: requiredId(readState(raw, 'getState_PrimitiveId'), 'EDA primitiveId'),
		net: stringValue(readState(raw, 'getState_Net'), 'EDA net'),
		primitiveLock: booleanValue(readState(raw, 'getState_PrimitiveLock'), 'EDA primitiveLock'),
	};
	if (kind === 'via') {
		return {
			...base,
			x: finiteNumber(readState(raw, 'getState_X'), 'EDA via x'),
			y: finiteNumber(readState(raw, 'getState_Y'), 'EDA via y'),
			holeDiameter: finiteNumber(readState(raw, 'getState_HoleDiameter'), 'EDA via holeDiameter'),
			diameter: finiteNumber(readState(raw, 'getState_Diameter'), 'EDA via diameter'),
			viaType: finiteNumber(readState(raw, 'getState_ViaType'), 'EDA via viaType'),
		};
	}
	const common = {
		...base,
		layer: finiteNumber(readState(raw, 'getState_Layer'), 'EDA layer'),
		lineWidth: finiteNumber(readState(raw, 'getState_LineWidth'), 'EDA lineWidth'),
	};
	if (kind === 'polyline') {
		const polygon = readState(raw, 'getState_Polygon');
		return { ...common, polygonSource: polygonSource(readState(polygon, 'getSource')) };
	}
	const endpoints = {
		...common,
		startX: finiteNumber(readState(raw, 'getState_StartX'), 'EDA startX'),
		startY: finiteNumber(readState(raw, 'getState_StartY'), 'EDA startY'),
		endX: finiteNumber(readState(raw, 'getState_EndX'), 'EDA endX'),
		endY: finiteNumber(readState(raw, 'getState_EndY'), 'EDA endY'),
	};
	return kind === 'arc'
		? {
				...endpoints,
				arcAngle: finiteNumber(readState(raw, 'getState_ArcAngle'), 'EDA arcAngle'),
				interactiveMode: finiteNumber(readState(raw, 'getState_InteractiveMode'), 'EDA interactiveMode'),
			}
		: endpoints;
}

function api(runtime: Record<string, unknown>, name: string, methods: string[]): Record<string, unknown> {
	const value = runtime[name];
	if (!isPlainObjectRecord(value) || methods.some(method => typeof value[method] !== 'function'))
		throw new TypeError(`EDA ${name} ${methods.join('/')} API is unavailable. Open a PCB first.`);
	return value;
}

async function currentPageUuid(runtime: Record<string, unknown>): Promise<string> {
	const pageApi = api(runtime, 'dmt_Pcb', ['getCurrentPcbInfo']);
	const page = await (pageApi.getCurrentPcbInfo as () => Promise<unknown>).call(pageApi);
	if (!isPlainObjectRecord(page))
		throw new TypeError('EDA current PCB is unavailable.');
	return requiredId(page.uuid, 'EDA current PCB UUID');
}

async function assertSamePage(runtime: Record<string, unknown>, expected: string): Promise<void> {
	if (await currentPageUuid(runtime) !== expected)
		throw new Error('The active PCB changed during the routing operation.');
}

function routingApi(runtime: Record<string, unknown>, kind: Kind, methods: string[]): Record<string, unknown> {
	return api(runtime, API_NAME[kind], methods);
}

async function getOne(runtime: Record<string, unknown>, kind: Kind, primitiveId: string, pageUuid: string): Promise<Primitive | undefined> {
	const primitiveApi = routingApi(runtime, kind, ['get']);
	let raw = await (primitiveApi.get as (id: string) => Promise<unknown>).call(primitiveApi, primitiveId);
	await assertSamePage(runtime, pageUuid);
	if (raw == null)
		return undefined;
	// After deletion, native get(id) can return an ID-only stale object. Confirm
	// it still belongs to the current page before reading geometry from it.
	const geometryGetter = kind === 'via' ? 'getState_X' : 'getState_Layer';
	if (typeof (raw as Record<string, unknown>)[geometryGetter] !== 'function') {
		const allApi = routingApi(runtime, kind, ['getAll']);
		const all = await (allApi.getAll as () => Promise<unknown>).call(allApi);
		if (!Array.isArray(all))
			throw new TypeError(`EDA ${API_NAME[kind]}.getAll did not return an array.`);
		await assertSamePage(runtime, pageUuid);
		raw = all.find(item => readState(item, 'getState_PrimitiveId') === primitiveId);
		if (!raw)
			return undefined;
	}
	if (kind !== 'via' && !isCopperLayer(finiteNumber(readState(raw, 'getState_Layer'), 'EDA layer')))
		return undefined;
	return readPrimitive(kind, raw);
}

async function getAll(runtime: Record<string, unknown>, kind: Kind): Promise<Primitive[]> {
	const primitiveApi = routingApi(runtime, kind, ['getAll']);
	const raw = await (primitiveApi.getAll as () => Promise<unknown>).call(primitiveApi);
	if (!Array.isArray(raw))
		throw new TypeError(`EDA ${API_NAME[kind]}.getAll did not return an array.`);
	// getAll also returns board outline and silkscreen shapes. Their net can be null;
	// classify the layer before requiring the net of an actual copper route.
	return preserveBoundedArray(raw.filter(item => kind === 'via'
		|| isCopperLayer(finiteNumber(readState(item, 'getState_Layer'), 'EDA layer')))
		.map(item => readPrimitive(kind, item)));
}

async function getAllPrimitiveIds(runtime: Record<string, unknown>, kind: Kind, pageUuid: string): Promise<string[]> {
	const primitiveApi = routingApi(runtime, kind, ['getAll']);
	const raw = await (primitiveApi.getAll as () => Promise<unknown>).call(primitiveApi);
	if (!Array.isArray(raw))
		throw new TypeError(`EDA ${API_NAME[kind]}.getAll did not return an array.`);
	const ids = preserveBoundedArray(raw.map(item => requiredId(readState(item, 'getState_PrimitiveId'), 'EDA primitiveId')));
	await assertSamePage(runtime, pageUuid);
	return ids;
}

interface ViaOwnership {
	ownership: 'footprint_child' | 'unknown';
	parentComponentPrimitiveId?: string;
}

async function readViaOwnership(runtime: Record<string, unknown>, via: Primitive, pageUuid: string): Promise<ViaOwnership> {
	const netApi = runtime.pcb_Net;
	if (!isPlainObjectRecord(netApi) || typeof netApi.getAllPrimitivesByNet !== 'function')
		return { ownership: 'unknown' };
	const raw = await (netApi.getAllPrimitivesByNet as (net: string) => Promise<unknown>).call(netApi, via.net);
	await assertSamePage(runtime, pageUuid);
	if (!Array.isArray(raw))
		throw new TypeError('EDA pcb_Net.getAllPrimitivesByNet did not return an array.');
	// 网络接口若保留了原生 parentId，可识别已知父图元；缺失父字段不证明独立归属。
	const target = raw.find(item => isPlainObjectRecord(item)
		&& (item.globalIndex ?? getSyncState(item, 'getState_PrimitiveId', item.primitiveId)) === via.primitiveId);
	if (!isPlainObjectRecord(target))
		return { ownership: 'unknown' };
	const parentId = target.parentId ?? target.parentComponentPrimitiveId;
	return typeof parentId === 'string' && parentId.length > 0
		? { ownership: 'footprint_child', parentComponentPrimitiveId: parentId }
		: { ownership: 'unknown' };
}

async function verifyNet(runtime: Record<string, unknown>, net: string): Promise<void> {
	const netApi = api(runtime, 'pcb_Net', ['getAllNets']);
	const nets = await (netApi.getAllNets as () => Promise<unknown>).call(netApi);
	if (!Array.isArray(nets))
		throw new TypeError('EDA pcb_Net.getAllNets did not return an array.');
	if (!nets.some(item => isPlainObjectRecord(item) && item.net === net))
		throw new TypeError(`PCB network ${net} does not exist on the current page.`);
}

async function verifyCopperLayer(runtime: Record<string, unknown>, layer: number): Promise<void> {
	const layerApi = api(runtime, 'pcb_Layer', ['getAllLayers']);
	const layers = await (layerApi.getAllLayers as () => Promise<unknown>).call(layerApi);
	if (!Array.isArray(layers))
		throw new TypeError('EDA pcb_Layer.getAllLayers did not return an array.');
	const selected = layers.find(item => isPlainObjectRecord(item) && item.id === layer);
	if (!isPlainObjectRecord(selected) || (selected.type !== 'SIGNAL' && selected.type !== 'PLANE') || selected.layerStatus === 0 || selected.locked === true)
		throw new TypeError(`PCB layer ${String(layer)} is not an enabled, unlocked copper layer.`);
}

function validatedProperty(kind: Kind, value: unknown): Record<string, unknown> {
	if (!isPlainObjectRecord(value) || Object.keys(value).length === 0)
		throw new TypeError('property must be a non-empty object.');
	const property: Record<string, unknown> = {};
	for (const [field, item] of Object.entries(value)) {
		if (!FIELDS[kind].has(field))
			throw new TypeError(`Unsupported PCB ${kind} property: ${field}.`);
		switch (field) {
			case 'net':
				property.net = requiredId(item, 'net');
				break;
			case 'layer':
				property.layer = copperLayer(item);
				break;
			case 'polygonSource':
				property.polygonSource = polygonSource(item);
				break;
			case 'lineWidth':
			case 'holeDiameter':
			case 'diameter':
				property[field] = positiveNumber(item, field);
				break;
			case 'interactiveMode':
				if (item !== 1 && item !== 2)
					throw new TypeError('interactiveMode must be 1 or 2.');
				property.interactiveMode = item;
				break;
			case 'primitiveLock':
				property.primitiveLock = booleanValue(item, field);
				break;
			default: property[field] = finiteNumber(item, field);
		}
	}
	return property;
}

function createProperty(kind: Kind, payload: Record<string, unknown>): Record<string, unknown> {
	const fields = kind === 'arc'
		? ['net', 'layer', 'startX', 'startY', 'endX', 'endY', 'arcAngle', 'lineWidth', 'interactiveMode', 'primitiveLock']
		: ['net', 'layer', 'polygonSource', 'lineWidth', 'primitiveLock'];
	const raw = Object.fromEntries(fields.filter(field => payload[field] !== undefined).map(field => [field, payload[field]]));
	const property = validatedProperty(kind, raw);
	for (const field of kind === 'arc' ? ['net', 'layer', 'startX', 'startY', 'endX', 'endY', 'arcAngle'] : ['net', 'layer', 'polygonSource']) {
		if (property[field] === undefined)
			throw new TypeError(`${field} is required for PCB ${kind} creation.`);
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
		if ((field === 'holeDiameter' || field === 'diameter') && typeof wanted === 'number')
			return pcbViaDimensionMode(observed, wanted) !== undefined;
		if (field === 'polygonSource') {
			const source = observed as PolygonSource;
			return Array.isArray(source) && source.length === (wanted as PolygonSource).length
				&& source.every((item, index) => typeof item === 'number' && typeof (wanted as PolygonSource)[index] === 'number'
					? Math.abs(item - ((wanted as PolygonSource)[index] as number)) <= 1e-6
					: item === (wanted as PolygonSource)[index]);
		}
		return typeof observed === 'number' && typeof wanted === 'number'
			? Math.abs(observed - wanted) <= 1e-6
			: observed === wanted;
	});
}

function requestedMismatches(actual: Primitive, requested: Record<string, unknown>): Array<Record<string, unknown>> {
	return preserveBoundedArray(Object.entries(requested)
		.filter(([field, wanted]) => !matchesRequested(actual, { [field]: wanted }))
		.map(([field, wanted]) => ({
			field,
			requested: Array.isArray(wanted) ? preserveBoundedArray([...wanted]) : wanted,
			actual: Array.isArray(actual[field]) ? preserveBoundedArray([...(actual[field] as unknown[])]) : actual[field],
		})));
}

function unknownNativeWrite(action: Exclude<Action, 'read'>, error: unknown, context: Record<string, unknown>): Record<string, unknown> {
	const message = toSafeErrorMessage(error);
	if (!NATIVE_RESULT_UNKNOWN.test(message))
		throw error;
	return { ok: false, action, scope: SCOPE, ...context, reason: 'native_call_result_unknown', error: message, commitUnknown: true, readbackRequired: true, nativeCallSettled: false };
}

function unknownAfterWrite(action: Exclude<Action, 'read'>, error: unknown, context: Record<string, unknown>): Record<string, unknown> {
	return { ok: false, action, scope: SCOPE, ...context, reason: 'post_write_readback_failed', error: toSafeErrorMessage(error), commitUnknown: true, readbackRequired: true, nativeCallSettled: true };
}

export async function handlePcbRoutingEditTask(payload: unknown): Promise<unknown> {
	if (!isPlainObjectRecord(payload))
		throw new TypeError('pcb_routing_edit payload must be an object.');
	const action = payload.action as Action;
	if (action !== 'read' && action !== 'create' && action !== 'modify' && action !== 'delete')
		throw new TypeError('action must be read, create, modify, or delete.');
	const kind = payload.kind as Kind | undefined;
	if (kind !== undefined && kind !== 'line' && kind !== 'arc' && kind !== 'polyline' && kind !== 'via')
		throw new TypeError('kind must be line, arc, polyline, or via.');
	if (action !== 'read' && kind === undefined)
		throw new TypeError('kind is required for a PCB routing write.');
	if (action === 'create' && kind !== 'arc' && kind !== 'polyline')
		throw new TypeError('Create supports arc and polyline; use pcb_connectivity_action for line and via creation.');
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
	const pageUuid = await currentPageUuid(runtime);
	if (action === 'read') {
		if (kind !== undefined) {
			const primitive = await getOne(runtime, kind, primitiveId!, pageUuid);
			return { ok: true, action, scope: SCOPE, pageUuid, kind, primitiveId, found: primitive !== undefined, primitive: primitive ?? null, ...(primitive === undefined ? { reason: 'not_found' } : {}) };
		}
		const [lines, arcs, polylines, vias] = await Promise.all([
			getAll(runtime, 'line'),
			getAll(runtime, 'arc'),
			getAll(runtime, 'polyline'),
			getAll(runtime, 'via'),
		]);
		await assertSamePage(runtime, pageUuid);
		return { ok: true, action, scope: SCOPE, complete: true, pageUuid, lineCount: lines.length, arcCount: arcs.length, polylineCount: polylines.length, viaCount: vias.length, lines, arcs, polylines, vias };
	}
	const writableKind = kind!;
	const primitiveApi = routingApi(runtime, writableKind, [action, 'get', ...(action === 'create' ? ['getAll'] : [])]);
	const context: Record<string, unknown> = { pageUuid, kind: writableKind, ...(primitiveId ? { primitiveId } : {}) };
	const before = primitiveId ? await getOne(runtime, writableKind, primitiveId, pageUuid) : undefined;
	if (primitiveId && !before)
		throw new TypeError(`PCB ${writableKind} ${primitiveId} does not exist on the current page.`);
	const viaOwnership = action === 'delete' && writableKind === 'via'
		? await readViaOwnership(runtime, before!, pageUuid)
		: undefined;
	if (viaOwnership?.ownership === 'footprint_child') {
		return {
			ok: false,
			action,
			scope: SCOPE,
			...context,
			...viaOwnership,
			before,
			reason: 'footprint_owned_via',
			error: 'This via belongs to a placed footprint. Edit its footprint/component; routing deletion cannot confirm persistent removal of a footprint child.',
			applied: false,
			deleted: false,
			verified: false,
		};
	}
	const beforeIds = action === 'create'
		? preserveBoundedArray((await getAll(runtime, writableKind)).map(item => item.primitiveId))
		: undefined;
	if (beforeIds)
		context.beforePrimitiveIds = beforeIds;
	if (requested?.net !== undefined)
		await verifyNet(runtime, requested.net as string);
	if (writableKind !== 'via')
		await verifyCopperLayer(runtime, (requested?.layer ?? before?.layer) as number);
	if (writableKind === 'via' && requested && (requested.holeDiameter !== undefined || requested.diameter !== undefined)) {
		const hole = (requested.holeDiameter ?? before?.holeDiameter) as number;
		const diameter = (requested.diameter ?? before?.diameter) as number;
		if (diameter <= hole)
			throw new RangeError('diameter must be larger than holeDiameter.');
	}
	const nativeProperty = requested === undefined ? undefined : { ...requested };
	if (nativeProperty?.polygonSource) {
		nativeProperty.polygon = createPolygon(runtime, nativeProperty.polygonSource as PolygonSource);
		delete nativeProperty.polygonSource;
	}
	await assertSamePage(runtime, pageUuid);
	let nativeResult: unknown;
	try {
		if (action === 'create') {
			if (writableKind === 'arc') {
				nativeResult = await (primitiveApi.create as (...args: unknown[]) => Promise<unknown>).call(primitiveApi, requested!.net, requested!.layer, requested!.startX, requested!.startY, requested!.endX, requested!.endY, requested!.arcAngle, requested!.lineWidth, requested!.interactiveMode, requested!.primitiveLock);
			}
			else {
				nativeResult = await (primitiveApi.create as (...args: unknown[]) => Promise<unknown>).call(primitiveApi, requested!.net, requested!.layer, nativeProperty!.polygon, requested!.lineWidth, requested!.primitiveLock);
			}
		}
		else if (action === 'modify') {
			nativeResult = await (primitiveApi.modify as (...args: unknown[]) => Promise<unknown>).call(primitiveApi, primitiveId, nativeProperty);
		}
		else {
			nativeResult = await (primitiveApi.delete as (...args: unknown[]) => Promise<unknown>).call(primitiveApi, primitiveId);
		}
	}
	catch (error: unknown) {
		return unknownNativeWrite(action, error, context);
	}
	try {
		await assertSamePage(runtime, pageUuid);
		if (action === 'create') {
			const all = await getAll(runtime, writableKind);
			await assertSamePage(runtime, pageUuid);
			const added = all.filter(item => !beforeIds!.includes(item.primitiveId));
			const returnedId = nativeResult == null ? undefined : requiredId(readState(nativeResult, 'getState_PrimitiveId'), 'EDA created primitiveId');
			const created = returnedId ? added.find(item => item.primitiveId === returnedId) : added.length === 1 ? added[0] : undefined;
			if (!created || added.length !== 1 || !matchesRequested(created, requested!))
				throw new Error('EDA did not read back exactly one matching new routing primitive.');
			return { ok: true, action, scope: SCOPE, pageUuid, kind: writableKind, primitiveId: created.primitiveId, primitive: created, verified: true };
		}
		if (action === 'delete') {
			const ids = await getAllPrimitiveIds(runtime, writableKind, pageUuid);
			if (nativeResult === false || ids.includes(primitiveId!))
				throw new Error('EDA routing primitive still exists after delete.');
			return {
				ok: true,
				action,
				scope: SCOPE,
				pageUuid,
				kind: writableKind,
				primitiveId,
				deleted: true,
				verified: true,
				...(writableKind === 'via'
					? {
							...viaOwnership,
							verificationScope: 'current_page_memory',
							durableDeletionVerified: false,
							requiredPersistenceVerification: 'save_and_reopen_pcb',
						}
					: {}),
			};
		}
		const observed = await getOne(runtime, writableKind, primitiveId!, pageUuid);
		if (!observed || !matchesRequested(observed, requested!)) {
			const mismatches = observed ? requestedMismatches(observed, requested!) : undefined;
			return unknownAfterWrite(action, new Error('EDA routing readback differs from the requested properties.'), {
				...context,
				after: observed ?? null,
				requested,
				failureKind: 'state_mismatch',
				...(mismatches ? { mismatches, mismatchCount: mismatches.length } : {}),
			});
		}
		return { ok: true, action, scope: SCOPE, pageUuid, kind: writableKind, primitiveId, primitive: observed, ...(writableKind === 'via' ? pcbViaDimensionNormalization(observed, requested!) : {}), verified: true };
	}
	catch (error: unknown) {
		return unknownAfterWrite(action, error, context);
	}
}
