import { isPlainObjectRecord, toSerializableAsync } from '../utils.ts';

type AutoOperation = 'layout' | 'routing';

interface PcbDocumentApi {
	context: unknown;
	autoLayout?: (this: unknown) => Promise<unknown>;
	autoRouting?: (this: unknown, props?: Record<string, unknown>) => Promise<unknown>;
}

function resolvePcbDocumentApi(operation: AutoOperation): PcbDocumentApi {
	const edaGlobal = (globalThis as unknown as { eda?: unknown }).eda;
	if (!isPlainObjectRecord(edaGlobal) || !isPlainObjectRecord(edaGlobal.pcb_Document)) {
		throw new TypeError('EDA PCB document API is unavailable. Open a PCB document first.');
	}

	const api = edaGlobal.pcb_Document as PcbDocumentApi;
	if (typeof api[operation === 'layout' ? 'autoLayout' : 'autoRouting'] !== 'function') {
		throw new TypeError(`EDA pcb_Document.auto${operation === 'layout' ? 'Layout' : 'Routing'} API is unavailable in this client version.`);
	}
	return api;
}

function normalizeUuids(input: Record<string, unknown>): string[] | undefined {
	if (input.uuids === undefined || input.uuids === null) {
		return undefined;
	}
	if (!Array.isArray(input.uuids) || input.uuids.some(uuid => typeof uuid !== 'string' || uuid.trim().length === 0)) {
		throw new TypeError('uuids must be an array of non-empty strings.');
	}
	return input.uuids.map(uuid => uuid.trim());
}

function normalizeStringArray(input: Record<string, unknown>, key: string): string[] | undefined {
	if (input[key] === undefined || input[key] === null) {
		return undefined;
	}
	if (!Array.isArray(input[key]) || input[key].some(value => typeof value !== 'string' || value.trim().length === 0)) {
		throw new TypeError(`${key} must be an array of non-empty strings.`);
	}
	return input[key].map(value => value.trim());
}

function normalizeRoutingProps(input: Record<string, unknown>): Record<string, unknown> | undefined {
	const routingNets = input.routingNets === 'selected' || input.routingNets === 'selectedComponents'
		? input.routingNets
		: normalizeStringArray(input, 'routingNets');
	const ignoreNets = normalizeStringArray(input, 'ignoreNets');
	const props: Record<string, unknown> = {};
	if (routingNets !== undefined)
		props.RoutingNets = routingNets;
	if (ignoreNets !== undefined)
		props.ignoreNets = ignoreNets;
	for (const key of ['cornerStyle', 'existingPrimitiveMode', 'optimization', 'layers']) {
		if (input[key] !== undefined)
			props[key] = input[key];
	}
	if (props.cornerStyle !== undefined && props.cornerStyle !== 0 && props.cornerStyle !== 1) {
		throw new TypeError('cornerStyle must be 0 (45 degrees) or 1 (90 degrees).');
	}
	if (props.existingPrimitiveMode !== undefined && props.existingPrimitiveMode !== 'keep' && props.existingPrimitiveMode !== 'remove') {
		throw new TypeError('existingPrimitiveMode must be \'keep\' or \'remove\'.');
	}
	if (props.optimization !== undefined && props.optimization !== 0 && props.optimization !== 1) {
		throw new TypeError('optimization must be 0 (faster) or 1 (completion).');
	}
	if (props.layers !== undefined && (!Array.isArray(props.layers) || props.layers.some(layer => !Number.isInteger(layer)))) {
		throw new TypeError('layers must be an array of integer layer IDs.');
	}
	return Object.keys(props).length > 0 ? props : undefined;
}

export async function handlePcbAutoTask(payload: unknown, operation: AutoOperation): Promise<unknown> {
	if (payload !== undefined && payload !== null && !isPlainObjectRecord(payload)) {
		throw new TypeError(`pcb_auto_${operation} payload must be an object.`);
	}
	const input = isPlainObjectRecord(payload) ? payload : {};
	const uuids = operation === 'layout' ? normalizeUuids(input) : undefined;
	const api = resolvePcbDocumentApi(operation);
	const method = api[operation === 'layout' ? 'autoLayout' : 'autoRouting'];
	const routingProps = operation === 'routing' ? normalizeRoutingProps(input) : undefined;
	const rawResult = operation === 'routing'
		? await method!.call(api.context, routingProps)
		: await method!.call(api.context);
	return {
		ok: true,
		operation,
		...(uuids ? { requestedUuids: uuids, requestedCount: uuids.length } : {}),
		...(routingProps ? { routingProps } : {}),
		result: await toSerializableAsync(rawResult),
	};
}

export async function handlePcbAutoLayoutTask(payload: unknown): Promise<unknown> {
	return handlePcbAutoTask(payload, 'layout');
}

export async function handlePcbAutoRoutingTask(payload: unknown): Promise<unknown> {
	return handlePcbAutoTask(payload, 'routing');
}
