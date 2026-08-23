import { getEdaRuntime, isPlainObjectRecord } from '../utils.ts';

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const MIN_MAX_BYTES = 64 * 1024;
const MAX_BYTES = 8 * 1024 * 1024;

function requiredString(input: Record<string, unknown>, key: string): string {
	if (typeof input[key] !== 'string' || input[key].trim().length === 0)
		throw new TypeError(`${key} is required and must be a non-empty string.`);
	return input[key].trim();
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
	if (input[key] === undefined || input[key] === null)
		return undefined;
	return requiredString(input, key);
}

function maxBytes(value: unknown): number {
	if (value === undefined || value === null)
		return DEFAULT_MAX_BYTES;
	if (!Number.isInteger(value) || (value as number) < MIN_MAX_BYTES || (value as number) > MAX_BYTES)
		throw new RangeError(`maxBytes must be an integer between ${String(MIN_MAX_BYTES)} and ${String(MAX_BYTES)}.`);
	return value as number;
}

function toBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += 0x8000)
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	return globalThis.btoa(binary);
}

export async function handleLibraryPreviewTask(payload: unknown): Promise<unknown> {
	if (!isPlainObjectRecord(payload))
		throw new TypeError('library_preview payload must be an object.');
	const kind = payload.kind;
	if (kind !== 'symbol' && kind !== 'footprint')
		throw new TypeError('kind must be symbol or footprint.');
	const uuid = requiredString(payload, 'uuid');
	const libraryUuid = requiredString(payload, 'libraryUuid');
	const subPartName = optionalString(payload, 'subPartName');
	if (kind !== 'symbol' && subPartName !== undefined)
		throw new TypeError('subPartName is only supported for symbol previews.');
	const includeData = payload.includeData === undefined ? false : payload.includeData;
	if (typeof includeData !== 'boolean')
		throw new TypeError('includeData must be a boolean.');
	const limit = maxBytes(payload.maxBytes);
	const eda = getEdaRuntime();
	const moduleName = kind === 'symbol' ? 'lib_Symbol' : 'lib_Footprint';
	const api = eda?.[moduleName];
	if (!isPlainObjectRecord(api) || typeof api.getRenderImage !== 'function')
		throw new TypeError(`EDA ${moduleName}.getRenderImage API is unavailable in this client version.`);
	const request: Record<string, string> = kind === 'symbol'
		? { symbolUuid: uuid, libraryUuid, ...(subPartName ? { subPartName } : {}) }
		: { footprintUuid: uuid, libraryUuid };
	const image = await (api.getRenderImage as (input: Record<string, string>) => Promise<unknown>).call(api, request);
	if (image === undefined || image === null)
		return { ok: false, kind, uuid, libraryUuid, image: null, reason: 'No preview image is available for this library item.' };
	if (!(typeof Blob !== 'undefined' && image instanceof Blob))
		throw new TypeError(`EDA ${moduleName}.getRenderImage returned an invalid image.`);
	const output: Record<string, unknown> = { kind: 'file', type: image.type || 'application/octet-stream', size: image.size };
	if (includeData) {
		if (image.size > limit) {
			output.dataOmitted = `Image exceeds requested ${String(limit)} byte limit.`;
		}
		else {
			output.dataBase64 = toBase64(new Uint8Array(await image.arrayBuffer()));
			output.encoding = 'base64';
		}
	}
	return { ok: true, kind, uuid, libraryUuid, ...(subPartName ? { subPartName } : {}), image: output };
}
