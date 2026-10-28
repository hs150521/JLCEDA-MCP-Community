import { getEdaRuntime, isPlainObjectRecord, preserveBoundedArray, toSafeErrorMessage } from '../utils.ts';
import { comparePcbPolygonSource } from './pcb-polygon-equivalence.ts';

type Action = 'read' | 'create' | 'modify' | 'delete' | 'rebuild';
type PolygonSource = Array<'L' | 'ARC' | 'CARC' | 'C' | 'R' | 'CIRCLE' | number>;
type FillMethod = '45grid' | '90grid' | 'solid';

interface PourState {
	primitiveId: string;
	net: string;
	layer: number;
	polygonSource: PolygonSource;
	pourFillMethod: FillMethod;
	preserveSilos: boolean;
	pourName: string;
	pourPriority: number;
	lineWidth: number;
	primitiveLock: boolean;
}

interface PouredState {
	primitiveId: string;
	pourPrimitiveId: string;
	fillCount: number;
	fillGeometryDigest: string;
}

interface Snapshot {
	pourCount: number;
	pours: PourState[];
	pouredCount: number;
	poured: PouredState[];
}

const SCOPE = 'current_pcb_page';
const NATIVE_RESULT_UNKNOWN = /timed?\s*out|ETIMEDOUT|disconnect|connection\s+(?:closed|lost|reset|aborted)|socket\s+(?:closed|hang up)|transport\s+(?:closed|lost)|websocket.*(?:closed|not open)|ECONNRESET|ECONNABORTED|EPIPE/i;
const POLYGON_COMMANDS = new Set(['L', 'ARC', 'CARC', 'C', 'R', 'CIRCLE']);
const EDITABLE_FIELDS = new Set(['net', 'layer', 'polygonSource', 'pourFillMethod', 'preserveSilos', 'pourName', 'pourPriority', 'lineWidth', 'primitiveLock']);

function requiredId(value: unknown, field: string): string {
	if (typeof value !== 'string' || !value.trim())
		throw new TypeError(`${field} must be a non-empty string.`);
	return value.trim();
}

function finiteNumber(value: unknown, field: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value))
		throw new TypeError(`${field} must be a finite number.`);
	return value;
}

function copperLayer(value: unknown): number {
	const layer = finiteNumber(value, 'layer');
	if (!Number.isInteger(layer) || (layer !== 1 && layer !== 2 && (layer < 15 || layer > 44)))
		throw new TypeError('layer must be a copper layer ID (1, 2, or 15 through 44).');
	return layer;
}

function polygonSource(value: unknown): PolygonSource {
	if (!Array.isArray(value) || value.length === 0 || value.some(item =>
		!(typeof item === 'number' && Number.isFinite(item))
		&& !(typeof item === 'string' && POLYGON_COMMANDS.has(item)))) {
		throw new TypeError('polygonSource must be a non-empty single-polygon array of finite numbers and official polygon commands.');
	}
	return preserveBoundedArray([...value] as PolygonSource);
}

function fillMethod(value: unknown): FillMethod {
	if (value !== '45grid' && value !== '90grid' && value !== 'solid')
		throw new TypeError('pourFillMethod must be 45grid, 90grid, or solid.');
	return value;
}

function requiredBoolean(value: unknown, field: string): boolean {
	if (typeof value !== 'boolean')
		throw new TypeError(`${field} must be a boolean.`);
	return value;
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== 'string')
		throw new TypeError(`${field} must be a string.`);
	return value;
}

function readState(primitive: unknown, method: string): unknown {
	const getter = (primitive as Record<string, unknown> | null)?.[method];
	if (typeof getter !== 'function')
		throw new TypeError(`EDA PCB pour getter ${method} is unavailable.`);
	return getter.call(primitive);
}

