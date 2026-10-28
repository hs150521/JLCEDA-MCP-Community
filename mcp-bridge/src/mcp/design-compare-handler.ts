import { getEdaRuntime, isPlainObjectRecord, preserveBoundedArray, toSerializableAsync } from '../utils.ts';
import { unsupportedApiVersion } from './api-version.ts';

type CompareDomain = 'netlist' | 'schematic' | 'pcb';
type CompareSource = string | Record<string, string>;
const MAX_NETLIST_DIFFERENCES = 120;

function normalizeSource(value: unknown, field: string, domain: CompareDomain): CompareSource {
	if (typeof value === 'string' && value.trim().length > 0) {
		return value.trim();
	}
	if (domain === 'schematic')
		throw new TypeError(`${field} must be a schematic UUID; the current schematicComparison API accepts UUID strings only.`);
	if (!isPlainObjectRecord(value) || typeof value.projectUuid !== 'string') {
		throw new TypeError(`${field} must be a UUID or an object containing projectUuid and the domain UUID.`);
	}
	const documentKey = domain === 'netlist' ? 'documentUuid' : 'pcbUuid';
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
	let options: Record<string, unknown> | undefined;
	if (payload.options !== undefined) {
		if (domain !== 'pcb' || !isPlainObjectRecord(payload.options))
			throw new TypeError('options are only supported for PCB comparison.');
		options = payload.options;
		for (const [key, value] of Object.entries(options)) {
			if (key === 'valUnit') {
				if (typeof value !== 'string' || !['mil', 'mm', 'inch', 'cm'].includes(value))
					throw new TypeError('options.valUnit must be mil, mm, inch, or cm.');
			}
			else if (key === 'deviation' || key === 'comparisonSize') {
				if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
					throw new TypeError(`options.${key} must be a finite positive number.`);
			}
			else {
				throw new TypeError(`Unknown comparison option: ${key}.`);
			}
		}
	}
	const eda = getEdaRuntime();
	const api = eda?.sys_Tool;
	const methodName = domain === 'netlist' ? 'netlistComparison' : domain === 'schematic' ? 'schematicComparison' : 'pcbComparison';
	if (domain !== 'netlist') {
		const unsupported = await unsupportedApiVersion(`eda.sys_Tool.${methodName}`, ['3.2.205', '4.1.62']);
		if (unsupported)
			return { ...unsupported, domain };
	}
	if (!isPlainObjectRecord(api) || typeof api[methodName] !== 'function') {
		throw new TypeError(`EDA sys_Tool.${methodName} API is unavailable in this client version.`);
	}
	const args = options === undefined ? [sourceA, sourceB] : [sourceA, sourceB, options];
	const result = await (api[methodName] as (...args: unknown[]) => Promise<unknown>).apply(api, args);
	if (domain === 'netlist' && Array.isArray(result)) {
		const differences = preserveBoundedArray(await Promise.all(result.slice(0, MAX_NETLIST_DIFFERENCES).map(difference => toSerializableAsync(difference))));
		return {
			ok: result.length === 0,
			domain,
			sourceA,
			sourceB,
			differenceCount: result.length,
			returned: differences.length,
			truncated: result.length > MAX_NETLIST_DIFFERENCES,
			differences,
		};
	}
	const serialized = await toSerializableAsync(result);
	const ok = domain === 'netlist' || (isPlainObjectRecord(result) && result.success === true);
	return { ok, domain, sourceA, sourceB, result: serialized };
}
