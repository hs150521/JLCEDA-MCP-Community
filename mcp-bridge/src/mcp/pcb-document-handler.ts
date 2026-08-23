import { isPlainObjectRecord, toSerializableAsync } from '../utils.ts';

type PcbDocumentAction = 'status' | 'canvas_origin' | 'filter_configuration' | 'selection' | 'primitive_at_point' | 'primitives_in_region' | 'convert_canvas_to_data' | 'convert_data_to_canvas' | 'navigate_to_coordinates' | 'navigate_to_region' | 'zoom_to_board_outline' | 'save' | 'start_ratline' | 'stop_ratline' | 'clear_routing' | 'import_changes' | 'import_auto_route_json' | 'import_auto_route_ses' | 'import_auto_layout_json';

const MAX_IMPORT_BYTES = 8 * 1024 * 1024;

interface PcbDocumentApi {
	getCalculatingRatlineStatus?: () => Promise<unknown>;
	startCalculatingRatline?: () => Promise<unknown>;
	stopCalculatingRatline?: () => Promise<unknown>;
	clearRouting?: (type?: 'all' | 'net' | 'connection') => Promise<unknown>;
	getCanvasUpdateCalculationStatus?: () => Promise<unknown>;
	getCurrentFilterConfiguration?: () => Promise<unknown>;
	getCanvasOrigin?: () => Promise<unknown>;
	convertCanvasOriginToDataOrigin?: (x: number, y: number) => Promise<unknown>;
	convertDataOriginToCanvasOrigin?: (x: number, y: number) => Promise<unknown>;
	navigateToCoordinates?: (x: number, y: number) => Promise<unknown>;
	navigateToRegion?: (left: number, right: number, top: number, bottom: number) => Promise<unknown>;
	getPrimitiveAtPoint?: (x: number, y: number) => Promise<unknown>;
	getPrimitivesInRegion?: (left: number, right: number, top: number, bottom: number, leftToRight?: boolean) => Promise<unknown>;
	zoomToBoardOutline?: () => Promise<unknown>;
	save?: () => Promise<unknown>;
	importChanges?: (uuid?: string) => Promise<unknown>;
	importAutoRouteJsonFile?: (file: File) => Promise<unknown>;
	importAutoRouteSesFile?: (file: File) => Promise<unknown>;
	importAutoLayoutJsonFile?: (file: File) => Promise<unknown>;
}

interface PcbSelectControlApi {
	getAllSelectedPrimitives_PrimitiveId?: () => Promise<unknown>;
	getAllSelectedPrimitives?: () => Promise<unknown>;
}

const MAX_INSPECT_ITEMS = 500;

async function serializeBoundedArray(values: unknown[]): Promise<unknown[]> {
	return await Promise.all(values.map(value => toSerializableAsync(value)));
}

function getApi(): PcbDocumentApi {
	const eda = (globalThis as unknown as { eda?: Record<string, unknown> }).eda;
	const api = eda?.pcb_Document;
	if (!isPlainObjectRecord(api))
		throw new TypeError('EDA pcb_Document API is unavailable. Open a PCB document first.');
	return api as PcbDocumentApi;
}

function requiredAction(value: unknown): PcbDocumentAction {
	if (value !== 'status' && value !== 'canvas_origin' && value !== 'filter_configuration' && value !== 'selection' && value !== 'primitive_at_point' && value !== 'primitives_in_region' && value !== 'convert_canvas_to_data' && value !== 'convert_data_to_canvas' && value !== 'navigate_to_coordinates' && value !== 'navigate_to_region' && value !== 'zoom_to_board_outline' && value !== 'save' && value !== 'start_ratline' && value !== 'stop_ratline' && value !== 'clear_routing' && value !== 'import_changes' && value !== 'import_auto_route_json' && value !== 'import_auto_route_ses' && value !== 'import_auto_layout_json')
		throw new TypeError('action is not supported by pcb_document_action.');
	return value;
}

function requiredFiniteNumber(input: Record<string, unknown>, key: string): number {
	const value = input[key];
	if (typeof value !== 'number' || !Number.isFinite(value))
		throw new TypeError(`${key} must be a finite number.`);
	return value;
}

