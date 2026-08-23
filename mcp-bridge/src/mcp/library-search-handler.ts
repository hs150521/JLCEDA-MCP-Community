import { isPlainObjectRecord, parseBoundedIntegerValue, toSerializableAsync } from '../utils.ts';

type LibrarySearchKind = 'device' | 'symbol' | 'footprint';

const PROPERTY_KEYS: Record<LibrarySearchKind, readonly string[]> = {
	device: ['name', 'value', 'symbolName', 'footprintName', 'supplierFootprint', 'supplierId', 'partNumber', 'partCode'],
	symbol: ['name'],
	footprint: ['name'],
};

function requiredKind(value: unknown): LibrarySearchKind {
	if (value !== 'device' && value !== 'symbol' && value !== 'footprint')
		throw new TypeError('kind must be device, symbol, or footprint.');
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

function getApi(kind: LibrarySearchKind): Record<string, unknown> {
	const eda = (globalThis as unknown as { eda?: Record<string, unknown> }).eda;
	const api = eda?.[kind === 'device' ? 'lib_Device' : kind === 'symbol' ? 'lib_Symbol' : 'lib_Footprint'];
	if (!isPlainObjectRecord(api))
		throw new TypeError(`EDA lib_${kind[0].toUpperCase()}${kind.slice(1)} API is unavailable in this client version.`);
	return api;
}

export async function handleLibrarySearchTask(payload: unknown): Promise<unknown> {
	if (!isPlainObjectRecord(payload))
		throw new TypeError('library_search payload must be an object.');
	const kind = requiredKind(payload.kind);
	const keyword = optionalNonEmptyString(payload, 'keyword');
	const properties = normalizeProperties(kind, payload.properties);
	if ((keyword === undefined) === (properties === undefined))
		throw new TypeError('Provide exactly one of keyword or properties.');
	const libraryUuid = optionalNonEmptyString(payload, 'libraryUuid');
	const limit = parseBoundedIntegerValue(payload.limit, 20, 1, 50);
	const page = parseBoundedIntegerValue(payload.page, 1, 1, 9999);
	const api = getApi(kind);
	let rawResults: unknown;
	if (properties) {
		if (typeof api.searchByProperties !== 'function')
			throw new TypeError(`EDA lib_${kind}.searchByProperties API is unavailable in this client version.`);
		rawResults = kind === 'device'
			? await (api.searchByProperties as (...args: unknown[]) => Promise<unknown>).call(api, properties, libraryUuid, undefined, undefined, limit, page)
			: await (api.searchByProperties as (...args: unknown[]) => Promise<unknown>).call(api, properties, libraryUuid);
	}
	else {
		if (typeof api.search !== 'function')
			throw new TypeError(`EDA lib_${kind}.search API is unavailable in this client version.`);
		rawResults = kind === 'device' || kind === 'symbol'
			? await (api.search as (...args: unknown[]) => Promise<unknown>).call(api, keyword, libraryUuid, undefined, undefined, limit, page)
			: await (api.search as (...args: unknown[]) => Promise<unknown>).call(api, keyword, libraryUuid, undefined, limit, page);
	}
	const allItems = Array.isArray(rawResults) ? await toSerializableAsync(rawResults) : [];
	const items = Array.isArray(allItems) ? allItems.slice(0, limit) : [];
	return {
		ok: true,
		kind,
		searchMode: properties ? 'properties' : 'keyword',
		...(keyword ? { keyword } : { properties }),
		libraryUuid: libraryUuid ?? '',
		page,
		total: Array.isArray(allItems) ? allItems.length : 0,
		returned: items.length,
		items,
	};
}
