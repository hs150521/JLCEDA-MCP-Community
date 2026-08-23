import { isPlainObjectRecord, toSerializableAsync } from '../utils.ts';

type CompareDomain = 'netlist' | 'schematic' | 'pcb';
type CompareSource = string | Record<string, string>;

function normalizeSource(value: unknown, field: string, domain: CompareDomain): CompareSource {
	if (typeof value === 'string' && value.trim().length > 0) {
		return value.trim();
	}
	if (!isPlainObjectRecord(value) || typeof value.projectUuid !== 'string') {
		throw new TypeError(`${field} must be a UUID or an object containing projectUuid and the domain UUID.`);
	}
	const documentKey = domain === 'netlist' ? 'documentUuid' : domain === 'schematic' ? 'schematicUuid' : 'pcbUuid';
	if (typeof value[documentKey] !== 'string' || value[documentKey].trim().length === 0 || value.projectUuid.trim().length === 0) {
		throw new TypeError(`${field} must contain non-empty projectUuid and ${documentKey}.`);
	}
	return { projectUuid: value.projectUuid.trim(), [documentKey]: value[documentKey].trim() };
}

export async function handleDesignCompareTask(payload: unknown): Promise<unknown> {
	if (!isPlainObjectRecord(payload)) {
		throw new TypeError('design_compare payload must be an object.');
	}
	const domain = payload.domain;
	if (domain !== 'netlist' && domain !== 'schematic' && domain !== 'pcb') {
		throw new TypeError('domain must be \'netlist\', \'schematic\', or \'pcb\'.');
	}
	const sourceA = normalizeSource(payload.sourceA, 'sourceA', domain);
	const sourceB = normalizeSource(payload.sourceB, 'sourceB', domain);
	if (payload.options !== undefined) {
		throw new TypeError('options are unavailable because pcbComparison accepts only two arguments in 0.4.15.');
	}
	const eda = (globalThis as unknown as { eda?: Record<string, unknown> }).eda;
	const api = eda?.sys_Tool;
	const methodName = domain === 'netlist' ? 'netlistComparison' : domain === 'schematic' ? 'schematicComparison' : 'pcbComparison';
	if (!isPlainObjectRecord(api) || typeof api[methodName] !== 'function') {
		throw new TypeError(`EDA sys_Tool.${methodName} API is unavailable in this client version.`);
	}
	const result = await (api[methodName] as (a: CompareSource, b: CompareSource) => Promise<unknown>).call(api, sourceA, sourceB);
	const serialized = await toSerializableAsync(result);
	if (domain === 'netlist' && Array.isArray(serialized)) {
		return { ok: serialized.length === 0, domain, sourceA, sourceB, differenceCount: serialized.length, differences: serialized };
	}
	return { ok: true, domain, sourceA, sourceB, result: serialized };
}
