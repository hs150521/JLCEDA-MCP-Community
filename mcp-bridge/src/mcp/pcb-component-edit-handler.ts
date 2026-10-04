import { getEdaRuntime, isPlainObjectRecord, preserveBoundedArray, toSafeErrorMessage } from '../utils.ts';

type Action = 'read' | 'create' | 'modify' | 'delete';
type Layer = 1 | 2;
type Scalar = string | number | boolean;

interface LibraryReference {
	libraryUuid: string;
	uuid: string;
	name?: string;
}

interface Source {
	kind: 'device' | 'footprint';
	libraryUuid: string;
	uuid: string;
}

interface ComponentState {
	primitiveId: string;
	layer: Layer;
	x: number;
	y: number;
	rotation: number;
	primitiveLock: boolean;
	designator: string | null;
	component: LibraryReference | null;
	footprint: LibraryReference | null;
	addIntoBom: boolean | null;
	name: string | null;
	uniqueId: string | null;
	manufacturer: string | null;
	manufacturerId: string | null;
	supplier: string | null;
	supplierId: string | null;
	otherProperty: Record<string, Scalar>;
}

interface ComponentApi extends Record<string, unknown> {
	getAll: () => Promise<unknown>;
	getAllPrimitiveId: () => Promise<unknown>;
	get: (id: string) => Promise<unknown>;
	create?: (source: { libraryUuid: string; uuid: string; libraryType?: string }, layer: Layer, x: number, y: number, rotation?: number, primitiveLock?: boolean) => Promise<unknown>;
	modify?: (id: string, property: Record<string, unknown>) => Promise<unknown>;
	delete?: (id: string[]) => Promise<unknown>;
}

const SCOPE = 'current_pcb_page';
const NATIVE_RESULT_UNKNOWN = /timed?\s*out|ETIMEDOUT|disconnect|connection\s+(?:closed|lost|reset|aborted)|socket\s+(?:closed|hang up)|transport\s+(?:closed|lost)|websocket.*(?:closed|not open)|ECONNRESET|ECONNABORTED|EPIPE/i;
const NUMERIC_FIELDS = new Set(['x', 'y', 'rotation']);
const BOOLEAN_FIELDS = new Set(['primitiveLock', 'addIntoBom']);
const TEXT_FIELDS = new Set(['designator', 'name', 'uniqueId', 'manufacturer', 'manufacturerId', 'supplier', 'supplierId']);
const EDITABLE_FIELDS = new Set(['layer', ...NUMERIC_FIELDS, ...BOOLEAN_FIELDS, ...TEXT_FIELDS, 'otherProperty']);

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

function layer(value: unknown): Layer {
	if (value !== 1 && value !== 2)
		throw new TypeError('layer must be 1 (top) or 2 (bottom).');
	return value;
}

function optionalText(value: unknown, field: string): string | null {
	if (value === undefined || value === null)
		return null;
	if (typeof value !== 'string')
		throw new TypeError(`${field} must be a string.`);
	return value;
}

function optionalBoolean(value: unknown, field: string): boolean | null {
	if (value === undefined || value === null)
		return null;
	if (typeof value !== 'boolean')
		throw new TypeError(`${field} must be a boolean.`);
	return value;
}

function readState(primitive: unknown, method: string): unknown {
	const getter = (primitive as Record<string, unknown> | null)?.[method];
	if (typeof getter !== 'function')
		throw new TypeError(`EDA PCB component getter ${method} is unavailable.`);
	return getter.call(primitive);
}

function readReference(value: unknown): LibraryReference | null {
	if (value === undefined || value === null)
		return null;
	if (!isPlainObjectRecord(value) || typeof value.libraryUuid !== 'string' || !value.libraryUuid.trim() || typeof value.uuid !== 'string' || !value.uuid.trim())
		return null;
	const reference: LibraryReference = {
		libraryUuid: value.libraryUuid,
		uuid: value.uuid,
	};
	if (typeof value.name === 'string')
		reference.name = value.name;
	return reference;
}