function readPour(primitive: unknown): PourState {
	const polygon = readState(primitive, 'getState_ComplexPolygon');
	const source = readState(polygon, 'getSource');
	return {
		primitiveId: requiredId(readState(primitive, 'getState_PrimitiveId'), 'EDA pour primitiveId'),
		net: requiredString(readState(primitive, 'getState_Net'), 'EDA pour net'),
		layer: copperLayer(readState(primitive, 'getState_Layer')),
		polygonSource: polygonSource(source),
		pourFillMethod: fillMethod(readState(primitive, 'getState_PourFillMethod')),
		preserveSilos: requiredBoolean(readState(primitive, 'getState_PreserveSilos'), 'EDA pour preserveSilos'),
		pourName: requiredString(readState(primitive, 'getState_PourName'), 'EDA pour pourName'),
		pourPriority: finiteNumber(readState(primitive, 'getState_PourPriority'), 'EDA pour pourPriority'),
		lineWidth: finiteNumber(readState(primitive, 'getState_LineWidth'), 'EDA pour lineWidth'),
		primitiveLock: requiredBoolean(readState(primitive, 'getState_PrimitiveLock'), 'EDA pour primitiveLock'),
	};
}

function readPoured(primitive: unknown): PouredState {
	const fills = readState(primitive, 'getState_PourFills');
	if (!Array.isArray(fills))
		throw new TypeError('EDA poured fill list is not readable.');
	return {
		primitiveId: requiredId(readState(primitive, 'getState_PrimitiveId'), 'EDA poured primitiveId'),
		pourPrimitiveId: requiredId(readState(primitive, 'getState_PourPrimitiveId'), 'EDA poured pourPrimitiveId'),
		fillCount: fills.length,
		fillGeometryDigest: fillGeometryDigest(fills),
	};
}

function fillGeometryDigest(fills: unknown[]): string {
	const normalized = fills.map((value, index) => {
		if (!isPlainObjectRecord(value))
			throw new TypeError(`EDA poured fill ${String(index)} is not readable.`);
		const source = readState(value.path, 'getSourceStrictComplex');
		if (!Array.isArray(source) || source.some(ring => !Array.isArray(ring)))
			throw new TypeError(`EDA poured fill ${String(index)} geometry is not readable.`);
		return JSON.stringify({
			fill: requiredBoolean(value.fill, `EDA poured fill ${String(index)} fill`),
			lineWidth: finiteNumber(value.lineWidth, `EDA poured fill ${String(index)} lineWidth`),
			path: source.map(polygonSource),
		});
	});
	// Fill IDs can be regenerated by a later per-pour rebuild without changing
	// copper. Compare the geometry multiset, retaining duplicate geometries.
	const serialized = `[${normalized.sort().join(',')}]`;
	let hash = 0xCBF29CE484222325n;
	for (let index = 0; index < serialized.length; index++) {
		const codeUnit = serialized.charCodeAt(index);
		hash = BigInt.asUintN(64, (hash ^ BigInt(codeUnit & 0xFF)) * 0x100000001B3n);
		hash = BigInt.asUintN(64, (hash ^ BigInt(codeUnit >> 8)) * 0x100000001B3n);
	}
	return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}

function api(runtime: Record<string, unknown>, name: string, methods: string[]): Record<string, unknown> {
	const value = runtime[name];
	if (!isPlainObjectRecord(value) || methods.some(method => typeof value[method] !== 'function'))
		throw new TypeError(`EDA ${name}.${methods.filter(method => !isPlainObjectRecord(value) || typeof value[method] !== 'function').join('/')} API is unavailable in this client version.`);
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
		throw new Error('The active PCB changed during the pour operation.');
}

