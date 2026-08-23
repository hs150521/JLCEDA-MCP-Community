import { isPlainObjectRecord, toSerializableAsync } from '../utils.ts';

type PcbDocumentAction = 'status' | 'save' | 'start_ratline' | 'stop_ratline' | 'clear_routing' | 'import_changes' | 'import_auto_route_json' | 'import_auto_route_ses' | 'import_auto_layout_json';

const MAX_IMPORT_BYTES = 8 * 1024 * 1024;

interface PcbDocumentApi {
	getCalculatingRatlineStatus?: () => Promise<unknown>;
	startCalculatingRatline?: () => Promise<unknown>;
	stopCalculatingRatline?: () => Promise<unknown>;
	clearRouting?: (type?: 'all' | 'net' | 'connection') => Promise<unknown>;
	getCanvasUpdateCalculationStatus?: () => Promise<unknown>;
	getCurrentFilterConfiguration?: () => Promise<unknown>;
	save?: () => Promise<unknown>;
	importChanges?: (uuid?: string) => Promise<unknown>;
	importAutoRouteJsonFile?: (file: File) => Promise<unknown>;
	importAutoRouteSesFile?: (file: File) => Promise<unknown>;
	importAutoLayoutJsonFile?: (file: File) => Promise<unknown>;
}

function getApi(): PcbDocumentApi {
	const eda = (globalThis as unknown as { eda?: Record<string, unknown> }).eda;
	const api = eda?.pcb_Document;
	if (!isPlainObjectRecord(api))
		throw new TypeError('EDA pcb_Document API is unavailable. Open a PCB document first.');
	return api as PcbDocumentApi;
}

function requiredAction(value: unknown): PcbDocumentAction {
	if (value !== 'status' && value !== 'save' && value !== 'start_ratline' && value !== 'stop_ratline' && value !== 'clear_routing' && value !== 'import_changes' && value !== 'import_auto_route_json' && value !== 'import_auto_route_ses' && value !== 'import_auto_layout_json')
		throw new TypeError('action must be status, save, start_ratline, stop_ratline, clear_routing, import_changes, import_auto_route_json, import_auto_route_ses, or import_auto_layout_json.');
	return value;
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
	if (input[key] === undefined || input[key] === null)
		return undefined;
	if (typeof input[key] !== 'string' || input[key].trim().length === 0)
		throw new TypeError(`${key} must be a non-empty string.`);
	return input[key].trim();
}

function decodeBase64(value: string): Uint8Array {
	const normalized = value.replace(/\s+/g, '');
	if (normalized.length === 0 || normalized.length % 4 !== 0 || !/^[a-z0-9+/]*={0,2}$/i.test(normalized))
		throw new TypeError('dataBase64 must be valid Base64.');
	let binary: string;
	try {
		binary = globalThis.atob(normalized);
	}
	catch {
		throw new TypeError('dataBase64 must be valid Base64.');
	}
	if (binary.length > MAX_IMPORT_BYTES)
		throw new RangeError(`Imported file exceeds ${String(MAX_IMPORT_BYTES)} bytes.`);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1)
		bytes[index] = binary.charCodeAt(index);
	return bytes;
}

function buildImportFile(input: Record<string, unknown>, action: PcbDocumentAction): File {
	const dataBase64 = optionalString(input, 'dataBase64');
	if (!dataBase64)
		throw new TypeError('dataBase64 is required for file import actions.');
	const bytes = decodeBase64(dataBase64);
	const defaultName = action === 'import_auto_route_ses' ? 'auto-route.ses' : action === 'import_auto_layout_json' ? 'auto-layout.json' : 'auto-route.json';
	const fileName = optionalString(input, 'fileName') ?? defaultName;
	const type = action === 'import_auto_route_ses' ? 'application/octet-stream' : 'application/json';
	return new File([bytes], fileName, { type });
}

export async function handlePcbDocumentTask(payload: unknown): Promise<unknown> {
	if (!isPlainObjectRecord(payload))
		throw new TypeError('pcb_document_action payload must be an object.');
	const action = requiredAction(payload.action === undefined ? 'status' : payload.action);
	const api = getApi();
	if (action === 'status') {
		const status: Record<string, unknown> = { ok: true, action };
		if (typeof api.getCalculatingRatlineStatus === 'function')
			status.ratline = await toSerializableAsync(await api.getCalculatingRatlineStatus());
		if (typeof api.getCanvasUpdateCalculationStatus === 'function')
			status.canvasUpdate = await toSerializableAsync(await api.getCanvasUpdateCalculationStatus());
		if (typeof api.getCurrentFilterConfiguration === 'function')
			status.filterConfiguration = await toSerializableAsync(await api.getCurrentFilterConfiguration());
		return status;
	}
	if (action === 'save') {
		if (typeof api.save !== 'function')
			throw new TypeError('EDA pcb_Document.save API is unavailable in this client version.');
		return { ok: true, action, saved: await toSerializableAsync(await api.save()) };
	}
	if (action === 'start_ratline' || action === 'stop_ratline') {
		const methodName = action === 'start_ratline' ? 'startCalculatingRatline' : 'stopCalculatingRatline';
		const method = api[methodName];
		if (typeof method !== 'function')
			throw new TypeError(`EDA pcb_Document.${methodName} API is unavailable in this client version.`);
		return { ok: true, action, changed: await toSerializableAsync(await method.call(api)) };
	}
	if (action === 'clear_routing') {
		if (typeof api.clearRouting !== 'function')
			throw new TypeError('EDA pcb_Document.clearRouting API is unavailable in this client version.');
		const routingType = payload.routingType === undefined ? 'all' : payload.routingType;
		if (routingType !== 'all' && routingType !== 'net' && routingType !== 'connection')
			throw new TypeError('routingType must be all, net, or connection.');
		return { ok: true, action, routingType, cleared: await toSerializableAsync(await api.clearRouting(routingType)) };
	}
	if (action === 'import_changes') {
		if (typeof api.importChanges !== 'function')
			throw new TypeError('EDA pcb_Document.importChanges API is unavailable in this client version.');
		const uuid = optionalString(payload, 'uuid');
		return { ok: true, action, imported: await toSerializableAsync(await api.importChanges(uuid)) };
	}
	const methodName = action === 'import_auto_route_json' ? 'importAutoRouteJsonFile' : action === 'import_auto_route_ses' ? 'importAutoRouteSesFile' : 'importAutoLayoutJsonFile';
	const method = api[methodName];
	if (typeof method !== 'function')
		throw new TypeError(`EDA pcb_Document.${methodName} API is unavailable in this client version.`);
	const file = buildImportFile(payload, action);
	return { ok: true, action, fileName: file.name, bytes: file.size, imported: await toSerializableAsync(await method.call(api, file)) };
}
