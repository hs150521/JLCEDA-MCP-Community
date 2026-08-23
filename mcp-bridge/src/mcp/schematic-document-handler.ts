import { getEdaRuntime, isPlainObjectRecord, preserveBoundedArray, toSerializableAsync } from '../utils.ts';

type SchematicDocumentAction = 'status' | 'filter_configuration' | 'selection' | 'mouse_position' | 'primitive_at_point' | 'primitives_in_region' | 'navigate_to_coordinates' | 'navigate_to_region' | 'save' | 'import_changes' | 'select_primitives' | 'clear_selection' | 'primitive_type_by_id' | 'primitive_by_id' | 'primitives_by_id' | 'primitives_bbox';

const MAX_INSPECT_ITEMS = 500;

interface SchematicDocumentApi {
	save?: () => Promise<unknown>;
	importChanges?: () => Promise<unknown>;
	navigateToCoordinates?: (x: number, y: number) => Promise<unknown>;
	navigateToRegion?: (left: number, right: number, top: number, bottom: number) => Promise<unknown>;
	getPrimitiveAtPoint?: (x: number, y: number) => unknown;
	getPrimitivesInRegion?: (left: number, right: number, top: number, bottom: number) => unknown;
	getCurrentFilterConfiguration?: () => Promise<unknown>;
}

interface SchematicSelectControlApi {
	getAllSelectedPrimitives_PrimitiveId?: () => Promise<unknown>;
	getAllSelectedPrimitives?: () => Promise<unknown>;
	getCurrentMousePosition?: () => Promise<unknown>;
	doSelectPrimitives?: (primitiveIds: string | string[]) => Promise<unknown>;
	clearSelected?: () => unknown;
}

interface SchematicPrimitiveApi {
	getPrimitiveTypeByPrimitiveId?: (id: string) => Promise<unknown>;
	getPrimitiveByPrimitiveId?: (id: string) => Promise<unknown>;
	getPrimitivesByPrimitiveId?: (ids: string[]) => Promise<unknown>;
	getPrimitivesBBox?: (ids: string[]) => Promise<unknown>;
}

function getEdaRecord(): Record<string, unknown> {
	const eda = getEdaRuntime();
	if (!isPlainObjectRecord(eda))
		throw new TypeError('EDA runtime is unavailable.');
	return eda;
}

function getApi<T>(eda: Record<string, unknown>, name: string): T {
	const api = eda[name];
	if (!isPlainObjectRecord(api))
		throw new TypeError(`EDA ${name} API is unavailable in this client version.`);
	return api as T;
}

function requiredAction(value: unknown): SchematicDocumentAction {
	const actions: SchematicDocumentAction[] = ['status', 'filter_configuration', 'selection', 'mouse_position', 'primitive_at_point', 'primitives_in_region', 'navigate_to_coordinates', 'navigate_to_region', 'save', 'import_changes', 'select_primitives', 'clear_selection', 'primitive_type_by_id', 'primitive_by_id', 'primitives_by_id', 'primitives_bbox'];
	if (typeof value !== 'string' || !actions.includes(value as SchematicDocumentAction))
		throw new TypeError('action is not supported by schematic_document_action.');
	return value as SchematicDocumentAction;
}

function requiredFiniteNumber(input: Record<string, unknown>, key: string): number {
	const value = input[key];
	if (typeof value !== 'number' || !Number.isFinite(value))
		throw new TypeError(`${key} must be a finite number.`);
	return value;
}

function requiredId(input: Record<string, unknown>, key: string): string {
	const value = input[key];
	if (typeof value !== 'string' || value.trim().length === 0)
		throw new TypeError(`${key} must be a non-empty string.`);
	return value.trim();
}

function requiredIds(input: Record<string, unknown>): string[] {
	const value = input.ids;
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_INSPECT_ITEMS || value.some(id => typeof id !== 'string' || id.trim().length === 0))
		throw new TypeError(`ids must contain between 1 and ${String(MAX_INSPECT_ITEMS)} non-empty strings.`);
	return value.map(id => (id as string).trim());
}

function inspectLimit(input: Record<string, unknown>): number {
	if (input.limit === undefined)
		return 120;
	if (typeof input.limit !== 'number' || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_INSPECT_ITEMS)
		throw new RangeError(`limit must be an integer between 1 and ${String(MAX_INSPECT_ITEMS)}.`);
	return input.limit;
}