function optionalInspectLimit(input: Record<string, unknown>): number {
	if (input.limit === undefined)
		return 120;
	if (typeof input.limit !== 'number' || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_INSPECT_ITEMS)
		throw new RangeError(`limit must be an integer between 1 and ${String(MAX_INSPECT_ITEMS)}.`);
	return input.limit;
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
	if (action === 'canvas_origin') {
		if (typeof api.getCanvasOrigin !== 'function')
			throw new TypeError('EDA pcb_Document.getCanvasOrigin API is unavailable in this client version.');
		return { ok: true, action, origin: await toSerializableAsync(await api.getCanvasOrigin()) };
	}
	if (action === 'filter_configuration') {
		if (typeof api.getCurrentFilterConfiguration !== 'function')
			throw new TypeError('EDA pcb_Document.getCurrentFilterConfiguration API is unavailable in this client version.');
		return { ok: true, action, filterConfiguration: await toSerializableAsync(await api.getCurrentFilterConfiguration()) };
	}
	if (action === 'selection') {
		const eda = (globalThis as unknown as { eda?: Record<string, unknown> }).eda;
		const selectApi = eda?.pcb_SelectControl as PcbSelectControlApi | undefined;
		if (!selectApi || typeof selectApi.getAllSelectedPrimitives_PrimitiveId !== 'function')
			throw new TypeError('EDA pcb_SelectControl selection APIs are unavailable in this client version.');
		const rawIds = await selectApi.getAllSelectedPrimitives_PrimitiveId();
		const ids = Array.isArray(rawIds) ? rawIds : [];
		const limit = optionalInspectLimit(payload);
		const includeObjects = payload.includeObjects === undefined ? false : payload.includeObjects;
		if (typeof includeObjects !== 'boolean')
			throw new TypeError('includeObjects must be a boolean.');
		const result: Record<string, unknown> = {
			ok: true,
			action,
			selectedCount: ids.length,
			returned: Math.min(ids.length, limit),
			truncated: ids.length > limit,
			selectedPrimitiveIds: await serializeBoundedArray(ids.slice(0, limit)),
		};
		if (includeObjects) {
			if (typeof selectApi.getAllSelectedPrimitives !== 'function')
				throw new TypeError('EDA pcb_SelectControl.getAllSelectedPrimitives API is unavailable in this client version.');
			const rawObjects = await selectApi.getAllSelectedPrimitives();
			const objects = Array.isArray(rawObjects) ? rawObjects : [];
			result.selectedPrimitives = await serializeBoundedArray(objects.slice(0, limit));
			result.objectsTruncated = objects.length > limit;
		}
		return result;
	}
	if (action === 'primitive_at_point') {
		if (typeof api.getPrimitiveAtPoint !== 'function')
			throw new TypeError('EDA pcb_Document.getPrimitiveAtPoint API is unavailable in this client version.');
		const x = requiredFiniteNumber(payload, 'x');
		const y = requiredFiniteNumber(payload, 'y');
		return { ok: true, action, x, y, primitive: await toSerializableAsync(await api.getPrimitiveAtPoint(x, y)) };
	}
	if (action === 'primitives_in_region') {
		if (typeof api.getPrimitivesInRegion !== 'function')
			throw new TypeError('EDA pcb_Document.getPrimitivesInRegion API is unavailable in this client version.');
		const left = requiredFiniteNumber(payload, 'left');
		const right = requiredFiniteNumber(payload, 'right');
		const top = requiredFiniteNumber(payload, 'top');
		const bottom = requiredFiniteNumber(payload, 'bottom');
		if (left > right || top > bottom)
			throw new RangeError('region bounds must satisfy left <= right and top <= bottom.');
		const leftToRight = payload.leftToRight === undefined ? true : payload.leftToRight;
		if (typeof leftToRight !== 'boolean')
			throw new TypeError('leftToRight must be a boolean.');
		const rawPrimitives = await api.getPrimitivesInRegion(left, right, top, bottom, leftToRight);
		const primitives = Array.isArray(rawPrimitives) ? rawPrimitives : [];
		const limit = optionalInspectLimit(payload);
		return { ok: true, action, bounds: { left, right, top, bottom }, total: primitives.length, returned: Math.min(primitives.length, limit), truncated: primitives.length > limit, primitives: await serializeBoundedArray(primitives.slice(0, limit)) };
	}
	if (action === 'convert_canvas_to_data' || action === 'convert_data_to_canvas') {
		const methodName = action === 'convert_canvas_to_data' ? 'convertCanvasOriginToDataOrigin' : 'convertDataOriginToCanvasOrigin';
		const method = api[methodName];
		if (typeof method !== 'function')
			throw new TypeError(`EDA pcb_Document.${methodName} API is unavailable in this client version.`);
		const x = requiredFiniteNumber(payload, 'x');
		const y = requiredFiniteNumber(payload, 'y');
		return { ok: true, action, x, y, point: await toSerializableAsync(await method.call(api, x, y)) };
	}
	if (action === 'navigate_to_coordinates') {
		if (typeof api.navigateToCoordinates !== 'function')
			throw new TypeError('EDA pcb_Document.navigateToCoordinates API is unavailable in this client version.');
		const x = requiredFiniteNumber(payload, 'x');
		const y = requiredFiniteNumber(payload, 'y');
		return { ok: true, action, x, y, navigated: await toSerializableAsync(await api.navigateToCoordinates(x, y)) };
	}
	if (action === 'navigate_to_region') {
		if (typeof api.navigateToRegion !== 'function')
			throw new TypeError('EDA pcb_Document.navigateToRegion API is unavailable in this client version.');
		const left = requiredFiniteNumber(payload, 'left');
		const right = requiredFiniteNumber(payload, 'right');
		const top = requiredFiniteNumber(payload, 'top');
		const bottom = requiredFiniteNumber(payload, 'bottom');
		if (left > right || top > bottom)
			throw new RangeError('region bounds must satisfy left <= right and top <= bottom.');
		return { ok: true, action, bounds: { left, right, top, bottom }, navigated: await toSerializableAsync(await api.navigateToRegion(left, right, top, bottom)) };
	}
	if (action === 'zoom_to_board_outline') {
		if (typeof api.zoomToBoardOutline !== 'function')
			throw new TypeError('EDA pcb_Document.zoomToBoardOutline API is unavailable in this client version.');
		return { ok: true, action, zoomed: await toSerializableAsync(await api.zoomToBoardOutline()) };
	}
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