function readOtherProperty(value: unknown): Record<string, Scalar> {
	if (value === undefined || value === null)
		return {};
	if (!isPlainObjectRecord(value))
		throw new TypeError('EDA PCB component otherProperty is not readable.');
	for (const [key, item] of Object.entries(value)) {
		if (typeof item !== 'string' && typeof item !== 'boolean' && (typeof item !== 'number' || !Number.isFinite(item)))
			throw new TypeError(`EDA PCB component otherProperty.${key} is not a scalar.`);
	}
	return { ...value } as Record<string, Scalar>;
}

function readComponent(primitive: unknown): ComponentState {
	const primitiveId = requiredId(readState(primitive, 'getState_PrimitiveId'), 'EDA PCB component primitiveId');
	const primitiveLock = readState(primitive, 'getState_PrimitiveLock');
	if (typeof primitiveLock !== 'boolean')
		throw new TypeError(`EDA PCB component ${primitiveId} has no readable lock state.`);
	return {
		primitiveId,
		layer: layer(readState(primitive, 'getState_Layer')),
		x: finiteNumber(readState(primitive, 'getState_X'), 'EDA PCB component x'),
		y: finiteNumber(readState(primitive, 'getState_Y'), 'EDA PCB component y'),
		rotation: finiteNumber(readState(primitive, 'getState_Rotation'), 'EDA PCB component rotation'),
		primitiveLock,
		designator: optionalText(readState(primitive, 'getState_Designator'), 'designator'),
		component: readReference(readState(primitive, 'getState_Component')),
		footprint: readReference(readState(primitive, 'getState_Footprint')),
		addIntoBom: optionalBoolean(readState(primitive, 'getState_AddIntoBom'), 'addIntoBom'),
		name: optionalText(readState(primitive, 'getState_Name'), 'name'),
		uniqueId: optionalText(readState(primitive, 'getState_UniqueId'), 'uniqueId'),
		manufacturer: optionalText(readState(primitive, 'getState_Manufacturer'), 'manufacturer'),
		manufacturerId: optionalText(readState(primitive, 'getState_ManufacturerId'), 'manufacturerId'),
		supplier: optionalText(readState(primitive, 'getState_Supplier'), 'supplier'),
		supplierId: optionalText(readState(primitive, 'getState_SupplierId'), 'supplierId'),
		otherProperty: readOtherProperty(readState(primitive, 'getState_OtherProperty')),
	};
}

function componentApi(runtime: Record<string, unknown>): ComponentApi {
	const api = runtime.pcb_PrimitiveComponent;
	if (!isPlainObjectRecord(api) || typeof api.getAll !== 'function')
		throw new TypeError('EDA pcb_PrimitiveComponent.getAll is unavailable. Open a PCB first.');
	return api as ComponentApi;
}

async function currentPageUuid(runtime: Record<string, unknown>): Promise<string> {
	const api = runtime.dmt_Pcb;
	if (!isPlainObjectRecord(api) || typeof api.getCurrentPcbInfo !== 'function')
		throw new TypeError('EDA current PCB API is unavailable.');
	const page = await api.getCurrentPcbInfo();
	if (!isPlainObjectRecord(page))
		throw new TypeError('EDA current PCB is unavailable.');
	return requiredId(page.uuid, 'EDA current PCB UUID');
}

async function assertSamePage(runtime: Record<string, unknown>, expected: string): Promise<void> {
	if (await currentPageUuid(runtime) !== expected)
		throw new Error('The active PCB changed during the component operation.');
}

async function readAll(api: ComponentApi): Promise<ComponentState[]> {
	const raw = await api.getAll();
	if (!Array.isArray(raw))
		throw new TypeError('EDA pcb_PrimitiveComponent.getAll() did not return an array.');
	return raw.map(readComponent);
}

async function readAllIds(api: ComponentApi): Promise<string[]> {
	const raw = await api.getAllPrimitiveId();
	if (!Array.isArray(raw) || raw.some(item => typeof item !== 'string' || !item))
		throw new TypeError('EDA pcb_PrimitiveComponent.getAllPrimitiveId() did not return IDs.');
	return raw;
}

function requiredSource(value: unknown): Source {
	if (!isPlainObjectRecord(value) || (value.kind !== 'device' && value.kind !== 'footprint'))
		throw new TypeError('source.kind must be device or footprint.');
	return {
		kind: value.kind,
		libraryUuid: requiredId(value.libraryUuid, 'source.libraryUuid'),
		uuid: requiredId(value.uuid, 'source.uuid'),
	};
}