async function readSnapshot(runtime: Record<string, unknown>, expectedPageUuid: string): Promise<Snapshot> {
	const pourApi = api(runtime, 'pcb_PrimitivePour', ['getAll']);
	const pouredApi = api(runtime, 'pcb_PrimitivePoured', ['getAll']);
	const [rawPours, rawPoured] = await Promise.all([
		(pourApi.getAll as () => Promise<unknown>).call(pourApi),
		(pouredApi.getAll as () => Promise<unknown>).call(pouredApi),
	]);
	if (!Array.isArray(rawPours) || !Array.isArray(rawPoured))
		throw new TypeError('EDA PCB pour or poured getAll did not return an array.');
	const pours = preserveBoundedArray(rawPours.map(readPour));
	const poured = preserveBoundedArray(rawPoured.map(readPoured));
	if (new Set(pours.map(item => item.primitiveId)).size !== pours.length)
		throw new TypeError('EDA current-page pour readback returned duplicate primitive IDs.');
	if (new Set(poured.map(item => item.primitiveId)).size !== poured.length)
		throw new TypeError('EDA current-page poured readback returned duplicate primitive IDs.');
	await assertSamePage(runtime, expectedPageUuid);
	return { pourCount: pours.length, pours, pouredCount: poured.length, poured };
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

function requestedProperty(value: unknown): Record<string, unknown> {
	if (!isPlainObjectRecord(value) || Object.keys(value).length === 0)
		throw new TypeError('property must be a non-empty object.');
	const validated: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (!EDITABLE_FIELDS.has(key))
			throw new TypeError(`Unsupported PCB pour property: ${key}.`);
		switch (key) {
			case 'net':
				validated.net = requiredId(item, 'property.net');
				break;
			case 'layer':
				validated.layer = copperLayer(item);
				break;
			case 'polygonSource':
				validated.polygonSource = polygonSource(item);
				break;
			case 'pourFillMethod':
				validated.pourFillMethod = fillMethod(item);
				break;
			case 'preserveSilos':
			case 'primitiveLock':
				validated[key] = requiredBoolean(item, `property.${key}`);
				break;
			case 'pourName':
				validated.pourName = requiredString(item, 'property.pourName');
				break;
			case 'pourPriority':
				validated.pourPriority = finiteNumber(item, 'property.pourPriority');
				break;
			case 'lineWidth':
				validated.lineWidth = finiteNumber(item, 'property.lineWidth');
				if ((validated.lineWidth as number) <= 0)
					throw new RangeError('property.lineWidth must be positive.');
				break;
		}
	}
	return validated;
}

function createProperty(payload: Record<string, unknown>): Record<string, unknown> {
	return requestedProperty({
		net: payload.net,
		layer: payload.layer,
		polygonSource: payload.polygonSource,
		...(payload.pourFillMethod === undefined ? {} : { pourFillMethod: payload.pourFillMethod }),
		...(payload.preserveSilos === undefined ? {} : { preserveSilos: payload.preserveSilos }),
		...(payload.pourName === undefined ? {} : { pourName: payload.pourName }),
		...(payload.pourPriority === undefined ? {} : { pourPriority: payload.pourPriority }),
		...(payload.lineWidth === undefined ? {} : { lineWidth: payload.lineWidth }),
		...(payload.primitiveLock === undefined ? {} : { primitiveLock: payload.primitiveLock }),
	});
}

function createPolygon(runtime: Record<string, unknown>, source: PolygonSource): unknown {
	const mathApi = api(runtime, 'pcb_MathPolygon', ['createPolygon']);
	const polygon = (mathApi.createPolygon as (value: PolygonSource) => unknown).call(mathApi, source);
	if (polygon === undefined || polygon === null)
		throw new TypeError('EDA pcb_MathPolygon.createPolygon rejected polygonSource.');
	return polygon;
}

function polygonNormalization(state: PourState, requested: Record<string, unknown>): Record<string, unknown> {
	if (requested.polygonSource === undefined)
		return {};
	const comparison = comparePcbPolygonSource(state.polygonSource, requested.polygonSource);
	if (!comparison.equivalent || !comparison.normalized)
		return {};
	const { equivalent: _equivalent, normalized: _normalized, ...diagnostic } = comparison;
	return { normalization: { field: 'polygonSource', ...diagnostic } };
}

function diagnosticValue(value: unknown): unknown {
	return Array.isArray(value) ? preserveBoundedArray([...value]) : value;
}

function matchesRequested(state: PourState, requested: Record<string, unknown>): boolean {
	return Object.entries(requested).every(([key, value]) => {
		const actual = state[key as keyof PourState];
		if (key === 'polygonSource')
			return comparePcbPolygonSource(state.polygonSource, value).equivalent;
		if (typeof value === 'number' && typeof actual === 'number')
			return Math.abs(actual - value) <= 1e-6;
		return actual === value;
	});
}

function unknownNativeWrite(action: Exclude<Action, 'read'>, error: unknown, context: Record<string, unknown>): Record<string, unknown> {
	const message = toSafeErrorMessage(error);
	if (action !== 'rebuild' && !NATIVE_RESULT_UNKNOWN.test(message))
		throw error;
	return { ok: false, action, scope: SCOPE, ...context, reason: 'native_call_result_unknown', error: message, commitUnknown: true, readbackRequired: true, nativeCallSettled: !NATIVE_RESULT_UNKNOWN.test(message) };
}