async function serializeArray(values: unknown[], limit: number): Promise<unknown[]> {
	return preserveBoundedArray(await Promise.all(values.slice(0, limit).map(value => toSerializableAsync(value))));
}

export async function handleSchematicDocumentTask(payload: unknown): Promise<unknown> {
	if (!isPlainObjectRecord(payload))
		throw new TypeError('schematic_document_action payload must be an object.');
	const action = requiredAction(payload.action === undefined ? 'status' : payload.action);
	const eda = getEdaRecord();
	const document = getApi<SchematicDocumentApi>(eda, 'sch_Document');

	if (action === 'status' || action === 'filter_configuration') {
		if (typeof document.getCurrentFilterConfiguration !== 'function')
			throw new TypeError('EDA sch_Document.getCurrentFilterConfiguration API is unavailable in this client version.');
		const filterConfiguration = await document.getCurrentFilterConfiguration();
		return { ok: true, action, filterConfiguration: await toSerializableAsync(filterConfiguration) };
	}

	if (action === 'selection') {
		const select = getApi<SchematicSelectControlApi>(eda, 'sch_SelectControl');
		if (typeof select.getAllSelectedPrimitives_PrimitiveId !== 'function')
			throw new TypeError('EDA sch_SelectControl selection APIs are unavailable in this client version.');
		const rawIds = await select.getAllSelectedPrimitives_PrimitiveId();
		const ids = Array.isArray(rawIds) ? rawIds : [];
		const limit = inspectLimit(payload);
		const includeObjects = payload.includeObjects === undefined ? false : payload.includeObjects;
		if (typeof includeObjects !== 'boolean')
			throw new TypeError('includeObjects must be a boolean.');
		const result: Record<string, unknown> = {
			ok: true,
			action,
			selectedCount: ids.length,
			returned: Math.min(ids.length, limit),
			truncated: ids.length > limit,
			selectedPrimitiveIds: await serializeArray(ids, limit),
		};
		if (includeObjects) {
			if (typeof select.getAllSelectedPrimitives !== 'function')
				throw new TypeError('EDA sch_SelectControl.getAllSelectedPrimitives API is unavailable in this client version.');
			const rawObjects = await select.getAllSelectedPrimitives();
			const objects = Array.isArray(rawObjects) ? rawObjects : [];
			result.selectedPrimitives = await serializeArray(objects, limit);
			result.objectsTruncated = objects.length > limit;
		}
		return result;
	}

	if (action === 'mouse_position') {
		const select = getApi<SchematicSelectControlApi>(eda, 'sch_SelectControl');
		if (typeof select.getCurrentMousePosition !== 'function')
			throw new TypeError('EDA sch_SelectControl.getCurrentMousePosition API is unavailable in this client version.');
		return { ok: true, action, position: await toSerializableAsync(await select.getCurrentMousePosition()) };
	}

	if (action === 'primitive_at_point') {
		if (typeof document.getPrimitiveAtPoint !== 'function')
			throw new TypeError('EDA sch_Document.getPrimitiveAtPoint API is unavailable in this client version.');
		const x = requiredFiniteNumber(payload, 'x');
		const y = requiredFiniteNumber(payload, 'y');
		return { ok: true, action, x, y, primitive: await toSerializableAsync(await document.getPrimitiveAtPoint(x, y)) };
	}

	if (action === 'primitives_in_region') {
		if (typeof document.getPrimitivesInRegion !== 'function')
			throw new TypeError('EDA sch_Document.getPrimitivesInRegion API is unavailable in this client version.');
		const left = requiredFiniteNumber(payload, 'left');
		const right = requiredFiniteNumber(payload, 'right');
		const top = requiredFiniteNumber(payload, 'top');
		const bottom = requiredFiniteNumber(payload, 'bottom');
		if (left > right || top > bottom)
			throw new RangeError('region bounds must satisfy left <= right and top <= bottom.');
		const rawPrimitives = await document.getPrimitivesInRegion(left, right, top, bottom);
		const primitives = Array.isArray(rawPrimitives) ? rawPrimitives : [];
		const limit = inspectLimit(payload);
		return { ok: true, action, bounds: { left, right, top, bottom }, total: primitives.length, returned: Math.min(primitives.length, limit), truncated: primitives.length > limit, primitives: await serializeArray(primitives, limit) };
	}

	if (action === 'navigate_to_coordinates' || action === 'navigate_to_region') {
		if (action === 'navigate_to_coordinates') {
			if (typeof document.navigateToCoordinates !== 'function')
				throw new TypeError('EDA sch_Document.navigateToCoordinates API is unavailable in this client version.');
			const x = requiredFiniteNumber(payload, 'x');
			const y = requiredFiniteNumber(payload, 'y');
			const navigated = await document.navigateToCoordinates(x, y);
			return { ok: navigated === true, action, x, y, navigated };
		}
		if (typeof document.navigateToRegion !== 'function')
			throw new TypeError('EDA sch_Document.navigateToRegion API is unavailable in this client version.');
		const left = requiredFiniteNumber(payload, 'left');
		const right = requiredFiniteNumber(payload, 'right');
		const top = requiredFiniteNumber(payload, 'top');
		const bottom = requiredFiniteNumber(payload, 'bottom');
		if (left > right || top > bottom)
			throw new RangeError('region bounds must satisfy left <= right and top <= bottom.');
		const navigated = await document.navigateToRegion(left, right, top, bottom);
		return { ok: navigated === true, action, bounds: { left, right, top, bottom }, navigated };
	}

	if (action === 'save') {
		if (typeof document.save !== 'function')
			throw new TypeError('EDA sch_Document.save API is unavailable in this client version.');
		const saved = await document.save();
		return { ok: saved === true, action, saved };
	}
	if (action === 'import_changes') {
		if (typeof document.importChanges !== 'function')
			throw new TypeError('EDA sch_Document.importChanges API is unavailable in this client version.');
		const imported = await document.importChanges();
		return { ok: imported === true, action, imported };
	}

	const select = getApi<SchematicSelectControlApi>(eda, 'sch_SelectControl');
	if (action === 'select_primitives') {
		if (typeof select.doSelectPrimitives !== 'function')
			throw new TypeError('EDA sch_SelectControl.doSelectPrimitives API is unavailable in this client version.');
		const ids = requiredIds(payload);
		const selected = await select.doSelectPrimitives(ids);
		return { ok: selected === true, action, primitiveIds: ids, selected };
	}
	if (action === 'clear_selection') {
		if (typeof select.clearSelected !== 'function')
			throw new TypeError('EDA sch_SelectControl.clearSelected API is unavailable in this client version.');
		const cleared = await select.clearSelected();
		return { ok: cleared === true, action, cleared };
	}

	const primitive = getApi<SchematicPrimitiveApi>(eda, 'sch_Primitive');
	if (action === 'primitive_type_by_id' || action === 'primitive_by_id') {
		if (typeof (action === 'primitive_type_by_id' ? primitive.getPrimitiveTypeByPrimitiveId : primitive.getPrimitiveByPrimitiveId) !== 'function')
			throw new TypeError(`EDA sch_Primitive.${action === 'primitive_type_by_id' ? 'getPrimitiveTypeByPrimitiveId' : 'getPrimitiveByPrimitiveId'} API is unavailable in this client version.`);
		const id = requiredId(payload, 'id');
		const method = action === 'primitive_type_by_id' ? primitive.getPrimitiveTypeByPrimitiveId : primitive.getPrimitiveByPrimitiveId;
		const value = await method.call(primitive, id);
		return action === 'primitive_type_by_id' ? { ok: true, action, id, primitiveType: await toSerializableAsync(value) } : { ok: true, action, id, primitive: await toSerializableAsync(value) };
	}
	if (action === 'primitives_by_id') {
		if (typeof primitive.getPrimitivesByPrimitiveId !== 'function')
			throw new TypeError('EDA sch_Primitive.getPrimitivesByPrimitiveId API is unavailable in this client version.');
		const ids = requiredIds(payload);
		const result = await primitive.getPrimitivesByPrimitiveId(ids);
		return { ok: true, action, ids, primitives: await serializeArray(Array.isArray(result) ? result : [], MAX_INSPECT_ITEMS) };
	}
	if (typeof primitive.getPrimitivesBBox !== 'function')
		throw new TypeError('EDA sch_Primitive.getPrimitivesBBox API is unavailable in this client version.');
	const ids = requiredIds(payload);
	return { ok: true, action, ids, bounds: await toSerializableAsync(await primitive.getPrimitivesBBox(ids)) };
}
