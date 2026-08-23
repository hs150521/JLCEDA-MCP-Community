import { getEdaRuntime, isPlainObjectRecord, toSerializableAsync } from '../utils.ts';

type ConstraintGroupKind = 'net_class' | 'differential_pair' | 'equal_length_group' | 'pad_pair_group';
type ConstraintOperation = 'create' | 'delete' | 'rename' | 'add_members' | 'remove_members' | 'set_positive_net' | 'set_negative_net';

interface Color {
	r: number;
	g: number;
	b: number;
	alpha: number;
}

const GROUPS: Record<ConstraintGroupKind, { list: string; create: string; remove: string; rename: string; add?: string; removeMembers?: string }> = {
	net_class: {
		list: 'getAllNetClasses',
		create: 'createNetClass',
		remove: 'deleteNetClass',
		rename: 'modifyNetClassName',
		add: 'addNetToNetClass',
		removeMembers: 'removeNetFromNetClass',
	},
	differential_pair: {
		list: 'getAllDifferentialPairs',
		create: 'createDifferentialPair',
		remove: 'deleteDifferentialPair',
		rename: 'modifyDifferentialPairName',
	},
	equal_length_group: {
		list: 'getAllEqualLengthNetGroups',
		create: 'createEqualLengthNetGroup',
		remove: 'deleteEqualLengthNetGroup',
		rename: 'modifyEqualLengthNetGroupName',
		add: 'addNetToEqualLengthNetGroup',
		removeMembers: 'removeNetFromEqualLengthNetGroup',
	},
	pad_pair_group: {
		list: 'getAllPadPairGroups',
		create: 'createPadPairGroup',
		remove: 'deletePadPairGroup',
		rename: 'modifyPadPairGroupName',
		add: 'addPadPairToPadPairGroup',
		removeMembers: 'removePadPairFromPadPairGroup',
	},
};

function requiredString(input: Record<string, unknown>, key: string): string {
	if (typeof input[key] !== 'string' || input[key].trim().length === 0)
		throw new TypeError(`${key} is required and must be a non-empty string.`);
	return input[key].trim();
}

function parseKind(value: unknown): ConstraintGroupKind {
	if (value !== 'net_class' && value !== 'differential_pair' && value !== 'equal_length_group' && value !== 'pad_pair_group')
		throw new TypeError('kind must be net_class, differential_pair, equal_length_group, or pad_pair_group.');
	return value;
}

function parseOperation(value: unknown): ConstraintOperation {
	if (value !== 'create' && value !== 'delete' && value !== 'rename' && value !== 'add_members' && value !== 'remove_members' && value !== 'set_positive_net' && value !== 'set_negative_net')
		throw new TypeError('operation must be create, delete, rename, add_members, remove_members, set_positive_net, or set_negative_net.');
	return value;
}

function parseNames(value: unknown, key: string): string[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > 100)
		throw new RangeError(`${key} must contain between 1 and 100 names.`);
	const values = value.map((item, index) => {
		if (typeof item !== 'string' || item.trim().length === 0)
			throw new TypeError(`${key}[${String(index)}] must be a non-empty string.`);
		return item.trim();
	});
	if (new Set(values).size !== values.length)
		throw new TypeError(`${key} must not contain duplicates.`);
	return values;
}

function parseColor(value: unknown): Color {
	if (!isPlainObjectRecord(value))
		throw new TypeError('color is required and must be an object with r, g, b, and alpha.');
	const channels = ['r', 'g', 'b'] as const;
	for (const key of channels) {
		if (!Number.isInteger(value[key]) || (value[key] as number) < 0 || (value[key] as number) > 255)
			throw new RangeError(`color.${key} must be an integer between 0 and 255.`);
	}
	if (typeof value.alpha !== 'number' || !Number.isFinite(value.alpha) || value.alpha < 0 || value.alpha > 1)
		throw new RangeError('color.alpha must be a number between 0 and 1.');
	return { r: value.r as number, g: value.g as number, b: value.b as number, alpha: value.alpha };
}

function parsePadPairs(value: unknown): Array<[string, string]> {
	if (!Array.isArray(value) || value.length < 1 || value.length > 100)
		throw new RangeError('padPairs must contain between 1 and 100 pairs.');
	const seen = new Set<string>();
	return value.map((pair, index) => {
		if (!Array.isArray(pair) || pair.length !== 2 || pair.some(item => typeof item !== 'string' || item.trim().length === 0))
			throw new TypeError(`padPairs[${String(index)}] must contain exactly two non-empty pad references.`);
		const normalized: [string, string] = [pair[0].trim(), pair[1].trim()];
		const key = normalized.join('\u0000');
		if (seen.has(key))
			throw new TypeError('padPairs must not contain duplicates.');
		seen.add(key);
		return normalized;
	});
}

