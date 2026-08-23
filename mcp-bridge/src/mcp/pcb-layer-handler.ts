import { isPlainObjectRecord, toSerializableAsync } from '../utils.ts';

type LayerQueryKind = 'layers' | 'current';

interface PcbLayerApi {
	getAllLayers?: () => Promise<unknown>;
	getCurrentLayer?: () => Promise<unknown>;
	getTheNumberOfCopperLayers?: () => Promise<unknown>;
}

function getPcbLayerApi(): PcbLayerApi {
	const eda = (globalThis as unknown as { eda?: Record<string, unknown> }).eda;
	const api = eda?.pcb_Layer;
	if (!isPlainObjectRecord(api)) {
		throw new TypeError('EDA pcb_Layer API is unavailable. Open a PCB document first.');
	}
	return api as PcbLayerApi;
}

function normalizeKind(value: unknown): LayerQueryKind {
	if (value === undefined || value === null)
		return 'layers';
	if (value !== 'layers' && value !== 'current')
		throw new TypeError('kind must be layers or current.');
	return value;
}

export async function handlePcbLayerQueryTask(payload: unknown): Promise<unknown> {
	if (payload !== undefined && payload !== null && !isPlainObjectRecord(payload))
		throw new TypeError('pcb_layer_query payload must be an object.');
	const input = isPlainObjectRecord(payload) ? payload : {};
	const kind = normalizeKind(input.kind);
	const api = getPcbLayerApi();

	if (kind === 'current') {
		if (typeof api.getCurrentLayer !== 'function')
			throw new TypeError('EDA pcb_Layer.getCurrentLayer API is unavailable in this client version.');
		return { ok: true, kind, currentLayer: await toSerializableAsync(await api.getCurrentLayer()) };
	}

	if (typeof api.getAllLayers !== 'function')
		throw new TypeError('EDA pcb_Layer.getAllLayers API is unavailable in this client version.');
	const layers = await toSerializableAsync(await api.getAllLayers());
	const currentLayer = typeof api.getCurrentLayer === 'function'
		? await toSerializableAsync(await api.getCurrentLayer())
		: undefined;
	const copperLayerCount = typeof api.getTheNumberOfCopperLayers === 'function'
		? await toSerializableAsync(await api.getTheNumberOfCopperLayers())
		: undefined;
	return { ok: true, kind, layers, ...(currentLayer !== undefined ? { currentLayer } : {}), ...(copperLayerCount !== undefined ? { copperLayerCount } : {}) };
}