function unknownAfterWrite(action: Exclude<Action, 'read'>, error: unknown, context: Record<string, unknown>): Record<string, unknown> {
	return { ok: false, action, scope: SCOPE, ...context, reason: 'post_write_readback_failed', error: toSafeErrorMessage(error), commitUnknown: true, readbackRequired: true, nativeCallSettled: true };
}

const REBUILD_DIAGNOSTIC_LIMIT = 40;
const REBUILD_READBACK_ATTEMPTS = 3;

function boundedDiagnosticList<T>(items: T[]): T[] {
	return items.slice(0, REBUILD_DIAGNOSTIC_LIMIT);
}

function rebuildDiagnostics(nativeResult: unknown, before: Snapshot, after: Snapshot | undefined, primitiveId: string | undefined, rebuildPath: string, readbackAttempts: number, nativeReturnTypes: Record<string, number>): Record<string, unknown> {
	const observed = after?.poured.filter(item => !primitiveId || item.pourPrimitiveId === primitiveId) ?? [];
	let returned: PouredState[] = [];
	let returnedReadable = false;
	try {
		if (Array.isArray(nativeResult)) {
			returned = nativeResult.map(readPoured);
			returnedReadable = true;
		}
	}
	catch { /* 不可读的原生返回不影响已取得的页面诊断。 */ }
	const returnedIds = new Set(returned.map(item => item.primitiveId));
	const seenReturnedIds = new Set<string>();
	const duplicateReturnedIds = new Set<string>();
	for (const item of returned) {
		if (seenReturnedIds.has(item.primitiveId))
			duplicateReturnedIds.add(item.primitiveId);
		seenReturnedIds.add(item.primitiveId);
	}
	const observedIds = new Set(observed.map(item => item.primitiveId));
	const missingReturned = observed.filter(item => !returnedIds.has(item.primitiveId));
	const missingObserved = returned.filter(item => !observedIds.has(item.primitiveId));
	const summarize = (items: PouredState[]) => boundedDiagnosticList(items).map(item => ({
		primitiveId: item.primitiveId.slice(0, 160),
		pourPrimitiveId: item.pourPrimitiveId.slice(0, 160),
		fillCount: item.fillCount,
		fillGeometryDigest: item.fillGeometryDigest,
	}));
	return {
		rebuildPath,
		nativeReturnType: nativeResult === null ? 'null' : Array.isArray(nativeResult) ? 'array' : typeof nativeResult,
		nativeReturnCount: Array.isArray(nativeResult) ? nativeResult.length : null,
		nativeReturnTypes: { ...nativeReturnTypes },
		returnedReadable,
		duplicateReturnedCount: returnedReadable ? returned.length - returnedIds.size : null,
		duplicateReturnedIds: boundedDiagnosticList([...duplicateReturnedIds]).map(id => id.slice(0, 160)),
		observedCount: after ? observed.length : null,
		missingReturnedCount: returnedReadable && after ? missingReturned.length : null,
		missingObservedCount: returnedReadable && after ? missingObserved.length : null,
		missingReturnedIds: boundedDiagnosticList(missingReturned).map(item => item.primitiveId.slice(0, 160)),
		missingObservedIds: boundedDiagnosticList(missingObserved).map(item => item.primitiveId.slice(0, 160)),
		returned: summarize(returned),
		after: after ? { pourCount: after.pourCount, pouredCount: after.pouredCount, poured: summarize(after.poured) } : null,
		diagnosticLimit: REBUILD_DIAGNOSTIC_LIMIT,
		truncated: [returned.length, duplicateReturnedIds.size, after?.pouredCount ?? 0, missingReturned.length, missingObserved.length].some(count => count > REBUILD_DIAGNOSTIC_LIMIT),
		readbackAttempts,
	};
}

