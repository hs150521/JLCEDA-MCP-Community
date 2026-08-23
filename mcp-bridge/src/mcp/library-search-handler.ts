import { getEdaRuntime, isPlainObjectRecord, parseBoundedIntegerValue, toSerializableAsync } from '../utils.ts';

type LibrarySearchKind = 'device' | 'symbol' | 'footprint' | 'model_3d' | 'cbb' | 'panel_library' | 'simulation_model';

const API_MODULE_BY_KIND: Record<LibrarySearchKind, string> = {
	device: 'lib_Device',
	symbol: 'lib_Symbol',
	footprint: 'lib_Footprint',
	model_3d: 'lib_3DModel',
	cbb: 'lib_Cbb',
	panel_library: 'lib_PanelLibrary',
	simulation_model: 'lib_SimulationModel',
};

const PROPERTY_KEYS: Record<LibrarySearchKind, readonly string[]> = {
	device: ['name', 'value', 'symbolName', 'footprintName', 'supplierFootprint', 'supplierId', 'partNumber', 'partCode'],
	symbol: [],
	footprint: [],
	model_3d: [],
	cbb: [],
	panel_library: [],
	simulation_model: [],
};

function requiredKind(value: unknown): LibrarySearchKind {
	if (value !== 'device' && value !== 'symbol' && value !== 'footprint' && value !== 'model_3d' && value !== 'cbb' && value !== 'panel_library' && value !== 'simulation_model')
		throw new TypeError('kind must be device, symbol, footprint, model_3d, cbb, panel_library, or simulation_model.');
	return value;
}

function optionalNonEmptyString(input: Record<string, unknown>, key: string): string | undefined {
	if (input[key] === undefined || input[key] === null)
		return undefined;
	if (typeof input[key] !== 'string' || input[key].trim().length === 0)
		throw new TypeError(`${key} must be a non-empty string.`);
	return input[key].trim();
}

function normalizeProperties(kind: LibrarySearchKind, raw: unknown): Record<string, string> | undefined {
	if (raw === undefined || raw === null)
		return undefined;
	if (kind !== 'device')
		throw new TypeError(`properties are only supported for device searches, not ${kind}.`);
	if (!isPlainObjectRecord(raw))
		throw new TypeError('properties must be an object.');
	const allowed = new Set(PROPERTY_KEYS[kind]);
	const properties: Record<string, string> = {};
	for (const key of Object.keys(raw)) {
		if (!allowed.has(key))
			throw new TypeError(`properties.${key} is not supported for ${kind} search.`);
		if (typeof raw[key] !== 'string' || raw[key].trim().length === 0)
			throw new TypeError(`properties.${key} must be a non-empty string.`);
		properties[key] = raw[key].trim();
	}
	if (Object.keys(properties).length === 0)
		throw new TypeError('properties must contain at least one field.');
	return properties;
}

function normalizeLcscIds(raw: unknown): string[] | undefined {
	if (raw === undefined || raw === null)
		return undefined;
	const values = Array.isArray(raw) ? raw : [raw];
	if (values.length < 1 || values.length > 50)
		throw new RangeError('lcscIds must contain between 1 and 50 IDs.');
	const ids = values.map((value, index) => {
		if (typeof value !== 'string' || !/^C\d+$/i.test(value.trim()))
			throw new TypeError(`lcscIds[${String(index)}] must be an LCSC C-number such as C1523.`);
		return value.trim().toUpperCase();
	});
	if (new Set(ids).size !== ids.length)
		throw new TypeError('lcscIds must not contain duplicates.');
	return ids;
}

function getApi(kind: LibrarySearchKind): Record<string, unknown> {
	const eda = getEdaRuntime();
	const moduleName = API_MODULE_BY_KIND[kind];
	const api = eda?.[moduleName];
	if (!isPlainObjectRecord(api))
		throw new TypeError(`EDA ${moduleName} API is unavailable in this client version.`);
	return api;
}

