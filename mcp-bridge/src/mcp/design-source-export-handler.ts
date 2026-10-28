import { getEdaRuntime, isPlainObjectRecord, parseBoundedIntegerValue, preserveBoundedArray } from '../utils.ts';

type SourceAction = 'document' | 'footprints';

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const MAX_BYTES = 8 * 1024 * 1024;
const MIN_MAX_BYTES = 64 * 1024;
const DEFAULT_PREVIEW_BYTES = 16 * 1024;
const MAX_PREVIEW_BYTES = 64 * 1024;
const MAX_FOOTPRINTS = 100;

function sourceAction(value: unknown): SourceAction {
	if (value === undefined || value === null)
		return 'document';
	if (value !== 'document' && value !== 'footprints')
		throw new TypeError('action must be document or footprints.');
	return value;
}

function boundedInteger(value: unknown, defaultValue: number, minimum: number, maximum: number, name: string): number {
	if (value === undefined || value === null)
		return defaultValue;
	if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum)
		throw new RangeError(`${name} must be an integer between ${String(minimum)} and ${String(maximum)}.`);
	return value as number;
}

function readIncludeData(value: unknown): boolean {
	if (value === undefined || value === null)
		return false;
	if (typeof value !== 'boolean')
		throw new TypeError('includeData must be a boolean.');
	return value;
}

function getFileManager(): Record<string, unknown> {
	const eda = getEdaRuntime();
	const api = eda?.sys_FileManager;
	if (!isPlainObjectRecord(api))
		throw new TypeError('EDA sys_FileManager API is unavailable in this client version.');
	return api;
}

async function readReferencedFootprintUuids(eda: Record<string, unknown>): Promise<{ available: boolean; uuids: string[] }> {
	const api = eda.pcb_PrimitiveComponent;
	if (!isPlainObjectRecord(api) || typeof api.getAll !== 'function')
		return { available: false, uuids: [] };
	let components: unknown;
	try {
		components = await (api.getAll as () => Promise<unknown>).call(api);
	}
	catch {
		return { available: false, uuids: [] };
	}
	if (!Array.isArray(components))
		return { available: false, uuids: [] };
	const uuids = new Set<string>();
	let available = true;
	for (const component of components) {
		try {
			const getter = (component as Record<string, unknown> | null)?.getState_Footprint;
			if (typeof getter !== 'function') {
				available = false;
				continue;
			}
			const reference: unknown = getter.call(component);
			// The native API uses undefined for a component without a library footprint.
			if (reference === undefined)
				continue;
			if (isPlainObjectRecord(reference) && typeof reference.uuid === 'string' && reference.uuid.trim())
				uuids.add(reference.uuid);
			else
				available = false;
		}
		catch {
			available = false;
		}
	}
	return { available, uuids: [...uuids] };
}

