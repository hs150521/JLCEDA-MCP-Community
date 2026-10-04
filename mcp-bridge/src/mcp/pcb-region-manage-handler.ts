import { getEdaRuntime, isPlainObjectRecord, preserveBoundedArray, toSafeErrorMessage } from '../utils.ts';
import { comparePcbPolygonSource } from './pcb-polygon-equivalence.ts';

type Action = 'read' | 'create' | 'modify' | 'delete';
type PolygonSource = Array<'L' | 'ARC' | 'CARC' | 'C' | 'R' | 'CIRCLE' | number>;
type RegionPolygonSource = PolygonSource | PolygonSource[];

interface RegionState {
	primitiveId: string;
	layer: number;
	polygonSource: RegionPolygonSource;
	ruleType: number[];
	regionName: string | null;
	lineWidth: number;
	primitiveLock: boolean;
}

const SCOPE = 'current_pcb_page';
const RULE_TYPES = new Set([2, 5, 6, 7, 8, 9]);
const POLYGON_COMMANDS = new Set(['L', 'ARC', 'CARC', 'C', 'R', 'CIRCLE']);
const FIELDS = new Set(['layer', 'polygonSource', 'ruleType', 'regionName', 'lineWidth', 'primitiveLock']);
const NATIVE_RESULT_UNKNOWN = /timed?\s*out|ETIMEDOUT|disconnect|connection\s+(?:closed|lost|reset|aborted)|socket\s+(?:closed|hang up)|transport\s+(?:closed|lost)|websocket.*(?:closed|not open)|ECONNRESET|ECONNABORTED|EPIPE/i;

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

function regionLayer(value: unknown): number {
	const layer = finiteNumber(value, 'layer');
	if (!Number.isInteger(layer) || (layer !== 1 && layer !== 2 && layer !== 12 && (layer < 15 || layer > 44)))
		throw new TypeError('layer must be 1, 2, 12, or 15 through 44.');
	return layer;
}

function singlePolygonSource(value: unknown): PolygonSource {
	if (!Array.isArray(value) || value.length === 0 || value.some(item =>
		!(typeof item === 'number' && Number.isFinite(item))
		&& !(typeof item === 'string' && POLYGON_COMMANDS.has(item)))) {
		throw new TypeError('polygonSource must be a non-empty single-polygon array of finite numbers and official polygon commands.');
	}
	return preserveBoundedArray([...value] as PolygonSource);
}

function polygonSource(value: unknown): RegionPolygonSource {
	if (Array.isArray(value) && value.length > 0 && value.every(Array.isArray))
		return preserveBoundedArray(value.map(singlePolygonSource));
	return singlePolygonSource(value);
}

function ruleTypes(value: unknown): number[] {
	if (!Array.isArray(value) || value.some(item => !RULE_TYPES.has(item)))
		throw new TypeError('ruleType must contain official region rules 2, 5, 6, 7, 8, or 9.');
	return preserveBoundedArray([...value] as number[]);
}

function readState(raw: unknown, method: string): unknown {
	const getter = (raw as Record<string, unknown> | null)?.[method];
	if (typeof getter !== 'function')
		throw new TypeError(`EDA PCB region getter ${method} is unavailable.`);
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
		throw new Error('The active PCB changed during the region operation.');
}

function readRegion(raw: unknown): RegionState {
	const polygon = readState(raw, 'getState_ComplexPolygon');
	const name = readState(raw, 'getState_RegionName');
	if (name !== undefined && typeof name !== 'string')
		throw new TypeError('EDA regionName is invalid.');
	const lock = readState(raw, 'getState_PrimitiveLock');
	if (typeof lock !== 'boolean')
		throw new TypeError('EDA primitiveLock is invalid.');
	return {
		primitiveId: requiredId(readState(raw, 'getState_PrimitiveId'), 'EDA primitiveId'),
		layer: regionLayer(readState(raw, 'getState_Layer')),
		polygonSource: polygonSource(readState(polygon, 'getSource')),
		ruleType: ruleTypes(readState(raw, 'getState_RuleType')),
		regionName: name ?? null,
		lineWidth: finiteNumber(readState(raw, 'getState_LineWidth'), 'EDA lineWidth'),
		primitiveLock: lock,
	};
}

