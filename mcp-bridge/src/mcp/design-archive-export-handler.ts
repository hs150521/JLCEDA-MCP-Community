import { isPlainObjectRecord } from '../utils.ts';

type ArchiveAction = 'project' | 'document' | 'project_by_uuid';

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const MIN_MAX_BYTES = 64 * 1024;
const MAX_BYTES = 8 * 1024 * 1024;

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
	if (input[key] === undefined || input[key] === null)
		return undefined;
	if (typeof input[key] !== 'string' || input[key].trim().length === 0)
		throw new TypeError(`${key} must be a non-empty string.`);
	return input[key].trim();
}

function requiredString(input: Record<string, unknown>, key: string): string {
	const value = optionalString(input, key);
	if (!value)
		throw new TypeError(`${key} is required.`);
	return value;
}

function parseAction(value: unknown): ArchiveAction {
	if (value === undefined || value === null)
		return 'project';
	if (value !== 'project' && value !== 'document' && value !== 'project_by_uuid')
		throw new TypeError('action must be project, document, or project_by_uuid.');
	return value;
}

function parseFileType(value: unknown): 'epro' | 'epro2' | undefined {
	if (value === undefined || value === null)
		return undefined;
	if (value !== 'epro' && value !== 'epro2')
		throw new TypeError('fileType must be epro or epro2.');
	return value;
}

function parseMaxBytes(value: unknown): number {
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

export async function handleDesignArchiveExportTask(payload: unknown): Promise<unknown> {
	if (payload !== undefined && payload !== null && !isPlainObjectRecord(payload))
		throw new TypeError('design_archive_export payload must be an object.');
	const input = isPlainObjectRecord(payload) ? payload : {};
	const action = parseAction(input.action);
	const fileName = optionalString(input, 'fileName');
	const fileType = parseFileType(input.fileType);
	const projectUuid = action === 'project_by_uuid' ? requiredString(input, 'projectUuid') : undefined;
	const includeData = input.includeData === undefined ? false : input.includeData;
	if (typeof includeData !== 'boolean')
		throw new TypeError('includeData must be a boolean.');
	const maxBytes = parseMaxBytes(input.maxBytes);
	const eda = (globalThis as unknown as { eda?: Record<string, unknown> }).eda;
	const api = eda?.sys_FileManager;
	if (!isPlainObjectRecord(api))
		throw new TypeError('EDA sys_FileManager API is unavailable in this client version.');
	const methodName = action === 'project'
		? 'getProjectFile'
		: action === 'document'
			? 'getDocumentFile'
			: 'getProjectFileByProjectUuid';
	if (typeof api[methodName] !== 'function')
		throw new TypeError(`EDA sys_FileManager.${methodName} API is unavailable in this client version.`);
	const args = action === 'project_by_uuid'
		? [projectUuid, fileName, undefined, fileType]
		: [fileName, undefined, fileType];
	const archive = await (api[methodName] as (...values: unknown[]) => Promise<unknown>).apply(api, args);
	if (archive === undefined || archive === null)
		return { ok: false, action, ...(projectUuid ? { projectUuid } : {}), archive: null, reason: 'No archive is available for the requested design.' };
	if (!(typeof Blob !== 'undefined' && archive instanceof Blob))
		throw new TypeError(`EDA sys_FileManager.${methodName} returned an invalid archive.`);
	const file = archive as Blob & { name?: string };
	const output: Record<string, unknown> = { kind: 'file', name: file.name ?? '', type: file.type, size: file.size };
	if (includeData) {
		if (file.size > maxBytes) {
			output.dataOmitted = `Archive exceeds requested ${String(maxBytes)} byte limit.`;
		}
		else {
			output.dataBase64 = encodeBase64(new Uint8Array(await file.arrayBuffer()));
			output.encoding = 'base64';
		}
	}
	return { ok: true, action, ...(projectUuid ? { projectUuid } : {}), archive: output };
}
