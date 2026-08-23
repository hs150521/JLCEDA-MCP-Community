import { getEdaRuntime, isPlainObjectRecord, toSerializableAsync } from '../utils.ts';

type AutoOperation = 'layout' | 'routing';
type PcbDocumentApi = Record<string, unknown>;

const MAX_ROUTING_NETS = 200;
const MAX_LAYERS = 32;

function rejectUnexpectedFields(input: Record<string, unknown>, allowed: readonly string[]): void {
	const permitted = new Set(['confirm', 'timeoutMs', ...allowed]);
	for (const key of Object.keys(input)) {
		if (!permitted.has(key))
			throw new TypeError(`${key} is not supported for this PCB automation operation.`);
	}
}

function getPcbDocumentApi(operation: AutoOperation): PcbDocumentApi {
	const eda = getEdaRuntime();
	const api = eda?.pcb_Document;
	const method = operation === 'layout' ? 'autoLayout' : 'autoRouting';
	if (!isPlainObjectRecord(api) || typeof api[method] !== 'function')
		throw new TypeError(`EDA pcb_Document.${method} API is unavailable in this PCB client version.`);
	return api;
}

function nonEmptyStringArray(value: unknown, key: string, maximum: number): string[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > maximum)
		throw new RangeError(`${key} must contain between 1 and ${String(maximum)} non-empty strings.`);
	const values = value.map((item, index) => {
		if (typeof item !== 'string' || item.trim().length === 0)
			throw new TypeError(`${key}[${String(index)}] must be a non-empty string.`);
		return item.trim();
	});
	if (new Set(values).size !== values.length)
		throw new TypeError(`${key} must not contain duplicates.`);
	return values;
}

function optionalStringArray(value: unknown, key: string, maximum: number): string[] | undefined {
	if (value === undefined)
		return undefined;
	return nonEmptyStringArray(value, key, maximum);
}

function normalizeRoutingProps(input: Record<string, unknown>): Record<string, unknown> {
	const routingNets = nonEmptyStringArray(input.routingNets, 'routingNets', MAX_ROUTING_NETS);
	const ignoreNets = optionalStringArray(input.ignoreNets, 'ignoreNets', MAX_ROUTING_NETS);
	const cornerStyle = input.cornerStyle === undefined ? undefined : input.cornerStyle;
	const optimization = input.optimization === undefined ? undefined : input.optimization;
	if (cornerStyle !== undefined && cornerStyle !== 0 && cornerStyle !== 1)
		throw new TypeError('cornerStyle must be 0 (45 degrees) or 1 (90 degrees).');
	if (optimization !== undefined && optimization !== 0 && optimization !== 1)
		throw new TypeError('optimization must be 0 (faster) or 1 (completion).');
	if (input.existingPrimitiveMode !== undefined && input.existingPrimitiveMode !== 'keep')
		throw new TypeError('existingPrimitiveMode is fixed to keep in pcb_auto_routing.');

	let layers: number[] | undefined;
	if (input.layers !== undefined) {
		if (!Array.isArray(input.layers) || input.layers.length < 1 || input.layers.length > MAX_LAYERS || input.layers.some(layer => !Number.isInteger(layer)))
			throw new RangeError(`layers must contain between 1 and ${String(MAX_LAYERS)} integer layer IDs.`);
		layers = input.layers as number[];
		if (new Set(layers).size !== layers.length)
			throw new TypeError('layers must not contain duplicates.');
	}

	return {
		RoutingNets: routingNets,
		existingPrimitiveMode: 'keep',
		...(ignoreNets ? { ignoreNets } : {}),
		...(cornerStyle !== undefined ? { cornerStyle } : {}),
		...(optimization !== undefined ? { optimization } : {}),
		...(layers ? { layers } : {}),
	};
}

async function resultSummary(rawResult: unknown, operation: AutoOperation): Promise<Record<string, unknown>> {
	if (!isPlainObjectRecord(rawResult))
		return { result: await toSerializableAsync(rawResult) };
	const totalKey = operation === 'layout' ? 'totalComponentsCount' : 'totalNetsCount';
	const completedKey = operation === 'layout' ? 'successComponentsCount' : 'successNetsCount';
	const failedKey = operation === 'layout' ? 'failedComponents' : 'failedNets';
	const failed = Array.isArray(rawResult[failedKey]) ? rawResult[failedKey].slice(0, 120) : [];
	return {
		success: rawResult.success === true,
		total: typeof rawResult[totalKey] === 'number' ? rawResult[totalKey] : undefined,
		completed: typeof rawResult[completedKey] === 'number' ? rawResult[completedKey] : undefined,
		failed: await toSerializableAsync(failed),
		failedTruncated: Array.isArray(rawResult[failedKey]) && rawResult[failedKey].length > failed.length,
		durationMs: typeof rawResult.duration === 'number' ? rawResult.duration : undefined,
		result: await toSerializableAsync(rawResult),
	};
}

export async function handlePcbAutoTask(payload: unknown, operation: AutoOperation): Promise<unknown> {
	if (!isPlainObjectRecord(payload))
		throw new TypeError(`pcb_auto_${operation} payload must be an object.`);
	if (payload.confirm !== true)
		throw new TypeError('confirm must be true before running PCB auto-layout or auto-routing.');
	const api = getPcbDocumentApi(operation);
	if (operation === 'layout') {
		rejectUnexpectedFields(payload, []);
		const rawResult = await (api.autoLayout as () => Promise<unknown>).call(api);
		return { ok: true, operation, scope: 'all_components', ...(await resultSummary(rawResult, operation)) };
	}

	rejectUnexpectedFields(payload, ['routingNets', 'ignoreNets', 'cornerStyle', 'existingPrimitiveMode', 'optimization', 'layers']);
	const routingProps = normalizeRoutingProps(payload);
	const rawResult = await (api.autoRouting as (props: Record<string, unknown>) => Promise<unknown>).call(api, routingProps);
	return { ok: true, operation, routingProps, ...(await resultSummary(rawResult, operation)) };
}

export const handlePcbAutoLayoutTask = (payload: unknown): Promise<unknown> => handlePcbAutoTask(payload, 'layout');
export const handlePcbAutoRoutingTask = (payload: unknown): Promise<unknown> => handlePcbAutoTask(payload, 'routing');
