import { getEdaRuntime, isPlainObjectRecord, preserveBoundedArray, toSerializableAsync } from '../utils.ts';

type NetQueryMode = 'all' | 'names' | 'exact';
interface PcbNetAnalysis {
	length?: boolean;
	color?: boolean;
	primitives?: boolean;
	primitiveTypes?: string[];
}

const PCB_PRIMITIVE_TYPE_VALUES: Record<string, string> = {
	ARC: 'Arc',
	COMPONENT: 'Component',
	PAD: 'Pad',
	COMPONENT_PAD: 'ComponentPad',
	POLYLINE: 'Polyline',
	POUR: 'Pour',
	FILL: 'Fill',
	REGION: 'Region',
	LINE: 'Line',
	VIA: 'Via',
	DIMENSION: 'Dimension',
	IMAGE: 'Image',
	OBJECT: 'Object',
	POURED: 'Poured',
	STRING: 'String',
	ATTRIBUTE: 'Attribute',
};

const PCB_PRIMITIVE_TYPES = new Set(Object.keys(PCB_PRIMITIVE_TYPE_VALUES));

async function serializeBoundedNetArray(values: unknown[]): Promise<unknown[]> {
	return preserveBoundedArray(await Promise.all(values.map(value => toSerializableAsync(value))));
}

function normalizePcbNetAnalysis(input: Record<string, unknown>, mode: NetQueryMode): PcbNetAnalysis | undefined {
	if (input.analysis === undefined || input.analysis === null)
		return undefined;
	if (mode !== 'exact' || !isPlainObjectRecord(input.analysis))
		throw new TypeError('analysis is only supported as an object for exact PCB net queries.');
	const analysis = input.analysis;
	const output: PcbNetAnalysis = {};
	for (const key of ['length', 'color', 'primitives']) {
		if (analysis[key] !== undefined) {
			if (typeof analysis[key] !== 'boolean')
				throw new TypeError(`analysis.${key} must be a boolean.`);
			(output as Record<string, unknown>)[key] = analysis[key];
		}
	}
	if (analysis.primitiveTypes !== undefined) {
		if (!Array.isArray(analysis.primitiveTypes) || analysis.primitiveTypes.length === 0 || analysis.primitiveTypes.some(value => typeof value !== 'string' || !PCB_PRIMITIVE_TYPES.has(value.trim().toUpperCase())))
			throw new TypeError(`analysis.primitiveTypes must contain only supported PCB primitive types: ${Array.from(PCB_PRIMITIVE_TYPES).join(', ')}.`);
		output.primitiveTypes = analysis.primitiveTypes.map(value => value.trim().toUpperCase());
		output.primitives = true;
	}
	if (Object.keys(output).length === 0)
		throw new TypeError('analysis must request length, color, primitives, or primitiveTypes.');
	return output;
}

function toEdaPrimitiveTypes(primitiveTypes: string[] | undefined): string[] | undefined {
	return primitiveTypes?.map(type => PCB_PRIMITIVE_TYPE_VALUES[type]);
}

export async function handlePcbNetQueryTask(payload: unknown): Promise<unknown> {
	if (payload !== undefined && payload !== null && !isPlainObjectRecord(payload)) {
		throw new TypeError('net_query_pcb payload must be an object.');
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
	const analysis = normalizePcbNetAnalysis(input, mode as NetQueryMode);

	const edaGlobal = getEdaRuntime();
	if (!isPlainObjectRecord(edaGlobal)) {
		throw new TypeError('EDA runtime is unavailable.');
	}
	const moduleName = 'pcb_Net';
	const api = edaGlobal.pcb_Net;
	if (!isPlainObjectRecord(api)) {
		throw new TypeError(`EDA ${moduleName} API is unavailable in this client version.`);
	}
	const getNets = api.getAllNets;
	if (mode === 'names' && typeof api.getAllNetsName === 'function') {
		const rawNames = await (api.getAllNetsName as () => Promise<unknown>).call(api);
		if (!Array.isArray(rawNames))
			throw new TypeError(`EDA ${moduleName}.getAllNetsName returned an invalid result.`);
		const matchingNames = rawNames.filter(name => !query || String(name).toLowerCase().includes(query));
		const returnedNames = matchingNames.slice(0, limit);
		return { ok: true, domain: 'pcb', mode: mode as NetQueryMode, query, total: matchingNames.length, returned: returnedNames.length, names: await serializeBoundedNetArray(returnedNames), truncated: matchingNames.length > returnedNames.length };
	}
	if (mode === 'exact' && typeof api.getNet === 'function') {
		const net = await toSerializableAsync(await (api.getNet as (name: string) => Promise<unknown>).call(api, queryText));
		const result: Record<string, unknown> = { ok: true, domain: 'pcb', mode: mode as NetQueryMode, query, total: net === undefined || net === null ? 0 : 1, returned: net === undefined || net === null ? 0 : 1, net, ...(analysis ? { analysis } : {}) };
		if (analysis && net !== undefined && net !== null) {
			const rawApi = api as Record<string, unknown>;
			if (analysis.length) {
				if (typeof rawApi.getNetLength !== 'function')
					throw new TypeError('EDA pcb_Net.getNetLength API is unavailable in this client version.');
				result.length = await (rawApi.getNetLength as (name: string) => Promise<unknown>).call(api, queryText);
			}
			if (analysis.color) {
				if (typeof rawApi.getNetColor !== 'function')
					throw new TypeError('EDA pcb_Net.getNetColor API is unavailable in this client version.');
				result.color = await toSerializableAsync(await (rawApi.getNetColor as (name: string) => Promise<unknown>).call(api, queryText));
			}
			if (analysis.primitives) {
				if (typeof rawApi.getAllPrimitivesByNet !== 'function')
					throw new TypeError('EDA pcb_Net.getAllPrimitivesByNet API is unavailable in this client version.');
				const rawPrimitives = await (rawApi.getAllPrimitivesByNet as (name: string, types?: string[]) => Promise<unknown>).call(api, queryText, toEdaPrimitiveTypes(analysis.primitiveTypes));
				const primitives = Array.isArray(rawPrimitives) ? rawPrimitives : [];
				result.primitiveCount = primitives.length;
				result.primitives = await toSerializableAsync(primitives.slice(0, 120));
				result.primitivesTruncated = primitives.length > 120;
			}
		}
		return result;
	}
	if (typeof getNets !== 'function') {
		throw new TypeError(`EDA ${moduleName} network query API is unavailable in this client version.`);
	}
	const rawNets = await (getNets as () => Promise<unknown>).call(api);
	if (!Array.isArray(rawNets)) {
		throw new TypeError(`EDA ${moduleName}.getAllNets returned an invalid result.`);
	}
	const matchingNets = rawNets.filter(net => !query || JSON.stringify(net).toLowerCase().includes(query));
	const returnedNets = matchingNets.slice(0, limit);
	return { ok: true, domain: 'pcb', mode: mode as NetQueryMode, query, total: matchingNets.length, returned: returnedNets.length, nets: await serializeBoundedNetArray(returnedNets), truncated: matchingNets.length > returnedNets.length };
}