function verifyRebuild(nativeResult: unknown, before: Snapshot, after: Snapshot, primitiveId: string | undefined, context: Record<string, unknown>): Record<string, unknown> {
	// The native return set is advisory: JLCEDA may return only changed or newly
	// generated fills, and a per-pour rebuild may return null for an unchanged
	// pour (issue #95) or repeat a fill object across different pours in v4.
	// Current-page readback is the authoritative evidence.
	if (nativeResult !== null && nativeResult !== undefined && !Array.isArray(nativeResult))
		throw new TypeError('EDA rebuildCopperRegions did not return a poured array.');
	const returnedPoured = Array.isArray(nativeResult) ? nativeResult.map(readPoured) : [];
	const returnedIds = new Set(returnedPoured.map(item => item.primitiveId));
	const beforePourIds = new Set(before.pours.map(item => item.primitiveId));
	const afterPourIds = new Set(after.pours.map(item => item.primitiveId));
	if (beforePourIds.size !== afterPourIds.size || [...beforePourIds].some(id => !afterPourIds.has(id)))
		throw new Error('EDA rebuild changed the pour boundaries.');
	// Anything the native did return must be readable and identical on the page.
	for (const returned of returnedPoured) {
		if (!afterPourIds.has(returned.pourPrimitiveId))
			throw new Error('EDA rebuild returned a fill for a missing pour.');
		if (primitiveId && returned.pourPrimitiveId !== primitiveId)
			throw new Error('EDA rebuild returned a fill for a different pour.');
		const observed = after.poured.find(item => item.primitiveId === returned.primitiveId);
		if (!observed
			|| observed.pourPrimitiveId !== returned.pourPrimitiveId
			|| observed.fillCount !== returned.fillCount
			|| observed.fillGeometryDigest !== returned.fillGeometryDigest) {
			throw new Error('EDA rebuilt fill is missing or differs on current-page readback.');
		}
	}
	const targets = primitiveId ? [primitiveId] : after.pours.map(item => item.primitiveId);
	const readable = (pourId: string): boolean => after.poured.some(item => item.pourPrimitiveId === pourId);
	const hadFill = (pourId: string): boolean => before.poured.some(item => item.pourPrimitiveId === pourId);
	if (primitiveId && !readable(primitiveId)) {
		// A single targeted pour with no readable fill is a known, reportable outcome:
		// the caller does not need quarantine to learn that the target has no fill.
		const beforeTargetPoured = before.poured.filter(item => item.pourPrimitiveId === primitiveId);
		return {
			ok: false,
			action: 'rebuild',
			scope: SCOPE,
			...context,
			reason: 'rebuild_no_target_fill',
			applied: beforeTargetPoured.length > 0,
			verified: false,
			before: beforeTargetPoured,
			after: [],
			rebuildReturnedCount: returnedPoured.length,
		};
	}
	// A pour that was filled before must still have a readable fill: losing it is a
	// real regression regardless of what the native return set claimed.
	const lost = targets.filter(pourId => hadFill(pourId) && !readable(pourId));
	if (lost.length > 0)
		throw new Error(`EDA rebuild lost the readable fill for pour(s): ${lost.slice(0, 8).join(', ')}.`);
	// No fill before and none after: neither the return set nor the page can show
	// that this pour was rebuilt, so the write stays unknown instead of "verified".
	const unproven = targets.filter(pourId => !hadFill(pourId) && !readable(pourId));
	if (unproven.length > 0)
		throw new Error(`EDA rebuild left no readable fill for targeted pour(s): ${unproven.slice(0, 8).join(', ')}.`);
	return { ok: true, action: 'rebuild', scope: SCOPE, ...context, verified: true, verificationScope: 'page_readback', nativeReturnCoveredObservedCount: after.poured.filter(item => returnedIds.has(item.primitiveId)).length, rebuildReturnedCount: returnedPoured.length, ...after };
}

