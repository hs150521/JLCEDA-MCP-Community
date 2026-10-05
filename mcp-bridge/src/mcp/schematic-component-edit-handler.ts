import { getEdaRuntime, isPlainObjectRecord, preserveBoundedArray, toSafeErrorMessage } from '../utils.ts';
import { readNativeWireSegments } from './schematic-native-wire-segments.ts';
import { handleSchematicReadTask } from './schematic-read-handler.ts';

type Action = 'read' | 'modify' | 'delete';
type PropertyValue = string | number | boolean;
type Property = Record<string, PropertyValue>;

interface ComponentState {
	primitiveId: string;
	type: 'part';
	x: number;
	y: number;
	rotation: number;
	mirror: boolean;
	designator: string | null;
	name: string | null;
	uniqueId: string | null;
	addIntoBom: boolean | null;
	addIntoPcb: boolean | null;
	manufacturer: string | null;
	manufacturerId: string | null;
	supplier: string | null;
	supplierId: string | null;
	otherProperty: Property;
}

interface PinNetwork {
	pinNumber: string;
	connectedNetworkName: string;
	unnamedWireGroups: string[];
}

interface Point { x: number; y: number }
interface Segment { start: Point; end: Point }

interface ComponentApi extends Record<string, unknown> {
	getAll: (type: string, allPages: boolean) => Promise<unknown>;
	getAllPrimitiveId?: (type: string, allPages: boolean) => Promise<unknown>;
	getAllPinsByPrimitiveId?: (id: string) => Promise<unknown>;
	modify?: (id: string, property: Record<string, unknown>) => Promise<unknown>;
	delete?: (component: unknown) => Promise<unknown>;
}

const SCOPE = 'current_schematic_page';
const NUMERIC_FIELDS = ['x', 'y', 'rotation'] as const;
const BOOLEAN_FIELDS = ['mirror', 'addIntoBom', 'addIntoPcb'] as const;
const TEXT_FIELDS = ['designator', 'name', 'uniqueId', 'manufacturer', 'manufacturerId', 'supplier', 'supplierId'] as const;
const EDITABLE_FIELDS = new Set<string>([...NUMERIC_FIELDS, ...BOOLEAN_FIELDS, ...TEXT_FIELDS, 'otherProperty']);
const NATIVE_RESULT_UNKNOWN = /timed?\s*out|ETIMEDOUT|disconnect|connection\s+(?:closed|lost|reset|aborted)|socket\s+(?:closed|hang up)|transport\s+(?:closed|lost)|websocket.*(?:closed|not open)|ECONNRESET|ECONNABORTED|EPIPE/i;
const COORDINATE_EPSILON = 1e-6;

function requiredId(value: unknown): string {
	if (typeof value !== 'string' || !value.trim())
		throw new TypeError('primitiveId must be a non-empty string.');
	return value.trim();
}

function readState(primitive: unknown, method: string): unknown {
	const getter = (primitive as Record<string, unknown> | null)?.[method];
	if (typeof getter !== 'function')
		throw new TypeError(`EDA component state getter ${method} is unavailable.`);
	return getter.call(primitive);
}

function requiredFinite(value: unknown, field: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value))
		throw new TypeError(`EDA component ${field} must be a finite number.`);
	return value;
}

function optionalText(value: unknown, field: string): string | null {
	if (value === undefined || value === null)
		return null;
	if (typeof value !== 'string')
		throw new TypeError(`EDA component ${field} must be a string.`);
	return value;
}

function optionalBoolean(value: unknown, field: string): boolean | null {
	if (value === undefined || value === null)
		return null;
	if (typeof value !== 'boolean')
		throw new TypeError(`EDA component ${field} must be a boolean.`);
	return value;
}

