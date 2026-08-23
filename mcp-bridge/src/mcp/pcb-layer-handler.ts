import { getEdaRuntime, isPlainObjectRecord, toSerializableAsync } from '../utils.ts';

interface PcbLayerApi {
	getAllLayers?: () => Promise<unknown>;
	getTheNumberOfCopperLayers?: () => Promise<unknown>;
}

function getPcbLayerApi(): PcbLayerApi {
	const eda = getEdaRuntime();
	const api = eda?.pcb_Layer;
	if (!isPlainObjectRecord(api)) {
		throw new TypeError('EDA pcb_Layer API is unavailable. Open a PCB document first.');
	}
	return api as PcbLayerApi;
}

export async function handlePcbLayerQueryTask(payload: unknown): Promise<unknown> {
	if (payload !== undefined && payload !== null && !isPlainObjectRecord(payload))
		throw new TypeError('pcb_layer_query payload must be an object.');
	const input = isPlainObjectRecord(payload) ? payload : {};
	if (input.kind !== undefined && input.kind !== 'layers')
		throw new TypeError('kind must be layers when provided.');
	const api = getPcbLayerApi();

	if (typeof api.getAllLayers !== 'function')
		throw new TypeError('EDA pcb_Layer.getAllLayers API is unavailable in this client version.');
	const layers = await toSerializableAsync(await api.getAllLayers());
	const copperLayerCount = typeof api.getTheNumberOfCopperLayers === 'function'
		? await toSerializableAsync(await api.getTheNumberOfCopperLayers())
		: undefined;
	return { ok: true, kind: 'layers', layers, ...(copperLayerCount !== undefined ? { copperLayerCount } : {}) };
}