async function getOne(runtime: Record<string, unknown>, id: string, expectedPage: string): Promise<RegionState | undefined> {
	return (await getAll(runtime, expectedPage)).find(region => region.primitiveId === id);
}

async function getAll(runtime: Record<string, unknown>, expectedPage: string): Promise<RegionState[]> {
	const regionApi = api(runtime, 'pcb_PrimitiveRegion', ['getAll']);
	const raw = await (regionApi.getAll as () => Promise<unknown>).call(regionApi);
	if (!Array.isArray(raw))
		throw new TypeError('EDA pcb_PrimitiveRegion.getAll did not return an array.');
	const regions = preserveBoundedArray(raw.map(readRegion));
	await assertSamePage(runtime, expectedPage);
	return regions;
}

async function verifyLayer(runtime: Record<string, unknown>, layer: number): Promise<void> {
	const layerApi = api(runtime, 'pcb_Layer', ['getAllLayers']);
	const layers = await (layerApi.getAllLayers as () => Promise<unknown>).call(layerApi);
	if (!Array.isArray(layers))
		throw new TypeError('EDA pcb_Layer.getAllLayers did not return an array.');
	const selected = layers.find(item => isPlainObjectRecord(item) && item.id === layer);
	if (!isPlainObjectRecord(selected) || selected.layerStatus === 0 || selected.locked === true)
		throw new TypeError(`PCB region layer ${String(layer)} is unavailable, disabled, or locked.`);
}

function requestedProperty(value: unknown): Record<string, unknown> {
	if (!isPlainObjectRecord(value) || Object.keys(value).length === 0)
		throw new TypeError('property must be a non-empty object.');
	const result: Record<string, unknown> = {};
	for (const [field, item] of Object.entries(value)) {
		if (!FIELDS.has(field))
			throw new TypeError(`Unsupported PCB region property: ${field}.`);
		if (field === 'layer') {
			result.layer = regionLayer(item);
		}
		else if (field === 'polygonSource') {
			result.polygonSource = singlePolygonSource(item);
		}
		else if (field === 'ruleType') {
			result.ruleType = ruleTypes(item);
		}
		else if (field === 'regionName') {
			if (typeof item !== 'string')
				throw new TypeError('regionName must be a string.');
			result.regionName = item;
		}
		else if (field === 'lineWidth') {
			const width = finiteNumber(item, field);
			if (width <= 0)
				throw new RangeError('lineWidth must be positive.');
			result.lineWidth = width;
		}
		else if (field === 'primitiveLock') {
			if (typeof item !== 'boolean')
				throw new TypeError('primitiveLock must be a boolean.');
			result.primitiveLock = item;
		}
	}
	return result;
}

function createProperty(payload: Record<string, unknown>): Record<string, unknown> {
	const requested = requestedProperty(Object.fromEntries([...FIELDS].filter(field => payload[field] !== undefined).map(field => [field, payload[field]])));
	for (const field of ['layer', 'polygonSource', 'ruleType']) {
		if (requested[field] === undefined)
			throw new TypeError(`${field} is required for PCB region creation.`);
	}
	if ((requested.ruleType as number[]).length === 0)
		throw new TypeError('ruleType must contain at least one rule for PCB region creation.');
	return requested;
}

function createPolygon(runtime: Record<string, unknown>, source: PolygonSource): unknown {
	const mathApi = api(runtime, 'pcb_MathPolygon', ['createPolygon']);
	const polygon = (mathApi.createPolygon as (source: PolygonSource) => unknown).call(mathApi, source);
	if (polygon == null)
		throw new TypeError('EDA pcb_MathPolygon.createPolygon rejected polygonSource.');
	return polygon;
}