function readOtherProperty(value: unknown): Property {
	if (value === undefined)
		return {};
	if (!isPlainObjectRecord(value))
		throw new TypeError('EDA component otherProperty is not readable.');
	for (const [key, item] of Object.entries(value)) {
		if (typeof item !== 'string' && typeof item !== 'boolean' && (typeof item !== 'number' || !Number.isFinite(item)))
			throw new TypeError(`EDA component otherProperty.${key} is not a string, finite number, or boolean.`);
	}
	return { ...value } as Property;
}

function readComponent(primitive: unknown): ComponentState {
	const primitiveId = requiredId(readState(primitive, 'getState_PrimitiveId'));
	const type = readState(primitive, 'getState_ComponentType');
	if (type !== 'part')
		throw new TypeError(`EDA component ${primitiveId} is not an ordinary schematic part.`);
	const mirror = readState(primitive, 'getState_Mirror');
	if (typeof mirror !== 'boolean')
		throw new TypeError(`EDA component ${primitiveId} has no readable mirror state.`);
	return {
		primitiveId,
		type,
		x: requiredFinite(readState(primitive, 'getState_X'), 'x'),
		y: requiredFinite(readState(primitive, 'getState_Y'), 'y'),
		rotation: requiredFinite(readState(primitive, 'getState_Rotation'), 'rotation'),
		mirror,
		designator: optionalText(readState(primitive, 'getState_Designator'), 'designator'),
		name: optionalText(readState(primitive, 'getState_Name'), 'name'),
		uniqueId: optionalText(readState(primitive, 'getState_UniqueId'), 'uniqueId'),
		addIntoBom: optionalBoolean(readState(primitive, 'getState_AddIntoBom'), 'addIntoBom'),
		addIntoPcb: optionalBoolean(readState(primitive, 'getState_AddIntoPcb'), 'addIntoPcb'),
		manufacturer: optionalText(readState(primitive, 'getState_Manufacturer'), 'manufacturer'),
		manufacturerId: optionalText(readState(primitive, 'getState_ManufacturerId'), 'manufacturerId'),
		supplier: optionalText(readState(primitive, 'getState_Supplier'), 'supplier'),
		supplierId: optionalText(readState(primitive, 'getState_SupplierId'), 'supplierId'),
		otherProperty: readOtherProperty(readState(primitive, 'getState_OtherProperty')),
	};
}

function componentApi(runtime: Record<string, unknown>): ComponentApi {
	const api = runtime.sch_PrimitiveComponent;
	if (!isPlainObjectRecord(api) || typeof api.getAll !== 'function')
		throw new TypeError('EDA sch_PrimitiveComponent.getAll is unavailable. Open a schematic page first.');
	return api as ComponentApi;
}

async function currentPageUuid(runtime: Record<string, unknown>): Promise<string> {
	const schematic = runtime.dmt_Schematic;
	const select = runtime.dmt_SelectControl;
	if (!isPlainObjectRecord(schematic) || typeof schematic.getCurrentSchematicPageInfo !== 'function'
		|| !isPlainObjectRecord(select) || typeof select.getCurrentDocumentInfo !== 'function') {
		throw new TypeError('EDA current schematic page and editor document APIs are unavailable.');
	}
	const [page, document] = await Promise.all([schematic.getCurrentSchematicPageInfo(), select.getCurrentDocumentInfo()]);
	if (!isPlainObjectRecord(page) || !isPlainObjectRecord(document)
		|| typeof page.uuid !== 'string' || !page.uuid.trim() || page.uuid !== document.uuid) {
		throw new TypeError('EDA current schematic page and editor document are not synchronized.');
	}
	return page.uuid.trim();
}

async function assertSamePage(runtime: Record<string, unknown>, expected: string): Promise<void> {
	if (await currentPageUuid(runtime) !== expected)
		throw new Error('The active schematic page changed during the component operation.');
}

async function readCurrentPartEntries(api: ComponentApi): Promise<Array<{ primitive: unknown; state: ComponentState }>> {
	const raw = await api.getAll('part', false);
	if (!Array.isArray(raw))
		throw new TypeError('EDA sch_PrimitiveComponent.getAll(part, false) did not return an array.');
	return raw.map(primitive => ({ primitive, state: readComponent(primitive) }));
}

