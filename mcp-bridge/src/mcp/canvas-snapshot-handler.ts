import { getEdaRuntime, isPlainObjectRecord } from '../utils.ts';

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const MAX_BYTES = 8 * 1024 * 1024;
const MIN_MAX_BYTES = 64 * 1024;

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
	if (input[key] === undefined || input[key] === null)
		return undefined;
	if (typeof input[key] !== 'string' || input[key].trim().length === 0)
		throw new TypeError(`${key} must be a non-empty string.`);
	return input[key].trim();
}

function boundedMaxBytes(value: unknown): number {
	if (value === undefined || value === null)
		return DEFAULT_MAX_BYTES;
	if (!Number.isInteger(value) || (value as number) < MIN_MAX_BYTES || (value as number) > MAX_BYTES)
		throw new RangeError(`maxBytes must be an integer between ${String(MIN_MAX_BYTES)} and ${String(MAX_BYTES)}.`);
	return value as number;
}

function encodeBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += 0x8000)
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	return globalThis.btoa(binary);
}

export async function handleCanvasSnapshotTask(payload: unknown): Promise<unknown> {
	if (payload !== undefined && payload !== null && !isPlainObjectRecord(payload))
		throw new TypeError('eda_canvas_snapshot payload must be an object.');
	const input = isPlainObjectRecord(payload) ? payload : {};
	const tabId = optionalString(input, 'tabId');
	const includeData = input.includeData === undefined ? false : input.includeData;
	if (typeof includeData !== 'boolean')
		throw new TypeError('includeData must be a boolean.');
	const maxBytes = boundedMaxBytes(input.maxBytes);
	const eda = getEdaRuntime();
	const api = eda?.dmt_EditorControl;
	if (!isPlainObjectRecord(api) || typeof api.getCurrentRenderedAreaImage !== 'function')
		throw new TypeError('EDA dmt_EditorControl.getCurrentRenderedAreaImage API is unavailable in this client version.');
	const image = await (api.getCurrentRenderedAreaImage as (targetTabId?: string) => Promise<unknown>).call(api, tabId);
	if (image === undefined || image === null)
		return { ok: false, ...(tabId ? { tabId } : {}), image: null, reason: 'No rendered canvas image is available.' };
	if (!(typeof Blob !== 'undefined' && image instanceof Blob))
		throw new TypeError('EDA dmt_EditorControl.getCurrentRenderedAreaImage returned an invalid image.');
	const output: Record<string, unknown> = { kind: 'file', type: image.type, size: image.size };
	if (includeData) {
		if (image.size > maxBytes) {
			output.dataOmitted = `Image exceeds requested ${String(maxBytes)} byte limit.`;
		}
		else {
			output.dataBase64 = encodeBase64(new Uint8Array(await image.arrayBuffer()));
			output.encoding = 'base64';
		}
	}
	return { ok: true, ...(tabId ? { tabId } : {}), image: output };
}