function clonePolygonSource(source: RegionPolygonSource): RegionPolygonSource {
	return Array.isArray(source[0])
		? preserveBoundedArray((source as PolygonSource[]).map(contour => preserveBoundedArray([...contour])))
		: preserveBoundedArray([...source] as PolygonSource);
}

function polygonNormalization(actual: RegionState, requested: Record<string, unknown>): Record<string, unknown> {
	if (requested.polygonSource === undefined)
		return {};
	const comparison = comparePcbPolygonSource(actual.polygonSource, requested.polygonSource);
	if (!comparison.equivalent || !comparison.normalized)
		return {};
	const { equivalent: _equivalent, normalized: _normalized, ...diagnostic } = comparison;
	return { normalization: { field: 'polygonSource', ...diagnostic } };
}

function matchesRequested(actual: RegionState, requested: Record<string, unknown>): boolean {
	return Object.entries(requested).every(([field, wanted]) => {
		const observed = actual[field as keyof RegionState];
		if (field === 'ruleType') {
			const rules = wanted as number[];
			return actual.ruleType.length === rules.length && rules.every(rule => actual.ruleType.includes(rule));
		}
		if (field === 'polygonSource') {
			return comparePcbPolygonSource(actual.polygonSource, wanted).equivalent;
		}
		return typeof observed === 'number' && typeof wanted === 'number'
			? Math.abs(observed - wanted) <= 1e-6
			: observed === wanted;
	});
}

function unknownWrite(action: Exclude<Action, 'read'>, error: unknown, context: Record<string, unknown>, nativeCallSettled: boolean): Record<string, unknown> {
	const message = toSafeErrorMessage(error);
	if (!nativeCallSettled && !NATIVE_RESULT_UNKNOWN.test(message))
		throw error;
	return { ok: false, action, scope: SCOPE, ...context, reason: nativeCallSettled ? 'post_write_readback_failed' : 'native_call_result_unknown', error: message, commitUnknown: true, readbackRequired: true, nativeCallSettled };
}