export async function handlePcbPourManageTask(payload: unknown): Promise<unknown> {
	if (!isPlainObjectRecord(payload))
		throw new TypeError('pcb_pour_manage payload must be an object.');
	const action = payload.action as Action;
	if (action !== 'read' && action !== 'create' && action !== 'modify' && action !== 'delete' && action !== 'rebuild')
		throw new TypeError('action must be read, create, modify, delete, or rebuild.');
	const primitiveId = action === 'modify' || action === 'delete' || (action === 'rebuild' && payload.all !== true)
		? requiredId(payload.primitiveId, 'primitiveId')
		: undefined;
	if (action === 'rebuild' && payload.all === true && payload.primitiveId !== undefined)
		throw new TypeError('rebuild accepts either primitiveId or all=true.');
	const requested = action === 'modify' ? requestedProperty(payload.property) : action === 'create' ? createProperty(payload) : undefined;
	const runtime = getEdaRuntime();
	if (!runtime)
		throw new TypeError('EDA runtime is unavailable.');
	const pourApi = api(runtime, 'pcb_PrimitivePour', ['getAll', ...(action === 'read' || action === 'rebuild' ? [] : [action])]);
	const pageUuid = await currentPageUuid(runtime);
	const before = await readSnapshot(runtime, pageUuid);
	if (action === 'read')
		return { ok: true, action, scope: SCOPE, complete: true, pageUuid, ...before };
	const context: Record<string, unknown> = { pageUuid, ...(primitiveId ? { primitiveId } : {}) };
	if (action === 'create')
		context.beforePourIds = preserveBoundedArray(before.pours.map(pour => pour.primitiveId));
	if (action === 'rebuild')
		context.all = payload.all === true;
	if (primitiveId && !before.pours.some(pour => pour.primitiveId === primitiveId))
		throw new TypeError(`PCB pour ${primitiveId} does not exist on the current page.`);
	let rebuildInstances: Record<string, unknown>[] | undefined;
	if (action === 'rebuild' && typeof pourApi.rebuildCopperRegions !== 'function') {
		const rawPours = await (pourApi.getAll as () => Promise<unknown>).call(pourApi);
		if (!Array.isArray(rawPours))
			throw new TypeError('EDA pcb_PrimitivePour.getAll did not return an array.');
		const targetIds = new Set(primitiveId ? [primitiveId] : before.pours.map(item => item.primitiveId));
		const targets = rawPours.filter(item => targetIds.has(requiredId(readState(item, 'getState_PrimitiveId'), 'EDA pour primitiveId')));
		if (targets.length !== targetIds.size)
			throw new Error('PCB pour targets changed before rebuild.');
		await assertSamePage(runtime, pageUuid);
		if (targets.some(item => !isPlainObjectRecord(item) || typeof item.rebuildCopperRegion !== 'function')) {
			const environment = runtime.sys_Environment;
			let editorVersion: string | undefined;
			try {
				if (isPlainObjectRecord(environment) && typeof environment.getEditorCurrentVersion === 'function') {
					const version = await environment.getEditorCurrentVersion();
					if (typeof version === 'string')
						editorVersion = version;
				}
			}
			catch { /* 版本读取不影响未写入的能力诊断。 */ }
			return {
				ok: false,
				action,
				scope: SCOPE,
				...context,
				reason: 'unsupported_capability',
				errorCode: 'EDA_CAPABILITY_UNAVAILABLE',
				unavailableApis: ['eda.pcb_PrimitivePour.rebuildCopperRegions', 'eda.IPCB_PrimitivePour.rebuildCopperRegion'],
				...(editorVersion ? { editorVersion } : {}),
				error: 'The current EDA version exposes neither batch nor per-pour copper rebuilding for the requested pours.',
				applied: false,
				verified: false,
			};
		}
		rebuildInstances = targets as Record<string, unknown>[];
	}
	if (requested?.net !== undefined)
		await verifyNet(runtime, requested.net as string);
	if (requested?.layer !== undefined)
		await verifyCopperLayer(runtime, requested.layer as number);
	const nativeProperty = requested === undefined ? undefined : { ...requested };
	if (nativeProperty?.polygonSource !== undefined) {
		nativeProperty.complexPolygon = createPolygon(runtime, nativeProperty.polygonSource as PolygonSource);
		delete nativeProperty.polygonSource;
	}
	await assertSamePage(runtime, pageUuid);
	let nativeResult: unknown;
	const nativeReturnTypes: Record<string, number> = {};
	const recordNativeType = (value: unknown) => {
		const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
		nativeReturnTypes[type] = (nativeReturnTypes[type] ?? 0) + 1;
	};
	const rebuildPath = rebuildInstances ? 'per_pour' : 'batch';
	try {
		if (action === 'create') {
			nativeResult = await (pourApi.create as (...args: unknown[]) => Promise<unknown>).call(
				pourApi,
				requested!.net,
				requested!.layer,
				nativeProperty!.complexPolygon,
				requested!.pourFillMethod,
				requested!.preserveSilos,
				requested!.pourName,
				requested!.pourPriority,
				requested!.lineWidth,
				requested!.primitiveLock,
			);
		}
		else if (action === 'modify') {
			nativeResult = await (pourApi.modify as (...args: unknown[]) => Promise<unknown>).call(pourApi, primitiveId, nativeProperty);
		}
		else if (action === 'delete') {
			nativeResult = await (pourApi.delete as (...args: unknown[]) => Promise<unknown>).call(pourApi, primitiveId);
		}
		else if (rebuildInstances) {
			const results: unknown[] = [];
			for (const target of rebuildInstances) {
				await assertSamePage(runtime, pageUuid);
				const result = await (target.rebuildCopperRegion as () => Promise<unknown>).call(target);
				recordNativeType(result);
				if (result !== undefined && result !== null)
					results.push(result);
			}
			nativeResult = results;
		}
		else {
			nativeResult = await (pourApi.rebuildCopperRegions as (...args: unknown[]) => Promise<unknown>).call(pourApi, payload.all === true ? undefined : [primitiveId]);
		}
	}
	catch (error: unknown) {
		if (action === 'rebuild')
			context.rebuildDiagnostics = rebuildDiagnostics(nativeResult, before, undefined, primitiveId, rebuildPath, 0, nativeReturnTypes);
		return unknownNativeWrite(action, error, context);
	}
	if (action === 'rebuild') {
		if (!rebuildInstances)
			recordNativeType(nativeResult);
		let lastError: unknown;
		let after: Snapshot | undefined;
		for (let attempt = 1; attempt <= REBUILD_READBACK_ATTEMPTS; attempt++) {
			try {
				await assertSamePage(runtime, pageUuid);
				after = await readSnapshot(runtime, pageUuid);
				context.rebuildDiagnostics = rebuildDiagnostics(nativeResult, before, after, primitiveId, rebuildPath, attempt, nativeReturnTypes);
				const result = verifyRebuild(nativeResult, before, after, primitiveId, context);
				if (result.ok || attempt === REBUILD_READBACK_ATTEMPTS)
					return result;
			}
			catch (error: unknown) {
				lastError = error;
				context.rebuildDiagnostics = rebuildDiagnostics(nativeResult, before, after, primitiveId, rebuildPath, attempt, nativeReturnTypes);
			}
			if (attempt < REBUILD_READBACK_ATTEMPTS)
				await new Promise(resolve => setTimeout(resolve, 100));
		}
		return unknownAfterWrite(action, lastError, context);
	}
	try {
		const after = await readSnapshot(runtime, pageUuid);
		if (action === 'create') {
			const returnedId = nativeResult == null ? undefined : requiredId(readState(nativeResult, 'getState_PrimitiveId'), 'EDA created pour primitiveId');
			const newPours = after.pours.filter(pour => !before.pours.some(old => old.primitiveId === pour.primitiveId));
			const created = returnedId ? after.pours.find(pour => pour.primitiveId === returnedId) : newPours.length === 1 ? newPours[0] : undefined;
			if (!created || newPours.length !== 1 || created.primitiveId !== newPours[0]?.primitiveId)
				throw new Error('EDA did not read back exactly one new pour.');
			const requestedMismatches = Object.entries(requested!).filter(([field, expected]) =>
				!matchesRequested(created, { [field]: expected })).map(([field, expected]) => ({
				field,
				expected: diagnosticValue(expected),
				actual: diagnosticValue(created[field as keyof PourState]),
			}));
			const sideEffects: Array<{ primitiveId: string; field: string; before: unknown; after: unknown }>
				= requestedMismatches.map(item => ({ primitiveId: created.primitiveId, field: item.field, before: diagnosticValue(item.expected), after: diagnosticValue(item.actual) }));
			for (const oldPour of before.pours) {
				const newPour = after.pours.find(pour => pour.primitiveId === oldPour.primitiveId);
				if (!newPour) {
					sideEffects.push({ primitiveId: oldPour.primitiveId, field: 'primitiveId', before: oldPour.primitiveId, after: null });
					continue;
				}
				for (const field of EDITABLE_FIELDS) {
					const previous = oldPour[field as keyof PourState];
					if (!matchesRequested(newPour, { [field]: previous }))
						sideEffects.push({ primitiveId: oldPour.primitiveId, field, before: diagnosticValue(previous), after: diagnosticValue(newPour[field as keyof PourState]) });
				}
			}
			if (requestedMismatches.length || sideEffects.length) {
				return {
					ok: false,
					action,
					scope: SCOPE,
					pageUuid,
					primitiveId: created.primitiveId,
					reason: 'create_readback_mismatch',
					applied: true,
					verified: false,
					before: null,
					after: created,
					requestedMismatches,
					sideEffects,
				};
			}
			return { ok: true, action, scope: SCOPE, pageUuid, primitiveId: created.primitiveId, pour: created, verified: true, ...polygonNormalization(created, requested!) };
		}
		if (action === 'modify') {
			const modified = after.pours.find(pour => pour.primitiveId === primitiveId);
			const original = before.pours.find(pour => pour.primitiveId === primitiveId);
			if (!modified || !original)
				throw new Error('EDA modified pour was not readable on the current page.');
			const requestedMismatches = Object.entries(requested!).filter(([field, expected]) =>
				!matchesRequested(modified, { [field]: expected })).map(([field, expected]) => ({
				field,
				expected: diagnosticValue(expected),
				actual: diagnosticValue(modified[field as keyof PourState]),
			}));
			const sideEffects: Array<{ primitiveId: string; field: string; before: unknown; after: unknown }> = [];
			for (const oldPour of before.pours) {
				const newPour = after.pours.find(pour => pour.primitiveId === oldPour.primitiveId);
				if (!newPour) {
					sideEffects.push({ primitiveId: oldPour.primitiveId, field: 'primitiveId', before: oldPour.primitiveId, after: null });
					continue;
				}
				for (const field of EDITABLE_FIELDS) {
					if (oldPour.primitiveId === primitiveId && Object.hasOwn(requested!, field))
						continue;
					const previous = oldPour[field as keyof PourState];
					if (!matchesRequested(newPour, { [field]: previous })) {
						sideEffects.push({ primitiveId: oldPour.primitiveId, field, before: diagnosticValue(previous), after: diagnosticValue(newPour[field as keyof PourState]) });
					}
				}
			}
			for (const newPour of after.pours) {
				if (!before.pours.some(pour => pour.primitiveId === newPour.primitiveId))
					sideEffects.push({ primitiveId: newPour.primitiveId, field: 'primitiveId', before: null, after: newPour.primitiveId });
			}
			if (requestedMismatches.length || sideEffects.length) {
				const targetChanged = [...EDITABLE_FIELDS].some(field =>
					!matchesRequested(modified, { [field]: original[field as keyof PourState] }));
				return {
					ok: false,
					action,
					scope: SCOPE,
					pageUuid,
					primitiveId,
					reason: 'modify_readback_mismatch',
					applied: nativeResult != null || targetChanged || sideEffects.length > 0,
					verified: false,
					before: original,
					after: modified,
					requestedMismatches,
					sideEffects,
				};
			}
			return { ok: true, action, scope: SCOPE, pageUuid, primitiveId, pour: modified, verified: true, ...polygonNormalization(modified, requested!) };
		}
		if (action === 'delete') {
			const remainingPoured = after.poured.filter(item => item.pourPrimitiveId === primitiveId);
			const boundaryExists = after.pours.some(pour => pour.primitiveId === primitiveId);
			if (!boundaryExists && remainingPoured.length) {
				return {
					ok: false,
					action,
					scope: SCOPE,
					pageUuid,
					primitiveId,
					reason: 'delete_left_associated_fill',
					applied: true,
					verified: false,
					before: {
						pour: before.pours.find(pour => pour.primitiveId === primitiveId),
						poured: before.poured.filter(item => item.pourPrimitiveId === primitiveId),
					},
					after: {
						pour: null,
						poured: remainingPoured,
					},
				};
			}
			if (nativeResult === false || boundaryExists)
				throw new Error('EDA pour still exists after delete.');
			return { ok: true, action, scope: SCOPE, pageUuid, primitiveId, deleted: true, verified: true };
		}
		throw new Error('Unsupported pour operation.');
	}
	catch (error: unknown) {
		return unknownAfterWrite(action, error, context);
	}
}