export async function handleLibrarySearchTask(payload: unknown): Promise<unknown> {
	if (!isPlainObjectRecord(payload))
		throw new TypeError('library_search payload must be an object.');
	const kind = requiredKind(payload.kind);
	const keyword = optionalNonEmptyString(payload, 'keyword');
	const properties = normalizeProperties(kind, payload.properties);
	const lcscIds = normalizeLcscIds(payload.lcscIds);
	const uuid = optionalNonEmptyString(payload, 'uuid');
	if ([keyword !== undefined, properties !== undefined, lcscIds !== undefined, uuid !== undefined].filter(Boolean).length !== 1)
		throw new TypeError('Provide exactly one of keyword, properties, lcscIds, or uuid.');
	if (lcscIds !== undefined && kind !== 'device')
		throw new TypeError('lcscIds is only supported for device searches.');
	const simulationModelType = optionalNonEmptyString(payload, 'simulationModelType');
	if (simulationModelType !== undefined && kind !== 'simulation_model')
		throw new TypeError('simulationModelType is only supported for simulation_model searches.');
	if (simulationModelType !== undefined && simulationModelType !== 'Ngspice' && simulationModelType !== 'SimulIDE')
		throw new TypeError('simulationModelType must be Ngspice or SimulIDE.');
	const allowMultiMatch = payload.allowMultiMatch === undefined ? false : payload.allowMultiMatch;
	if (typeof allowMultiMatch !== 'boolean')
		throw new TypeError('allowMultiMatch must be a boolean.');
	if (payload.allowMultiMatch !== undefined && lcscIds === undefined)
		throw new TypeError('allowMultiMatch is only supported with lcscIds.');
	const libraryUuid = optionalNonEmptyString(payload, 'libraryUuid');
	const limit = parseBoundedIntegerValue(payload.limit, 20, 1, 50);
	if (lcscIds !== undefined && payload.page !== undefined)
		throw new TypeError('page is not supported for lcscIds lookups; provide the requested C-numbers directly.');
	const page = parseBoundedIntegerValue(payload.page, 1, 1, 9999);
	const api = getApi(kind);
	let rawResults: unknown;
	if (uuid) {
		if (kind === 'simulation_model')
			throw new TypeError('simulation_model only supports keyword search because the official get API requires a private deployment.');
		if (typeof api.get !== 'function')
			throw new TypeError(`EDA ${API_MODULE_BY_KIND[kind]}.get API is unavailable in this client version.`);
		const item = await (api.get as (uuid: string, libraryUuid?: string) => Promise<unknown>).call(api, uuid, libraryUuid);
		return {
			ok: true,
			kind,
			searchMode: 'uuid',
			uuid,
			libraryUuid: libraryUuid ?? '',
			item: await toSerializableAsync(item),
		};
	}
	if (lcscIds) {
		if (typeof api.getByLcscIds !== 'function')
			throw new TypeError('EDA lib_Device.getByLcscIds API is unavailable in this client version.');
		rawResults = await (api.getByLcscIds as (...args: unknown[]) => Promise<unknown>).call(api, lcscIds, libraryUuid, allowMultiMatch);
	}
	else if (properties) {
		if (typeof api.searchByProperties !== 'function')
			throw new TypeError(`EDA ${API_MODULE_BY_KIND[kind]}.searchByProperties API is unavailable in this client version.`);
		rawResults = kind === 'device'
			? await (api.searchByProperties as (...args: unknown[]) => Promise<unknown>).call(api, properties, libraryUuid, undefined, undefined, limit, page)
			: await (api.searchByProperties as (...args: unknown[]) => Promise<unknown>).call(api, properties, libraryUuid);
	}
	else {
		if (typeof api.search !== 'function')
			throw new TypeError(`EDA ${API_MODULE_BY_KIND[kind]}.search API is unavailable in this client version.`);
		rawResults = kind === 'simulation_model'
			? await (api.search as (...args: unknown[]) => Promise<unknown>).call(api, keyword, libraryUuid, undefined, simulationModelType, limit, page)
			: kind === 'device' || kind === 'symbol'
				? await (api.search as (...args: unknown[]) => Promise<unknown>).call(api, keyword, libraryUuid, undefined, undefined, limit, page)
				: await (api.search as (...args: unknown[]) => Promise<unknown>).call(api, keyword, libraryUuid, undefined, limit, page);
	}
	const allRawItems = Array.isArray(rawResults) ? rawResults : rawResults === undefined || rawResults === null ? [] : [rawResults];
	const items = await toSerializableAsync(allRawItems.slice(0, limit));
	const response = {
		ok: true,
		kind,
		searchMode: lcscIds ? 'lcsc_ids' : properties ? 'properties' : 'keyword',
		...(keyword ? { keyword } : properties ? { properties } : { lcscIds }),
		...(simulationModelType ? { simulationModelType } : {}),
		libraryUuid: libraryUuid ?? '',
		returned: Array.isArray(items) ? items.length : 0,
		items,
	};
	if (lcscIds) {
		return {
			...response,
			total: allRawItems.length,
			truncated: allRawItems.length > limit,
		};
	}

	// The SDK returns one page without its complete hit count. A full page only
	// proves another page may exist, so do not present the page length as total.
	return {
		...response,
		page,
		pageSize: limit,
		totalKnown: false,
		mayHaveMore: allRawItems.length >= limit,
	};
}