export async function handlePcbRegionManageTask(payload: unknown): Promise<unknown> {
	if (!isPlainObjectRecord(payload))
		throw new TypeError('pcb_region_manage payload must be an object.');
	const action = payload.action as Action;
	if (action !== 'read' && action !== 'create' && action !== 'modify' && action !== 'delete')
		throw new TypeError('action must be read, create, modify, or delete.');
	const primitiveId = action === 'modify' || action === 'delete' || payload.primitiveId !== undefined
		? requiredId(payload.primitiveId, 'primitiveId')
		: undefined;
	const requested = action === 'create'
		? createProperty(payload)
		: action === 'modify' ? requestedProperty(payload.property) : undefined;
	const runtime = getEdaRuntime();
	if (!runtime)
		throw new TypeError('EDA runtime is unavailable.');
	const currentPage = await pageUuid(runtime);
	if (action === 'read') {
		if (primitiveId) {
			const region = await getOne(runtime, primitiveId, currentPage);
			return { ok: true, action, scope: SCOPE, pageUuid: currentPage, primitiveId, found: region !== undefined, region: region ?? null };
		}
		const regions = await getAll(runtime, currentPage);
		return { ok: true, action, scope: SCOPE, pageUuid: currentPage, complete: true, regionCount: regions.length, regions };
	}
	const regionApi = api(runtime, 'pcb_PrimitiveRegion', [action, 'getAll']);
	const context: Record<string, unknown> = { pageUuid: currentPage, ...(primitiveId ? { primitiveId } : {}) };
	const before = primitiveId ? await getOne(runtime, primitiveId, currentPage) : undefined;
	if (primitiveId && !before)
		throw new TypeError(`PCB region ${primitiveId} does not exist on the current page.`);
	const beforeIds = action === 'create' ? (await getAll(runtime, currentPage)).map(item => item.primitiveId) : undefined;
	if (beforeIds)
		context.beforePrimitiveIds = beforeIds;
	await verifyLayer(runtime, regionLayer(requested?.layer ?? before!.layer));
	const nativeProperty = requested === undefined ? undefined : { ...requested };
	if (nativeProperty?.polygonSource) {
		nativeProperty.complexPolygon = createPolygon(runtime, nativeProperty.polygonSource as PolygonSource);
		delete nativeProperty.polygonSource;
	}
	await assertSamePage(runtime, currentPage);
	try {
		if (action === 'create') {
			await (regionApi.create as (...args: unknown[]) => Promise<unknown>).call(regionApi, requested!.layer, nativeProperty!.complexPolygon, requested!.ruleType, requested!.regionName, requested!.lineWidth, requested!.primitiveLock);
		}
		else if (action === 'modify') {
			await (regionApi.modify as (...args: unknown[]) => Promise<unknown>).call(regionApi, primitiveId, nativeProperty);
		}
		else {
			await (regionApi.delete as (...args: unknown[]) => Promise<unknown>).call(regionApi, primitiveId);
		}
	}
	catch (error: unknown) {
		return unknownWrite(action, error, context, false);
	}
	try {
		await assertSamePage(runtime, currentPage);
		if (action === 'create') {
			const all = await getAll(runtime, currentPage);
			const added = all.filter(item => !beforeIds!.includes(item.primitiveId));
			if (added.length === 0)
				return { ok: false, action, scope: SCOPE, pageUuid: currentPage, reason: 'native_create_no_effect', applied: false, verified: false, nativeCallSettled: true };
			if (added.length !== 1)
				throw new Error('EDA read back multiple new PCB regions after one creation request.');
			const created = added[0];
			const requestedMismatches = Object.entries(requested!).filter(([field, expected]) =>
				!matchesRequested(created, { [field]: expected })).map(([field, expected]) => {
				const actual = created[field as keyof RegionState];
				return { field, expected, actual: field === 'polygonSource' ? clonePolygonSource(created.polygonSource) : Array.isArray(actual) ? preserveBoundedArray([...actual]) : actual };
			});
			if (requestedMismatches.length) {
				return {
					ok: false,
					action,
					scope: SCOPE,
					pageUuid: currentPage,
					primitiveId: created.primitiveId,
					reason: 'create_readback_mismatch',
					applied: true,
					verified: false,
					before: null,
					after: created,
					requestedMismatches,
				};
			}
			return { ok: true, action, scope: SCOPE, pageUuid: currentPage, primitiveId: created.primitiveId, region: created, verified: true, ...polygonNormalization(created, requested!) };
		}
		const observed = await getOne(runtime, primitiveId!, currentPage);
		if (action === 'modify') {
			if (!observed || !matchesRequested(observed, requested!)) {
				const requestedMismatches = observed
					? Object.keys(requested!).filter(field => !matchesRequested(observed, { [field]: requested![field] }))
					: Object.keys(requested!);
				return {
					ok: false,
					action,
					scope: SCOPE,
					pageUuid: currentPage,
					primitiveId,
					reason: observed ? 'requested_properties_not_applied' : 'region_missing_after_modify',
					before,
					after: observed ?? null,
					requested,
					requestedMismatches,
					applied: !observed || JSON.stringify(before) !== JSON.stringify(observed),
					verified: false,
				};
			}
			return { ok: true, action, scope: SCOPE, pageUuid: currentPage, primitiveId, region: observed, verified: true, ...polygonNormalization(observed, requested!) };
		}
		if (observed !== undefined)
			return { ok: false, action, scope: SCOPE, pageUuid: currentPage, primitiveId, reason: 'region_still_present', before, after: observed, applied: JSON.stringify(before) !== JSON.stringify(observed), verified: false };
		return { ok: true, action, scope: SCOPE, pageUuid: currentPage, primitiveId, deleted: true, verified: true };
	}
	catch (error: unknown) {
		return unknownWrite(action, error, context, true);
	}
}