function requiredProperty(value: unknown): Record<string, unknown> {
	if (!isPlainObjectRecord(value) || Object.keys(value).length === 0)
		throw new TypeError('property must be a non-empty object.');
	for (const [key, item] of Object.entries(value)) {
		if (!EDITABLE_FIELDS.has(key))
			throw new TypeError(`Unsupported PCB component property: ${key}.`);
		if (key === 'layer') {
			layer(item);
		}
		else if (BOOLEAN_FIELDS.has(key)) {
			if (typeof item !== 'boolean')
				throw new TypeError(`${key} must be a boolean.`);
		}
		else if (NUMERIC_FIELDS.has(key)) {
			finiteNumber(item, key);
		}
		else if (TEXT_FIELDS.has(key)) {
			if (item !== null && typeof item !== 'string')
				throw new TypeError(`${key} must be a string or null.`);
		}
		else if (key === 'otherProperty') {
			if (!isPlainObjectRecord(item))
				throw new TypeError('otherProperty must be an object patch.');
			readOtherProperty(item);
		}
	}
	return value;
}

interface FieldMismatch {
	field: string;
	requested: unknown;
	actual: unknown;
	unchanged: boolean;
	requestedField: boolean;
}

function sameField(key: string, actual: unknown, wanted: unknown): boolean {
	if (typeof wanted === 'number' && typeof actual === 'number') {
		const difference = key === 'rotation'
			? ((actual - wanted) % 360 + 540) % 360 - 180
			: actual - wanted;
		return Math.abs(difference) <= 1e-6;
	}
	return actual === wanted;
}

function requestedMismatches(state: ComponentState, requested: Record<string, unknown>, fullOtherProperty?: Record<string, Scalar>, before?: ComponentState): FieldMismatch[] {
	const mismatches: FieldMismatch[] = [];
	for (const [key, wanted] of Object.entries(requested)) {
		if (key === 'otherProperty')
			continue;
		const actual = state[key as keyof ComponentState];
		if (!sameField(key, actual, wanted)) {
			mismatches.push({ field: key, requested: wanted, actual, unchanged: before !== undefined && sameField(key, actual, before[key as keyof ComponentState]), requestedField: true });
		}
	}
	for (const [key, wanted] of Object.entries(fullOtherProperty ?? {})) {
		const actual = state.otherProperty[key];
		if (!Object.hasOwn(state.otherProperty, key) || actual !== wanted) {
			mismatches.push({ field: `otherProperty.${key}`, requested: wanted, actual: actual ?? null, unchanged: before !== undefined && actual === before.otherProperty[key], requestedField: isPlainObjectRecord(requested.otherProperty) && Object.hasOwn(requested.otherProperty, key) });
		}
	}
	return mismatches;
}

function matchesRequested(state: ComponentState, requested: Record<string, unknown>): boolean {
	return requestedMismatches(state, requested).length === 0;
}

function rotationNormalization(state: ComponentState, requested: Record<string, unknown>): Record<string, unknown> {
	return typeof requested.rotation === 'number' && state.rotation !== requested.rotation && sameField('rotation', state.rotation, requested.rotation)
		? { normalization: { rotation: { requested: requested.rotation, actual: state.rotation, mode: 'modulo_360' } } }
		: {};
}

function sourceReference(state: ComponentState, source: Source): LibraryReference | null {
	return source.kind === 'device' ? state.component : state.footprint;
}

function sameReference(actual: LibraryReference | null, wanted: LibraryReference | null): boolean {
	return actual !== null && wanted !== null && actual.libraryUuid === wanted.libraryUuid && actual.uuid === wanted.uuid;
}

function matchesSource(state: ComponentState, source: Source): boolean {
	return sameReference(sourceReference(state, source), source);
}

function createdSourceReference(created: unknown, source: Source): LibraryReference | null {
	const method = source.kind === 'device' ? 'getState_Component' : 'getState_Footprint';
	const getter = (created as Record<string, unknown> | null)?.[method];
	return typeof getter === 'function' ? readReference(getter.call(created)) : null;
}

