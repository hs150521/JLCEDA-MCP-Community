import { isPlainObjectRecord, toSerializableAsync } from '../utils.ts';

type LayerQueryKind = 'layers' | 'current' | 'physical_stacking';

interface PcbLayerApi {
	getAllLayers?: () => Promise<unknown>;
	getCurrentLayer?: () => Promise<unknown>;
	getTheNumberOfCopperLayers?: () => Promise<unknown>;
	getCurrentPhysicalStackingConfigurationName?: () => Promise<unknown>;
	getCurrentPhysicalStackingConfiguration?: () => Promise<unknown>;
	getPhysicalStackingConfiguration?: (name: string, props?: Record<string, unknown>) => Promise<unknown>;
	getAllPhysicalStackingConfigurations?: (props?: Record<string, unknown>) => Promise<unknown>;
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
	if (value !== 'layers' && value !== 'current' && value !== 'physical_stacking')
		throw new TypeError('kind must be layers, current, or physical_stacking.');
	return value;
}

function normalizePhysicalProps(value: unknown): Record<string, unknown> | undefined {
	if (value === undefined || value === null)
		return undefined;
	if (!isPlainObjectRecord(value))
		throw new TypeError('physicalProps must be an object.');
	const props: Record<string, unknown> = {};
	if (value.numberOfLayers !== undefined) {
		if (!Number.isInteger(value.numberOfLayers) || value.numberOfLayers < 2 || value.numberOfLayers > 32 || value.numberOfLayers % 2 !== 0)
			throw new TypeError('physicalProps.numberOfLayers must be an even integer from 2 to 32.');
		props.numberOfLayers = value.numberOfLayers;
	}
	if (value.substrateMaterial !== undefined) {
		if (value.substrateMaterial !== 'Common' && value.substrateMaterial !== 'FPC Flexible')
			throw new TypeError('physicalProps.substrateMaterial must be Common or FPC Flexible.');
		props.substrateMaterial = value.substrateMaterial;
	}
	return Object.keys(props).length > 0 ? props : undefined;
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

	if (kind === 'layers') {
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

	const physicalProps = normalizePhysicalProps(input.physicalProps);
	if (typeof api.getCurrentPhysicalStackingConfiguration !== 'function' || typeof api.getAllPhysicalStackingConfigurations !== 'function')
		throw new TypeError('EDA physical stacking configuration APIs are unavailable in this client version (requires EDA v4.2).');
	const configurationName = input.configurationName;
	if (configurationName !== undefined && (typeof configurationName !== 'string' || configurationName.trim().length === 0))
		throw new TypeError('configurationName must be a non-empty string.');
	const currentName = typeof api.getCurrentPhysicalStackingConfigurationName === 'function'
		? await toSerializableAsync(await api.getCurrentPhysicalStackingConfigurationName())
		: undefined;
	const current = await toSerializableAsync(await api.getCurrentPhysicalStackingConfiguration());
	const all = await toSerializableAsync(await api.getAllPhysicalStackingConfigurations(physicalProps));
	const selected = configurationName && typeof api.getPhysicalStackingConfiguration === 'function'
		? await toSerializableAsync(await api.getPhysicalStackingConfiguration(configurationName.trim(), physicalProps))
		: undefined;
	return { ok: true, kind, ...(physicalProps ? { physicalProps } : {}), ...(currentName !== undefined ? { currentName } : {}), current, all, ...(selected !== undefined ? { selected } : {}) };
}