function textBytes(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

function sourceSummary(value: string, includeData: boolean, maxBytes: number, previewBytes: number): Record<string, unknown> {
	const bytes = textBytes(value);
	const output: Record<string, unknown> = { bytes: bytes.length };
	if (previewBytes > 0) {
		output.preview = new TextDecoder().decode(bytes.slice(0, previewBytes));
		if (bytes.length > previewBytes)
			output.previewTruncated = true;
	}
	if (includeData) {
		if (bytes.length > maxBytes)
			output.dataOmitted = `Source exceeds requested ${String(maxBytes)} byte limit.`;
		else
			output.data = value;
	}
	return output;
}

export async function handleDesignSourceExportTask(payload: unknown): Promise<unknown> {
	if (payload !== undefined && payload !== null && !isPlainObjectRecord(payload))
		throw new TypeError('design_source_export payload must be an object.');
	const input = isPlainObjectRecord(payload) ? payload : {};
	const action = sourceAction(input.action);
	const includeData = readIncludeData(input.includeData);
	const maxBytes = boundedInteger(input.maxBytes, DEFAULT_MAX_BYTES, MIN_MAX_BYTES, MAX_BYTES, 'maxBytes');
	const previewBytes = boundedInteger(input.previewBytes, DEFAULT_PREVIEW_BYTES, 0, MAX_PREVIEW_BYTES, 'previewBytes');
	const api = getFileManager();
	if (action === 'document') {
		const getDocumentSource = api.getDocumentSource;
		if (typeof getDocumentSource !== 'function')
			throw new TypeError('EDA sys_FileManager.getDocumentSource API is unavailable in this client version.');
		const source = await (getDocumentSource as () => Promise<unknown>).call(api);
		if (source === undefined || source === null)
			return { ok: false, action, source: null, reason: 'No document source is available for the active editor.' };
		if (typeof source !== 'string')
			throw new TypeError('EDA sys_FileManager.getDocumentSource returned an invalid result.');
		return { ok: true, action, source: sourceSummary(source, includeData, maxBytes, previewBytes) };
	}
	const eda = getEdaRuntime();
	const references = eda ? await readReferencedFootprintUuids(eda) : { available: false, uuids: [] };
	const getDocumentFootprintSources = api.getDocumentFootprintSources;
	if (typeof getDocumentFootprintSources !== 'function') {
		return {
			ok: false,
			action,
			complete: false,
			total: 0,
			returned: 0,
			truncated: false,
			sources: [],
			referencedFootprintUuids: references.uuids,
			reason: references.available ? 'native_footprint_sources_api_unavailable' : 'pcb_footprint_reference_inventory_unavailable',
		};
	}
	const rawSources = await (getDocumentFootprintSources as () => Promise<unknown>).call(api);
	if (!Array.isArray(rawSources))
		throw new TypeError('EDA sys_FileManager.getDocumentFootprintSources returned an invalid result.');
	if (rawSources.length === 0 && references.uuids.length > 0) {
		return {
			ok: false,
			action,
			complete: false,
			total: 0,
			returned: 0,
			truncated: false,
			sources: [],
			referencedFootprintUuids: references.uuids,
			reason: 'native_footprint_sources_empty_for_populated_pcb',
		};
	}
	const limit = parseBoundedIntegerValue(input.limit, 50, 1, MAX_FOOTPRINTS);
	const truncated = rawSources.length > limit;
	const listedUuids = new Set(rawSources
		.filter((item): item is Record<string, unknown> => isPlainObjectRecord(item) && typeof item.footprintUuid === 'string')
		.map(item => item.footprintUuid as string));
	// A partial native list must not read as a complete inventory of the PCB.
	const missingReferencedFootprintUuids = references.uuids.filter(uuid => !listedUuids.has(uuid));
	let remainingDataBytes = maxBytes;
	const sources = preserveBoundedArray(rawSources.slice(0, limit).map((item, index) => {
		if (!isPlainObjectRecord(item) || typeof item.footprintUuid !== 'string' || typeof item.documentSource !== 'string')
			throw new TypeError(`EDA sys_FileManager.getDocumentFootprintSources returned an invalid item at index ${String(index)}.`);
		const source = sourceSummary(item.documentSource, includeData, maxBytes, previewBytes);
		if (includeData && typeof source.data === 'string') {
			const bytes = source.bytes as number;
			if (bytes > remainingDataBytes) {
				delete source.data;
				source.dataOmitted = `Source exceeds remaining ${String(remainingDataBytes)} byte response budget.`;
			}
			else {
				remainingDataBytes -= bytes;
			}
		}
		return {
			footprintUuid: item.footprintUuid,
			source,
		};
	}));
	return {
		ok: true,
		action,
		complete: references.available && !truncated && missingReferencedFootprintUuids.length === 0,
		total: rawSources.length,
		returned: sources.length,
		truncated,
		...(!references.available
			? { referencedFootprintUuids: references.uuids, reason: 'pcb_footprint_reference_inventory_unavailable' }
			: {}),
		...(missingReferencedFootprintUuids.length > 0
			? { referencedFootprintUuids: references.uuids, missingReferencedFootprintUuids, missingReferencedFootprintCount: missingReferencedFootprintUuids.length }
			: {}),
		sources,
	};
}