async function readCurrentParts(api: ComponentApi): Promise<ComponentState[]> {
	return (await readCurrentPartEntries(api)).map(entry => entry.state);
}

async function readCurrentPartIds(api: ComponentApi): Promise<string[]> {
	const raw = await api.getAllPrimitiveId!.call(api, 'part', false);
	if (!Array.isArray(raw) || raw.some(id => typeof id !== 'string' || !id) || new Set(raw).size !== raw.length)
		throw new TypeError('EDA sch_PrimitiveComponent.getAllPrimitiveId(part, false) did not return component IDs.');
	return raw;
}

function assertCurrentPartEntries(entries: Array<{ state: ComponentState }>, ids: string[]): void {
	const currentIds = new Set(ids);
	const objectIds = entries.map(entry => entry.state.primitiveId);
	if (objectIds.length !== ids.length || new Set(objectIds).size !== objectIds.length
		|| objectIds.some(id => !currentIds.has(id))) {
		throw new Error('Current-page component objects and IDs do not match; retry after page load.');
	}
}

function requiredProperty(value: unknown): Record<string, unknown> {
	if (!isPlainObjectRecord(value) || Object.keys(value).length === 0)
		throw new TypeError('property must be a non-empty object.');
	for (const [key, item] of Object.entries(value)) {
		if (!EDITABLE_FIELDS.has(key))
			throw new TypeError(`Unsupported component property: ${key}.`);
		if (NUMERIC_FIELDS.includes(key as typeof NUMERIC_FIELDS[number])) {
			if (typeof item !== 'number' || !Number.isFinite(item))
				throw new TypeError(`${key} must be a finite number.`);
		}
		else if (BOOLEAN_FIELDS.includes(key as typeof BOOLEAN_FIELDS[number])) {
			if (typeof item !== 'boolean')
				throw new TypeError(`${key} must be a boolean.`);
		}
		else if (key === 'otherProperty') {
			readOtherProperty(item);
		}
		else if (item !== null && typeof item !== 'string') {
			throw new TypeError(`${key} must be a string or null.`);
		}
	}
	return value;
}

function requestedValuesMatch(after: ComponentState, requested: Record<string, unknown>, fullOtherProperty: Property): boolean {
	for (const [key, expected] of Object.entries(requested)) {
		if (key === 'otherProperty')
			continue;
		const actual = after[key as keyof ComponentState];
		if (typeof expected === 'number' && typeof actual === 'number') {
			if (Math.abs(actual - expected) > 1e-6)
				return false;
		}
		else if (actual !== expected) {
			return false;
		}
	}
	return Object.entries(fullOtherProperty).every(([key, value]) => Object.hasOwn(after.otherProperty, key) && after.otherProperty[key] === value);
}

function wireSegments(line: unknown): Segment[] {
	const nativeSegments = readNativeWireSegments(line);
	if (nativeSegments === null)
		throw new TypeError('EDA wire geometry is incomplete.');
	return nativeSegments.flatMap(([x1, y1, x2, y2]) => x1 === x2 && y1 === y2
		? []
		: [{ start: { x: x1, y: y1 }, end: { x: x2, y: y2 } }]);
}

function pointOnSegment(point: Point, segment: Segment): boolean {
	const { start, end } = segment;
	const cross = (end.x - start.x) * (point.y - start.y) - (end.y - start.y) * (point.x - start.x);
	return Math.abs(cross) <= COORDINATE_EPSILON * Math.hypot(end.x - start.x, end.y - start.y)
		&& point.x >= Math.min(start.x, end.x) - COORDINATE_EPSILON
		&& point.x <= Math.max(start.x, end.x) + COORDINATE_EPSILON
		&& point.y >= Math.min(start.y, end.y) - COORDINATE_EPSILON
		&& point.y <= Math.max(start.y, end.y) + COORDINATE_EPSILON;
}

