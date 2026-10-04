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

function primitiveState(value: unknown, field: string): unknown {
	if (!isPlainObjectRecord(value))
		return undefined;
	const getter = value[`getState_${field.charAt(0).toUpperCase()}${field.slice(1)}`];
	return typeof getter === 'function' ? getter.call(value) : value[field];
}

function textOrAttributeType(value: unknown): boolean {
	return value === 'Text' || value === 'TEXT' || value === 'Attribute' || value === 'ATTR';
}

async function inspectedAttributes(eda: Record<string, unknown>, ids: string[]): Promise<Map<string, Record<string, unknown>>> {
	const result = new Map<string, Record<string, unknown>>();
	const api = eda.sch_PrimitiveAttribute;
	if (!ids.length || !isPlainObjectRecord(api))
		return result;
	// 通用 Primitive 查询会把绑定 ATTR 包装成 Text；无父 ID 的 getAll 又可能漏掉它。
	// 优先按候选 ID 批量读取真实 Attribute，核对类型及身份，保留原生父图元关系。
	const requested = new Set(ids);
	let attributes: unknown;
	let method: string;
	if (typeof api.get === 'function') {
		method = 'get';
		attributes = await api.get([...requested]);
	}
	else if (typeof api.getAll === 'function') {
		method = 'getAll';
		attributes = await api.getAll();
	}
	else {
		return result;
	}
	if (!Array.isArray(attributes))
		throw new TypeError(`EDA sch_PrimitiveAttribute.${method} did not return an array.`);
	for (const attribute of attributes) {
		const id = primitiveState(attribute, 'primitiveId');
		const type = primitiveState(attribute, 'primitiveType');
		if (typeof id !== 'string' || !requested.has(id) || (type !== 'Attribute' && type !== 'ATTR'))
			continue;
		const resolved: Record<string, unknown> = { primitiveType: 'Attribute', primitiveId: id };
		for (const field of ['key', 'value', 'parentPrimitiveId', 'x', 'y', 'rotation', 'color', 'fontName', 'fontSize', 'bold', 'italic', 'underLine', 'alignMode', 'fillColor', 'keyVisible', 'valueVisible']) {
			const value = primitiveState(attribute, field);
			if (value !== undefined)
				resolved[field] = value;
		}
		result.set(id, resolved);
	}
	return result;
}

async function resolvedPrimitives(eda: Record<string, unknown>, values: unknown[]): Promise<unknown[]> {
	const candidates = values.filter(value => textOrAttributeType(primitiveState(value, 'primitiveType')))
		.map(value => primitiveState(value, 'primitiveId'))
		.filter((id): id is string => typeof id === 'string');
	const attributes = await inspectedAttributes(eda, candidates);
	return values.map(value => attributes.get(String(primitiveState(value, 'primitiveId'))) ?? value);
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
		if (left > right || top < bottom)
			throw new RangeError('region bounds must satisfy left <= right and top >= bottom.');
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
		if (left > right || top < bottom)
			throw new RangeError('region bounds must satisfy left <= right and top >= bottom.');
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
	if (action === 'primitive_type_by_id') {
		if (typeof primitive.getPrimitiveTypeByPrimitiveId !== 'function')
			throw new TypeError('EDA sch_Primitive.getPrimitiveTypeByPrimitiveId API is unavailable in this client version.');
		const id = requiredId(payload, 'id');
		const nativeType = await primitive.getPrimitiveTypeByPrimitiveId(id);
		const attributes = textOrAttributeType(nativeType) ? await inspectedAttributes(eda, [id]) : undefined;
		const value = attributes?.has(id) ? 'Attribute' : nativeType;
		return { ok: true, action, id, primitiveType: await toSerializableAsync(value) };
	}
	if (action === 'primitive_by_id') {
		if (typeof primitive.getPrimitiveByPrimitiveId !== 'function')
			throw new TypeError('EDA sch_Primitive.getPrimitiveByPrimitiveId API is unavailable in this client version.');
		const id = requiredId(payload, 'id');
		const [value] = await resolvedPrimitives(eda, [await primitive.getPrimitiveByPrimitiveId(id)]);
		return { ok: true, action, id, primitive: await toSerializableAsync(value) };
	}
	if (action === 'primitives_by_id') {
		if (typeof primitive.getPrimitivesByPrimitiveId !== 'function')
			throw new TypeError('EDA sch_Primitive.getPrimitivesByPrimitiveId API is unavailable in this client version.');
		const ids = requiredIds(payload);
		const result = await primitive.getPrimitivesByPrimitiveId(ids);
		return { ok: true, action, ids, primitives: await serializeArray(await resolvedPrimitives(eda, Array.isArray(result) ? result : []), MAX_INSPECT_ITEMS) };
	}
	if (typeof primitive.getPrimitivesBBox !== 'function')
		throw new TypeError('EDA sch_Primitive.getPrimitivesBBox API is unavailable in this client version.');
	const ids = requiredIds(payload);
	return { ok: true, action, ids, bounds: await toSerializableAsync(await primitive.getPrimitivesBBox(ids)) };
}