function rejectUnexpectedFields(input: Record<string, unknown>, allowed: readonly string[]): void {
	const allowedFields = new Set(['kind', 'operation', 'name', 'confirm', ...allowed]);
	for (const key of Object.keys(input)) {
		if (!allowedFields.has(key))
			throw new TypeError(`${key} is not supported for this PCB constraint operation.`);
	}
}

function findReadbackItem(items: unknown, targetName: unknown): { total: number | undefined; item: unknown } {
	if (Array.isArray(items)) {
		return {
			total: items.length,
			item: items.find(item => isPlainObjectRecord(item) && item.name === targetName),
		};
	}
	if (!isPlainObjectRecord(items))
		return { total: undefined, item: undefined };

	// Some EDA builds expose differential-pair groups as a name-keyed object
	// instead of the array shape used by the type declaration.
	const directItem = items[String(targetName)];
	if (directItem !== undefined)
		return { total: Object.keys(items).length, item: directItem };
	const item = Object.values(items).find(value => isPlainObjectRecord(value) && value.name === targetName);
	return { total: Object.keys(items).length, item };
}

export async function handlePcbConstraintsManageTask(payload: unknown): Promise<unknown> {
	if (!isPlainObjectRecord(payload))
		throw new TypeError('pcb_constraints_manage payload must be an object.');
	if (payload.confirm !== true)
		throw new TypeError('confirm must be true before modifying PCB constraints.');
	const kind = parseKind(payload.kind);
	const operation = parseOperation(payload.operation);
	const name = requiredString(payload, 'name');
	const config = GROUPS[kind];
	const eda = getEdaRuntime();
	const api = eda?.pcb_Drc;
	if (!isPlainObjectRecord(api))
		throw new TypeError('EDA pcb_Drc API is unavailable in this client version.');

	let methodName: string;
	let args: unknown[];
	if (operation === 'create') {
		if (kind === 'differential_pair') {
			rejectUnexpectedFields(payload, ['positiveNet', 'negativeNet']);
			methodName = config.create;
			args = [name, requiredString(payload, 'positiveNet'), requiredString(payload, 'negativeNet')];
		}
		else if (kind === 'pad_pair_group') {
			rejectUnexpectedFields(payload, ['padPairs']);
			methodName = config.create;
			args = [name, parsePadPairs(payload.padPairs)];
		}
		else {
			rejectUnexpectedFields(payload, ['nets', 'color']);
			methodName = config.create;
			args = [name, parseNames(payload.nets, 'nets'), parseColor(payload.color)];
		}
	}
	else if (operation === 'delete') {
		rejectUnexpectedFields(payload, []);
		methodName = config.remove;
		args = [name];
	}
	else if (operation === 'rename') {
		rejectUnexpectedFields(payload, ['newName']);
		methodName = config.rename;
		args = [name, requiredString(payload, 'newName')];
	}
	else if (operation === 'add_members' || operation === 'remove_members') {
		if (!config.add || !config.removeMembers)
			throw new TypeError(`${operation} is not supported for ${kind}.`);
		const padPairs = kind === 'pad_pair_group';
		rejectUnexpectedFields(payload, [padPairs ? 'padPairs' : 'nets']);
		methodName = operation === 'add_members' ? config.add : config.removeMembers;
		args = [name, padPairs ? parsePadPairs(payload.padPairs) : parseNames(payload.nets, 'nets')];
	}
	else {
		if (kind !== 'differential_pair')
			throw new TypeError(`${operation} is only supported for differential_pair.`);
		const field = operation === 'set_positive_net' ? 'positiveNet' : 'negativeNet';
		rejectUnexpectedFields(payload, [field]);
		methodName = operation === 'set_positive_net' ? 'modifyDifferentialPairPositiveNet' : 'modifyDifferentialPairNegativeNet';
		args = [name, requiredString(payload, field)];
	}

	if (typeof api[methodName] !== 'function')
		throw new TypeError(`EDA pcb_Drc.${methodName} API is unavailable in this client version.`);
	const changed = await (api[methodName] as (...values: unknown[]) => Promise<unknown>).apply(api, args);
	if (typeof api[config.list] !== 'function')
		throw new TypeError(`EDA pcb_Drc.${config.list} API is unavailable for read-back verification.`);
	const items = await toSerializableAsync(await (api[config.list] as () => Promise<unknown>).call(api));
	const targetName = operation === 'rename' ? args[1] : name;
	const readback = findReadbackItem(items, targetName);
	return {
		ok: changed === true,
		kind,
		operation,
		name,
		...(operation === 'rename' ? { newName: targetName } : {}),
		changed,
		readback: {
			total: readback.total,
			item: readback.item,
		},
	};
}