function segmentsConnect(first: Segment, second: Segment): boolean {
	return pointOnSegment(first.start, second) || pointOnSegment(first.end, second)
		|| pointOnSegment(second.start, first) || pointOnSegment(second.end, first);
}

async function readUnnamedWireGroups(runtime: Record<string, unknown>, primitiveId: string, pinNumbers: string[]): Promise<string[][]> {
	const components = componentApi(runtime);
	const wireApi = runtime.sch_PrimitiveWire;
	if (typeof components.getAllPinsByPrimitiveId !== 'function' || !isPlainObjectRecord(wireApi) || typeof wireApi.getAll !== 'function')
		throw new TypeError('EDA pin or wire readback API is unavailable.');
	const [rawPins, rawWires] = await Promise.all([
		components.getAllPinsByPrimitiveId(primitiveId),
		wireApi.getAll(),
	]);
	if (!Array.isArray(rawPins) || !Array.isArray(rawWires))
		throw new TypeError('EDA pin or wire readback did not return an array.');
	if (rawPins.length !== pinNumbers.length || rawPins.some((pin, index) => readState(pin, 'getState_PinNumber') !== pinNumbers[index]))
		throw new Error('EDA pin list changed during the connectivity readback.');
	const pinPoints: Point[] = rawPins.map(pin => ({
		x: requiredFinite(readState(pin, 'getState_X'), 'pin x'),
		y: requiredFinite(readState(pin, 'getState_Y'), 'pin y'),
	}));
	const wires = rawWires.filter(wire => !readState(wire, 'getState_Net')).map(wire => ({
		id: requiredId(readState(wire, 'getState_PrimitiveId')),
		segments: wireSegments(readState(wire, 'getState_Line')),
	}));
	const groupByWire = new Map<number, string>();
	const connectedGroupId = (first: number): string => {
		const cached = groupByWire.get(first);
		if (cached)
			return cached;
		const visited = new Set<number>([first]);
		const queue = [first];
		for (let head = 0; head < queue.length; head += 1) {
			const current = wires[queue[head]];
			for (let index = 0; index < wires.length; index += 1) {
				if (!visited.has(index) && current.segments.some(a => wires[index].segments.some(b => segmentsConnect(a, b)))) {
					visited.add(index);
					queue.push(index);
				}
			}
		}
		const id = queue.map(index => wires[index].id).sort()[0];
		for (const index of queue)
			groupByWire.set(index, id);
		return id;
	};
	return pinPoints.map(point => [...new Set(wires.flatMap((wire, index) =>
		wire.segments.some(segment => pointOnSegment(point, segment)) ? [connectedGroupId(index)] : []))].sort());
}

async function readPinNetworks(runtime: Record<string, unknown>, primitiveId: string, pageUuid: string): Promise<PinNetwork[]> {
	const response = await handleSchematicReadTask({});
	if (!isPlainObjectRecord(response) || response.ok !== true || response.pageUuid !== pageUuid || typeof response.schematicCircuitSnapshot !== 'string')
		throw new Error(`Cannot verify component pin networks: ${isPlainObjectRecord(response) ? String(response.error ?? 'schematic_read failed') : 'schematic_read failed'}`);
	const snapshot: unknown = JSON.parse(response.schematicCircuitSnapshot);
	const components = isPlainObjectRecord(snapshot) ? snapshot.components : undefined;
	const component = Array.isArray(components) ? components.find(item => isPlainObjectRecord(item) && item.componentInstanceId === primitiveId) : undefined;
	if (!isPlainObjectRecord(component) || !Array.isArray(component.pins))
		throw new Error(`Cannot verify component ${primitiveId} pin networks from schematic_read.`);
	const pins: PinNetwork[] = component.pins.map((pin: unknown) => {
		if (!isPlainObjectRecord(pin) || typeof pin.pinNumber !== 'string' || typeof pin.connectedNetworkName !== 'string')
			throw new Error(`Cannot verify component ${primitiveId} pin network state.`);
		return { pinNumber: pin.pinNumber, connectedNetworkName: pin.connectedNetworkName, unnamedWireGroups: [] };
	});
	if (pins.some(pin => pin.connectedNetworkName === '')) {
		const groups = await readUnnamedWireGroups(runtime, primitiveId, pins.map(pin => pin.pinNumber));
		for (let index = 0; index < pins.length; index += 1)
			pins[index].unnamedWireGroups = groups[index];
	}
	return pins.sort((a, b) => a.pinNumber.localeCompare(b.pinNumber));
}

