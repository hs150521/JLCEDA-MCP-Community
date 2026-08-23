import { isPlainObjectRecord, toSerializableAsync } from '../utils.ts';

export async function handleManufactureTemplatesQueryTask(payload: unknown): Promise<unknown> {
	if (payload !== undefined && payload !== null && !isPlainObjectRecord(payload))
		throw new TypeError('manufacture_templates_query payload must be an object.');
	const input = isPlainObjectRecord(payload) ? payload : {};
	const domain = input.domain;
	if (domain !== 'pcb' && domain !== 'schematic')
		throw new TypeError('domain must be pcb or schematic.');
	const moduleName = domain === 'pcb' ? 'pcb_ManufactureData' : 'sch_ManufactureData';
	const eda = (globalThis as unknown as { eda?: Record<string, unknown> }).eda;
	const api = eda?.[moduleName];
	if (!isPlainObjectRecord(api) || typeof api.getBomTemplates !== 'function')
		throw new TypeError(`EDA ${moduleName}.getBomTemplates API is unavailable in this client version.`);
	const templates = await toSerializableAsync(await (api.getBomTemplates as () => Promise<unknown>).call(api));
	const assemblyVariants = typeof api.getAssemblyVariantsConfigs === 'function'
		? await toSerializableAsync(await (api.getAssemblyVariantsConfigs as () => Promise<unknown>).call(api))
		: undefined;
	return { ok: true, domain, templates, ...(assemblyVariants !== undefined ? { assemblyVariants } : {}) };
}
