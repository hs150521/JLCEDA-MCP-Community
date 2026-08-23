import { isPlainObjectRecord, parseBoundedIntegerValue, preserveBoundedArray, toSerializableAsync } from '../utils.ts';

const MAX_LIBRARY_ITEMS = 500;

async function serializeLibraries(values: unknown[]): Promise<unknown[]> {
	return preserveBoundedArray(await Promise.all(values.map(value => toSerializableAsync(value))));
}

export async function handleLibrarySourcesTask(payload: unknown): Promise<unknown> {
	if (payload !== undefined && payload !== null && !isPlainObjectRecord(payload))
		throw new TypeError('library_sources payload must be an object.');
	const input = isPlainObjectRecord(payload) ? payload : {};
	const limit = parseBoundedIntegerValue(input.limit, 100, 1, MAX_LIBRARY_ITEMS);
	const eda = (globalThis as unknown as { eda?: Record<string, unknown> }).eda;
	const api = eda?.lib_LibrariesList;
	if (!isPlainObjectRecord(api) || typeof api.getAllLibrariesList !== 'function')
		throw new TypeError('EDA lib_LibrariesList.getAllLibrariesList API is unavailable in this client version.');
	const rawLibraries = await (api.getAllLibrariesList as () => Promise<unknown>).call(api);
	if (!Array.isArray(rawLibraries))
		throw new TypeError('EDA lib_LibrariesList.getAllLibrariesList returned an invalid result.');
	const knownLibraryUuids: Record<string, unknown> = {};
	for (const [scope, methodName] of Object.entries({
		system: 'getSystemLibraryUuid',
		personal: 'getPersonalLibraryUuid',
		project: 'getProjectLibraryUuid',
		favorite: 'getFavoriteLibraryUuid',
	})) {
		const method = api[methodName];
		if (typeof method === 'function')
			knownLibraryUuids[scope] = await toSerializableAsync(await (method as () => Promise<unknown>).call(api));
	}
	const libraries = await serializeLibraries(rawLibraries.slice(0, limit));
	return {
		ok: true,
		total: rawLibraries.length,
		returned: libraries.length,
		truncated: rawLibraries.length > limit,
		libraries,
		...(Object.keys(knownLibraryUuids).length > 0 ? { knownLibraryUuids } : {}),
	};
}