function pinNetworkChanges(before: PinNetwork[], after: PinNetwork[]): Array<{ pinNumber: string; before: string; after: string; beforeWireGroups?: string[]; afterWireGroups?: string[] }> {
	if (before.length !== after.length || before.some((pin, index) => pin.pinNumber !== after[index].pinNumber))
		throw new Error('Component pin list changed during the move.');
	return before.flatMap((pin, index) => {
		const next = after[index];
		if (pin.connectedNetworkName !== next.connectedNetworkName)
			return [{ pinNumber: pin.pinNumber, before: pin.connectedNetworkName, after: next.connectedNetworkName }];
		if (pin.connectedNetworkName === '' && JSON.stringify(pin.unnamedWireGroups) !== JSON.stringify(next.unnamedWireGroups))
			return [{ pinNumber: pin.pinNumber, before: '', after: '', beforeWireGroups: pin.unnamedWireGroups, afterWireGroups: next.unnamedWireGroups }];
		return [];
	});
}

function unknownAfterWrite(action: 'modify' | 'delete', primitiveId: string, error: unknown, before: ComponentState): Record<string, unknown> {
	return {
		ok: false,
		action,
		scope: SCOPE,
		primitiveId,
		before,
		reason: 'post_write_readback_failed',
		error: toSafeErrorMessage(error),
		commitUnknown: true,
		readbackRequired: true,
		nativeCallSettled: true,
	};
}

function unknownNativeWrite(action: 'modify' | 'delete', primitiveId: string, error: unknown, before: ComponentState): Record<string, unknown> {
	const message = toSafeErrorMessage(error);
	if (!NATIVE_RESULT_UNKNOWN.test(message))
		throw error;
	return {
		ok: false,
		action,
		scope: SCOPE,
		primitiveId,
		before,
		reason: 'native_call_result_unknown',
		error: message,
		commitUnknown: true,
		readbackRequired: true,
		nativeCallSettled: false,
	};
}

