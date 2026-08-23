import { isPlainObjectRecord, toSerializableAsync } from '../utils.ts';

type NetDomain = 'schematic' | 'pcb';
type NetQueryMode = 'all' | 'names' | 'exact';

export async function handleNetQueryTask(payload: unknown, domain: NetDomain): Promise<unknown> {
	if (payload !== undefined && payload !== null && !isPlainObjectRecord(payload)) {
		throw new TypeError(`net_query_${domain} payload must be an object.`);
	}
	const input = isPlainObjectRecord(payload) ? payload : {};
	const queryText = input.query === undefined ? '' : String(input.query).trim();
	const query = queryText.toLowerCase();
	const mode = input.mode === undefined ? 'all' : input.mode;
	if (mode !== 'all' && mode !== 'names' && mode !== 'exact')
		throw new TypeError('mode must be all, names, or exact.');
	if (mode === 'exact' && query.length === 0)
		throw new TypeError('query is required when mode is exact.');
	const limit = input.limit === undefined ? 200 : Number(input.limit);
	if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
		throw new RangeError('limit must be an integer between 1 and 1000.');
	}

	const edaGlobal = (globalThis as unknown as { eda?: unknown }).eda;
	if (!isPlainObjectRecord(edaGlobal)) {
		throw new TypeError('EDA runtime is unavailable.');
	}
	const moduleName = domain === 'schematic' ? 'sch_Net' : 'pcb_Net';
	const api = edaGlobal[moduleName];
	if (!isPlainObjectRecord(api)) {
		throw new TypeError(`EDA ${moduleName} API is unavailable in this client version.`);
	}
	const getNets = domain === 'schematic' && typeof api.getCurrentProjectAllNets === 'function'
		? api.getCurrentProjectAllNets
		: api.getAllNets;
	if (mode === 'names' && typeof api.getAllNetsName === 'function') {
		const names = await toSerializableAsync(await (api.getAllNetsName as () => Promise<unknown>).call(api));
		if (!Array.isArray(names))
			throw new TypeError(`EDA ${moduleName}.getAllNetsName returned an invalid result.`);
		const filteredNames = names.filter(name => !query || String(name).toLowerCase().includes(query)).slice(0, limit);
		return { ok: true, domain, mode: mode as NetQueryMode, query, total: names.length, returned: filteredNames.length, names: filteredNames };
	}
	if (mode === 'exact' && typeof api.getNet === 'function') {
		const net = await toSerializableAsync(await (api.getNet as (name: string) => Promise<unknown>).call(api, queryText));
		return { ok: true, domain, mode: mode as NetQueryMode, query, total: net === undefined || net === null ? 0 : 1, returned: net === undefined || net === null ? 0 : 1, net };
	}
	if (typeof getNets !== 'function') {
		throw new TypeError(`EDA ${moduleName} network query API is unavailable in this client version.`);
	}
	const allNets = await toSerializableAsync(await (getNets as () => Promise<unknown>).call(api));
	if (!Array.isArray(allNets)) {
		throw new TypeError(`EDA ${moduleName}.getAllNets returned an invalid result.`);
	}
	const nets = allNets
		.filter(net => !query || JSON.stringify(net).toLowerCase().includes(query))
		.slice(0, limit);
	return { ok: true, domain, mode: mode as NetQueryMode, query, total: allNets.length, returned: nets.length, nets };
}

export const handleSchematicNetQueryTask = (payload: unknown) => handleNetQueryTask(payload, 'schematic');
export const handlePcbNetQueryTask = (payload: unknown) => handleNetQueryTask(payload, 'pcb');
