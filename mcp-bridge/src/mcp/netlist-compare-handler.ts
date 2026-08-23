import { isPlainObjectRecord, toSerializableAsync } from '../utils.ts';

type NetlistSource = string | { projectUuid: string; documentUuid: string };

function normalizeSource(value: unknown, field: string): NetlistSource {
	if (typeof value === 'string' && value.trim().length > 0) {
		return value.trim();
	}
	if (isPlainObjectRecord(value) && typeof value.projectUuid === 'string' && typeof value.documentUuid === 'string'
		&& value.projectUuid.trim().length > 0 && value.documentUuid.trim().length > 0) {
		return { projectUuid: value.projectUuid.trim(), documentUuid: value.documentUuid.trim() };
	}
	throw new TypeError(`${field} must be a document UUID or { projectUuid, documentUuid }.`);
}

export async function handleNetlistCompareTask(payload: unknown): Promise<unknown> {
	if (!isPlainObjectRecord(payload)) {
		throw new TypeError('netlist_compare payload must be an object.');
	}
	const sourceA = normalizeSource(payload.sourceA, 'sourceA');
	const sourceB = normalizeSource(payload.sourceB, 'sourceB');
	const eda = (globalThis as unknown as { eda?: Record<string, unknown> }).eda;
	const api = eda?.sys_Tool;
	if (!isPlainObjectRecord(api) || typeof api.netlistComparison !== 'function') {
		throw new TypeError('EDA sys_Tool.netlistComparison API is unavailable in this client version.');
	}
	const differences = await toSerializableAsync(await (api.netlistComparison as (a: NetlistSource, b: NetlistSource) => Promise<unknown>).call(api, sourceA, sourceB));
	if (!Array.isArray(differences)) {
		return { ok: true, sourceA, sourceB, differenceCount: 0, differences };
	}
	const byType = differences.reduce<Record<string, number>>((counts, difference) => {
		const type = isPlainObjectRecord(difference) && typeof difference.type === 'string' ? difference.type : 'Unknown';
		counts[type] = (counts[type] ?? 0) + 1;
		return counts;
	}, {});
	return { ok: differences.length === 0, sourceA, sourceB, differenceCount: differences.length, byType, differences };
}