export async function handleSchematicComponentEditTask(payload: unknown): Promise<unknown> {
	if (!isPlainObjectRecord(payload))
		throw new TypeError('schematic_component_edit payload must be an object.');
	const action = payload.action as Action;
	if (action !== 'read' && action !== 'modify' && action !== 'delete')
		throw new TypeError('action must be read, modify, or delete.');
	if (action === 'read' && payload.primitiveId !== undefined)
		throw new TypeError('read returns all ordinary components on the current schematic page; primitiveId is unsupported.');
	const primitiveId = action === 'read' ? undefined : requiredId(payload.primitiveId);
	const property = action === 'modify' ? requiredProperty(payload.property) : undefined;
	const runtime = getEdaRuntime();
	if (!runtime)
		throw new TypeError('EDA runtime is unavailable.');
	const api = componentApi(runtime);
	if (action !== 'read' && typeof api.getAllPrimitiveId !== 'function')
		throw new TypeError('EDA sch_PrimitiveComponent.getAllPrimitiveId is unavailable.');
	if (action === 'modify' && typeof api.modify !== 'function')
		throw new TypeError('EDA sch_PrimitiveComponent.modify is unavailable.');
	if (action === 'delete' && typeof api.delete !== 'function')
		throw new TypeError('EDA sch_PrimitiveComponent.delete is unavailable.');
	const pageUuid = await currentPageUuid(runtime);
	if (action === 'read') {
		const parts = await readCurrentParts(api);
		await assertSamePage(runtime, pageUuid);
		const components = preserveBoundedArray(parts);
		return { ok: true, action, scope: SCOPE, complete: true, pageUuid, componentCount: components.length, components };
	}
	const ids = await readCurrentPartIds(api);
	await assertSamePage(runtime, pageUuid);
	if (!ids.includes(primitiveId!))
		return { ok: false, action, scope: SCOPE, pageUuid, primitiveId, reason: 'component_not_found' };
	const entries = await readCurrentPartEntries(api);
	await assertSamePage(runtime, pageUuid);
	assertCurrentPartEntries(entries, ids);
	const targetEntry = entries.find(entry => entry.state.primitiveId === primitiveId)!;
	const target = targetEntry.primitive;
	const before = targetEntry.state;
	if (action === 'modify') {
		const fullOtherProperty = { ...before.otherProperty, ...(property!.otherProperty as Property | undefined) };
		const update = { ...property!, otherProperty: fullOtherProperty };
		const changesGeometry = ['x', 'y', 'rotation', 'mirror'].some(field => Object.hasOwn(property!, field)
			&& property![field] !== before[field as keyof ComponentState]);
		const beforePinNetworks = changesGeometry ? await readPinNetworks(runtime, primitiveId!, pageUuid) : undefined;
		await assertSamePage(runtime, pageUuid);
		try {
			await api.modify!.call(api, primitiveId!, update);
		}
		catch (error: unknown) {
			return unknownNativeWrite(action, primitiveId!, error, before);
		}
		try {
			await assertSamePage(runtime, pageUuid);
			const afterIds = await readCurrentPartIds(api);
			const afterEntries = await readCurrentPartEntries(api);
			await assertSamePage(runtime, pageUuid);
			assertCurrentPartEntries(afterEntries, afterIds);
			const after = afterEntries.find(entry => entry.state.primitiveId === primitiveId)?.state;
			if (!after || after.primitiveId !== primitiveId || !requestedValuesMatch(after, property!, fullOtherProperty))
				throw new Error('EDA component state differs from the requested modification.');
			if (beforePinNetworks) {
				const afterPinNetworks = await readPinNetworks(runtime, primitiveId!, pageUuid);
				await assertSamePage(runtime, pageUuid);
				const changes = pinNetworkChanges(beforePinNetworks, afterPinNetworks);
				if (changes.length > 0)
					return { ok: false, action, scope: SCOPE, pageUuid, primitiveId, reason: 'pin_network_changed', committed: true, verified: false, commitUnknown: true, readbackRequired: true, nativeCallSettled: true, before, after, pinNetworkChanges: changes };
			}
			return { ok: true, action, scope: SCOPE, pageUuid, primitiveId, verified: true, before, after };
		}
		catch (error: unknown) {
			return unknownAfterWrite(action, primitiveId!, error, before);
		}
	}
	await assertSamePage(runtime, pageUuid);
	try {
		await api.delete!.call(api, target);
	}
	catch (error: unknown) {
		return unknownNativeWrite(action, primitiveId!, error, before);
	}
	try {
		await assertSamePage(runtime, pageUuid);
		const afterIds = await readCurrentPartIds(api);
		const afterEntries = await readCurrentPartEntries(api);
		await assertSamePage(runtime, pageUuid);
		assertCurrentPartEntries(afterEntries, afterIds);
		if (afterIds.includes(primitiveId!))
			throw new Error('EDA component remains on the current schematic page after delete.');
		return { ok: true, action, scope: SCOPE, pageUuid, primitiveId, deleted: true, verified: true, before };
	}
	catch (error: unknown) {
		return unknownAfterWrite(action, primitiveId!, error, before);
	}
}
