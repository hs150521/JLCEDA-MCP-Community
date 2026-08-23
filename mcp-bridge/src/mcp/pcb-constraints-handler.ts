import { isPlainObjectRecord, toSerializableAsync } from '../utils.ts';

type ConstraintKind = 'current_rules' | 'rule_configuration' | 'rule_configurations' | 'net_rules' | 'net_to_net_rules' | 'region_rules' | 'net_classes' | 'differential_pairs' | 'equal_length_groups' | 'pad_pair_groups' | 'pad_pair_min_wire_length';

const METHOD_BY_KIND: Record<ConstraintKind, string> = {
	current_rules: 'getCurrentRuleConfiguration',
	rule_configuration: 'getRuleConfiguration',
	rule_configurations: 'getAllRuleConfigurations',
	net_rules: 'getNetRules',
	net_to_net_rules: 'getNetByNetRules',
	region_rules: 'getRegionRules',
	net_classes: 'getAllNetClasses',
	differential_pairs: 'getAllDifferentialPairs',
	equal_length_groups: 'getAllEqualLengthNetGroups',
	pad_pair_groups: 'getAllPadPairGroups',
	pad_pair_min_wire_length: 'getPadPairGroupMinWireLength',
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
	if (kind === 'rule_configuration') {
		if (typeof input.configurationName !== 'string' || input.configurationName.trim().length === 0)
			throw new TypeError('configurationName is required for rule_configuration.');
	}
	if (kind === 'pad_pair_min_wire_length') {
		if (typeof input.padPairGroupName !== 'string' || input.padPairGroupName.trim().length === 0)
			throw new TypeError('padPairGroupName is required for pad_pair_min_wire_length.');
	}
	if (input.includeSystem !== undefined && typeof input.includeSystem !== 'boolean')
		throw new TypeError('includeSystem must be a boolean.');
	const args = kind === 'rule_configuration'
		? [input.configurationName.trim()]
		: kind === 'pad_pair_min_wire_length'
			? [input.padPairGroupName.trim()]
			: kind === 'rule_configurations'
				? [input.includeSystem === undefined ? false : input.includeSystem]
				: [];
	const result = await toSerializableAsync(await (api[methodName] as (...args: unknown[]) => Promise<unknown>).call(api, ...args));
	const items = Array.isArray(result) ? result : undefined;
	return {
		ok: true,
		kind,
		...(items ? { count: items.length, items } : { result }),
	};
}
