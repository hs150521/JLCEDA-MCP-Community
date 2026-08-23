import { isPlainObjectRecord, toSerializableAsync } from '../utils.ts';

type NetDomain = 'schematic' | 'pcb';

export async function handleNetQueryTask(payload: unknown, domain: NetDomain): Promise<unknown> {
	if (payload !== undefined && payload !== null && !isPlainObjectRecord(payload)) {
		throw new TypeError(`net_query_${domain} payload must be an object.`);
	}
	const input = isPlainObjectRecord(payload) ? payload : {};
	const query = input.query === undefined ? '' : String(input.query).trim().toLowerCase();
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
	return { ok: true, domain, query, total: allNets.length, returned: nets.length, nets };
}

export const handleSchematicNetQueryTask = (payload: unknown) => handleNetQueryTask(payload, 'schematic');
export const handlePcbNetQueryTask = (payload: unknown) => handleNetQueryTask(payload, 'pcb');
