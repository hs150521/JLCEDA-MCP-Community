import { isPlainObjectRecord, toSerializableAsync } from '../utils.ts';

type ConstraintKind = 'current_rules' | 'net_classes' | 'differential_pairs' | 'equal_length_groups' | 'pad_pair_groups';

const METHOD_BY_KIND: Record<ConstraintKind, string> = {
	current_rules: 'getCurrentRuleConfiguration',
	net_classes: 'getAllNetClasses',
	differential_pairs: 'getAllDifferentialPairs',
	equal_length_groups: 'getAllEqualLengthNetGroups',
	pad_pair_groups: 'getAllPadPairGroups',
};

export async function handlePcbConstraintsQueryTask(payload: unknown): Promise<unknown> {
	if (payload !== undefined && payload !== null && !isPlainObjectRecord(payload)) {
		throw new TypeError('pcb_constraints_query payload must be an object.');
	}
	const input = isPlainObjectRecord(payload) ? payload : {};
	const kind = input.kind === undefined ? 'current_rules' : input.kind;
	if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(METHOD_BY_KIND, kind)) {
		throw new TypeError(`kind must be one of: ${Object.keys(METHOD_BY_KIND).join(', ')}.`);
	}
	const eda = (globalThis as unknown as { eda?: Record<string, unknown> }).eda;
	const api = eda?.pcb_Drc;
	const methodName = METHOD_BY_KIND[kind as ConstraintKind];
	if (!isPlainObjectRecord(api) || typeof api[methodName] !== 'function') {
		throw new TypeError(`EDA pcb_Drc.${methodName} API is unavailable in this client version.`);
	}
	const result = await toSerializableAsync(await (api[methodName] as () => Promise<unknown>).call(api));
	const items = Array.isArray(result) ? result : undefined;
	return {
		ok: true,
		kind,
		...(items ? { count: items.length, items } : { result }),
	};
}
