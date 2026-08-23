import { isPlainObjectRecord, parseBoundedIntegerValue, preserveBoundedArray } from '../utils.ts';

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
	const eda = (globalThis as unknown as { eda?: Record<string, unknown> }).eda;
	const api = eda?.sys_FileManager;
	if (!isPlainObjectRecord(api))
		throw new TypeError('EDA sys_FileManager API is unavailable in this client version.');
	return api;
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
	const getDocumentFootprintSources = api.getDocumentFootprintSources;
	if (typeof getDocumentFootprintSources !== 'function')
		throw new TypeError('EDA sys_FileManager.getDocumentFootprintSources API is unavailable in this client version.');
	const rawSources = await (getDocumentFootprintSources as () => Promise<unknown>).call(api);
	if (!Array.isArray(rawSources))
		throw new TypeError('EDA sys_FileManager.getDocumentFootprintSources returned an invalid result.');
	const limit = parseBoundedIntegerValue(input.limit, 50, 1, MAX_FOOTPRINTS);
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
	return { ok: true, action, total: rawSources.length, returned: sources.length, truncated: rawSources.length > limit, sources };
}