function creationNormalization(state: ComponentState, source: Source, property: Record<string, unknown>): Record<string, unknown> {
	const result = rotationNormalization(state, property);
	if (matchesSource(state, source))
		return result;
	return {
		normalization: {
			...(result.normalization as Record<string, unknown> | undefined),
			source: {
				kind: source.kind,
				requested: { libraryUuid: source.libraryUuid, uuid: source.uuid },
				actual: { ...sourceReference(state, source)! },
				mode: 'native_create_reference',
			},
		},
	};
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

export async function handlePcbComponentEditTask(payload: unknown): Promise<unknown> {
	if (!isPlainObjectRecord(payload))
		throw new TypeError('pcb_component_edit payload must be an object.');
	const action = payload.action as Action;
	if (action !== 'read' && action !== 'create' && action !== 'modify' && action !== 'delete')
		throw new TypeError('action must be read, create, modify, or delete.');
	const primitiveId = action === 'modify' || action === 'delete' ? requiredId(payload.primitiveId, 'primitiveId') : undefined;
	const source = action === 'create' ? requiredSource(payload.source) : undefined;
	const requested = action === 'modify' ? requiredProperty(payload.property) : undefined;
	const createProperty = action === 'create'
		? {
				layer: layer(payload.layer),
				x: finiteNumber(payload.x, 'x'),
				y: finiteNumber(payload.y, 'y'),
				...(payload.rotation === undefined ? {} : { rotation: finiteNumber(payload.rotation, 'rotation') }),
				...(payload.primitiveLock === undefined
					? {}
					: (() => {
							if (typeof payload.primitiveLock !== 'boolean')
								throw new TypeError('primitiveLock must be a boolean.');
							return { primitiveLock: payload.primitiveLock };
						})()),
			}
		: undefined;
	const runtime = getEdaRuntime();
	if (!runtime)
		throw new TypeError('EDA runtime is unavailable.');
	const api = componentApi(runtime);
	if (action !== 'read' && (typeof api.getAllPrimitiveId !== 'function' || typeof api.get !== 'function'))
		throw new TypeError('EDA pcb_PrimitiveComponent.getAllPrimitiveId/get is unavailable.');
	if (action === 'create' && typeof api.create !== 'function')
		throw new TypeError('EDA pcb_PrimitiveComponent.create is unavailable.');
	if (action === 'modify' && typeof api.modify !== 'function')
		throw new TypeError('EDA pcb_PrimitiveComponent.modify is unavailable.');
	if (action === 'delete' && typeof api.delete !== 'function')
		throw new TypeError('EDA pcb_PrimitiveComponent.delete is unavailable.');
	const pageUuid = await currentPageUuid(runtime);
	if (action === 'read') {
		const components = preserveBoundedArray(await readAll(api));
		await assertSamePage(runtime, pageUuid);
		return { ok: true, action, scope: SCOPE, complete: true, pageUuid, componentCount: components.length, components };
	}
	const ids = await readAllIds(api);
	await assertSamePage(runtime, pageUuid);
	if (action === 'create') {
		const beforeComponentIds = preserveBoundedArray(ids);
		const context = { pageUuid, source, beforeComponentIds };
		const nativeSource = source!.kind === 'footprint'
			? { libraryType: '4', libraryUuid: source!.libraryUuid, uuid: source!.uuid }
			: { libraryUuid: source!.libraryUuid, uuid: source!.uuid };
		let created: unknown;
		await assertSamePage(runtime, pageUuid);
		try {
			created = await api.create!.call(api, nativeSource, createProperty!.layer, createProperty!.x, createProperty!.y, createProperty!.rotation, createProperty!.primitiveLock);
		}
		catch (error: unknown) {
			return unknownNativeWrite(action, error, context);
		}
		let after: ComponentState | undefined;
		let createdId: string | undefined;
		try {
			await assertSamePage(runtime, pageUuid);
			createdId = created == null ? undefined : requiredId(readState(created, 'getState_PrimitiveId'), 'EDA created PCB component primitiveId');
			const returnedSource = createdSourceReference(created, source!);
			if (!createdId) {
				const afterIds = await readAllIds(api);
				const delta = afterIds.filter(id => !ids.includes(id));
				if (delta.length !== 1)
					throw new Error('EDA did not identify exactly one newly created PCB component.');
				createdId = delta[0];
			}
			if (ids.includes(createdId))
				throw new Error('EDA create returned an existing PCB component ID.');
			const observed = await api.get(createdId);
			if (observed === undefined || observed === null)
				throw new Error('EDA created PCB component was not readable.');
			after = readComponent(observed);
			await assertSamePage(runtime, pageUuid);
			// 原生 create 可将器件/封装复制进工程库；以创建返回的引用和同 ID 回读确认实际来源。
			const sourceVerified = matchesSource(after, source!) || sameReference(sourceReference(after, source!), returnedSource);
			if (after.primitiveId !== createdId || !sourceVerified || !matchesRequested(after, createProperty!))
				throw new Error('EDA created PCB component differs from the requested source or placement.');
			return { ok: true, action, scope: SCOPE, pageUuid, primitiveId: createdId, verified: true, after, ...creationNormalization(after, source!, createProperty!) };
		}
		catch (error: unknown) {
			return unknownAfterWrite(action, error, { ...context, ...(createdId ? { primitiveId: createdId } : {}), ...(after ? { after } : {}) });
		}
	}
	if (!ids.includes(primitiveId!))
		return { ok: false, action, scope: SCOPE, pageUuid, primitiveId, reason: 'component_not_found' };
	const target = await api.get(primitiveId!);
	await assertSamePage(runtime, pageUuid);
	if (target === undefined || target === null)
		return { ok: false, action, scope: SCOPE, pageUuid, primitiveId, reason: 'component_not_found' };
	const before = readComponent(target);
	if (before.primitiveId !== primitiveId)
		throw new TypeError('EDA PCB component ID changed between current-page lookup and target read.');
	const context = { pageUuid, primitiveId, before };
	await assertSamePage(runtime, pageUuid);
	if (action === 'modify') {
		const fullOtherProperty = { ...before.otherProperty, ...(requested!.otherProperty as Record<string, Scalar> | undefined) };
		const update = { ...requested!, otherProperty: { ...fullOtherProperty } };
		try {
			await api.modify!.call(api, primitiveId!, update);
		}
		catch (error: unknown) {
			return unknownNativeWrite(action, error, context);
		}
		let after: ComponentState | undefined;
		try {
			await assertSamePage(runtime, pageUuid);
			const observed = await api.get(primitiveId!);
			if (observed === undefined || observed === null)
				throw new Error('EDA modified PCB component was not readable.');
			after = readComponent(observed);
			await assertSamePage(runtime, pageUuid);
			const mismatches = requestedMismatches(after, requested!, fullOtherProperty, before);
			if (after.primitiveId !== primitiveId)
				mismatches.unshift({ field: 'primitiveId', requested: primitiveId, actual: after.primitiveId, unchanged: false, requestedField: false });
			if (mismatches.length) {
				return unknownAfterWrite(action, 'EDA PCB component state differs from the requested modification.', {
					...context,
					after,
					failureKind: 'state_mismatch',
					mismatches: preserveBoundedArray(mismatches.slice(0, 64)),
					mismatchCount: mismatches.length,
					mismatchesComplete: mismatches.length <= 64,
				});
			}
			return { ok: true, action, scope: SCOPE, pageUuid, primitiveId, verified: true, before, after, ...rotationNormalization(after, requested!) };
		}
		catch (error: unknown) {
			return unknownAfterWrite(action, error, { ...context, ...(after ? { after } : {}) });
		}
	}
	try {
		await api.delete!.call(api, [primitiveId!]);
	}
	catch (error: unknown) {
		return unknownNativeWrite(action, error, context);
	}
	try {
		await assertSamePage(runtime, pageUuid);
		const afterIds = await readAllIds(api);
		await assertSamePage(runtime, pageUuid);
		if (afterIds.includes(primitiveId!))
			throw new Error('EDA PCB component remains after delete.');
		return { ok: true, action, scope: SCOPE, pageUuid, primitiveId, deleted: true, verified: true, before };
	}
	catch (error: unknown) {
		return unknownAfterWrite(action, error, context);
	}
}
