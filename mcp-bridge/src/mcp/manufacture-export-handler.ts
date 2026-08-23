import { getEdaRuntime, isPlainObjectRecord } from '../utils.ts';

type ExportDomain = 'pcb' | 'schematic';

const MAX_DATA_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_PREVIEW = 16 * 1024;
const PCB_METHODS = new Set([
	'gerber',
	'bom',
	'netlist',
	'pick_and_place',
	'3d',
	'3d_shell',
	'test_point',
	'flying_probe_test',
	'dxf',
	'pdf',
	'ipc_d356a',
	'open_database',
	'interactive_bom',
	'dsn',
	'auto_route_json',
	'auto_layout_json',
	'altium',
	'pads',
	'pcb_info',
	'idx',
	'manufacture_data',
]);
const SCHEMATIC_METHODS = new Set(['bom', 'netlist', 'simulation_netlist', 'document']);
const STANDARD_NETLIST_TYPES = ['Allegro', 'PADS', 'Protel2', 'JLCEDA'] as const;
const SIMULATION_NETLIST_TYPES = ['Ngspice'] as const;
const PCB_EXPORT_UNITS: Record<string, readonly string[]> = {
	gerber: ['mm', 'inch'],
	pick_and_place: ['mm', 'mil'],
	open_database: ['inch'],
};

function encodeBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	}
	return globalThis.btoa(binary);
}

function requiredString(input: Record<string, unknown>, key: string): string {
	const value = input[key];
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new TypeError(`${key} must be a non-empty string.`);
	}
	return value.trim();
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
	if (input[key] === undefined || input[key] === null)
		return undefined;
	if (typeof input[key] !== 'string' || input[key].trim().length === 0)
		throw new TypeError(`${key} must be a non-empty string.`);
	return input[key].trim();
}

function optionalEnum(input: Record<string, unknown>, key: string, values: readonly string[]): string | undefined {
	const value = optionalString(input, key);
	if (value !== undefined && !values.includes(value))
		throw new TypeError(`${key} must be one of: ${values.join(', ')}.`);
	return value;
}

function optionalManufacturingUnit(domain: ExportDomain, kind: string, input: Record<string, unknown>): string | undefined {
	const unit = optionalString(input, 'unit');
	if (unit === undefined)
		return undefined;
	const allowedUnits = domain === 'pcb' ? PCB_EXPORT_UNITS[kind] : undefined;
	if (!allowedUnits)
		throw new TypeError(`unit is not supported for ${domain} ${kind} exports.`);
	if (!allowedUnits.includes(unit))
		throw new TypeError(`unit must be one of: ${allowedUnits.join(', ')}.`);
	return unit;
}

function optionalAssemblyVariant(input: Record<string, unknown>): { text: string; value: string } | undefined {
	if (input.assemblyVariantsConfig === undefined || input.assemblyVariantsConfig === null)
		return undefined;
	if (!isPlainObjectRecord(input.assemblyVariantsConfig))
		throw new TypeError('assemblyVariantsConfig must be an object.');
	const text = input.assemblyVariantsConfig.text;
	const value = input.assemblyVariantsConfig.value;
	if (typeof text !== 'string' || text.trim().length === 0 || typeof value !== 'string' || value.trim().length === 0)
		throw new TypeError('assemblyVariantsConfig.text and value must be non-empty strings.');
	return { text: text.trim(), value: value.trim() };
}

async function encodeBlob(blob: unknown, includeData: boolean): Promise<Record<string, unknown>> {
	if (!(typeof Blob !== 'undefined' && blob instanceof Blob)) {
		return { kind: 'value', value: blob };
	}
	const file = blob as Blob & { name?: string };
	const output: Record<string, unknown> = { kind: 'file', name: file.name ?? '', type: file.type, size: file.size };
	const lowerName = (file.name ?? '').toLowerCase();
	const isText = file.type.startsWith('text/') || file.type.includes('csv') || file.type.includes('json') || lowerName.endsWith('.net') || lowerName.endsWith('.json') || lowerName.endsWith('.ses');
	if (isText) {
		const previewText = await file.slice(0, MAX_TEXT_PREVIEW).text();
		output.preview = previewText;
		if (file.size > MAX_TEXT_PREVIEW)
			output.previewTruncated = true;
	}
	if (includeData) {
		if (file.size > MAX_DATA_BYTES) {
			output.dataOmitted = `File exceeds ${String(MAX_DATA_BYTES)} bytes.`;
		}
		else {
			output.dataBase64 = encodeBase64(new Uint8Array(await file.arrayBuffer()));
			output.encoding = 'base64';
		}
	}
	return output;
}

function resolveCall(domain: ExportDomain, kind: string, input: Record<string, unknown>): { method: string; args: unknown[] } {
	const fileName = optionalString(input, 'fileName');
	const fileType = optionalString(input, 'fileType');
	const template = optionalString(input, 'template');
	const assemblyVariantsConfig = optionalAssemblyVariant(input);
	const unit = optionalManufacturingUnit(domain, kind, input);
	if (domain === 'pcb') {
		if (!PCB_METHODS.has(kind))
			throw new TypeError(`Unsupported PCB export kind: ${kind}.`);
		const calls: Record<string, { method: string; args: unknown[] }> = {
			'gerber': { method: 'getGerberFile', args: [fileName, undefined, unit] },
			'bom': { method: 'getBomFile', args: [fileName, fileType, template] },
			'netlist': { method: 'getNetlistFile', args: [fileName, optionalEnum(input, 'netlistType', STANDARD_NETLIST_TYPES)] },
			'pick_and_place': { method: 'getPickAndPlaceFile', args: [fileName, fileType, unit] },
			'3d': { method: 'get3DFile', args: [fileName, fileType] },
			'3d_shell': { method: 'get3DShellFile', args: [fileName, fileType] },
			'test_point': { method: 'getTestPointFile', args: [fileName, fileType] },
			'flying_probe_test': { method: 'getFlyingProbeTestFile', args: [fileName] },
			'dxf': { method: 'getDxfFile', args: [fileName] },
			'pdf': { method: 'getPdfFile', args: [fileName] },
			'ipc_d356a': { method: 'getIpcD356AFile', args: [fileName] },
			'open_database': { method: 'getOpenDatabaseDoublePlusFile', args: [fileName, unit] },
			'interactive_bom': { method: 'getInteractiveBomFile', args: [fileName] },
			'dsn': { method: 'getDsnFile', args: [fileName] },
			'auto_route_json': { method: 'getAutoRouteJsonFile', args: [fileName] },
			'auto_layout_json': { method: 'getAutoLayoutJsonFile', args: [fileName] },
			'altium': { method: 'getAltiumDesignerFile', args: [fileName] },
			'pads': { method: 'getPadsFile', args: [fileName] },
			'pcb_info': { method: 'getPcbInfoFile', args: [fileName] },
			'idx': { method: 'getIdxFile', args: [fileName] },
			'manufacture_data': { method: 'getManufactureData', args: [] },
		};
		return calls[kind];
	}
	if (!SCHEMATIC_METHODS.has(kind))
		throw new TypeError(`Unsupported schematic export kind: ${kind}.`);
	const calls: Record<string, { method: string; args: unknown[] }> = {
		bom: { method: 'getBomFile', args: [fileName, fileType, template, undefined, undefined, undefined, undefined, assemblyVariantsConfig] },
		netlist: { method: 'getNetlistFile', args: [fileName, optionalEnum(input, 'netlistType', STANDARD_NETLIST_TYPES)] },
		simulation_netlist: { method: 'getSimulationNetlistFile', args: [fileName, optionalEnum(input, 'netlistType', SIMULATION_NETLIST_TYPES)] },
		document: { method: 'getExportDocumentFile', args: [fileName, fileType, undefined, optionalString(input, 'documentScope')] },
	};
	return calls[kind];
}

export async function handleManufactureExportTask(payload: unknown): Promise<unknown> {
	if (!isPlainObjectRecord(payload))
		throw new TypeError('manufacture_export payload must be an object.');
	const domain = requiredString(payload, 'domain');
	const kind = requiredString(payload, 'kind');
	if (domain !== 'pcb' && domain !== 'schematic')
		throw new TypeError('domain must be \'pcb\' or \'schematic\'.');
	const includeData = payload.includeData === undefined ? false : payload.includeData;
	if (typeof includeData !== 'boolean')
		throw new TypeError('includeData must be a boolean.');
	const eda = getEdaRuntime();
	const moduleName = domain === 'pcb' ? 'pcb_ManufactureData' : 'sch_ManufactureData';
	const api = eda?.[moduleName];
	const call = resolveCall(domain, kind, payload);
	if (domain === 'pcb' && payload.assemblyVariantsConfig !== undefined)
		throw new TypeError('assemblyVariantsConfig is only supported for schematic BOM exports.');
	if (!isPlainObjectRecord(api) || typeof api[call.method] !== 'function') {
		throw new TypeError(`EDA ${moduleName}.${call.method} API is unavailable in this client version.`);
	}
	const file = await (api[call.method] as (...args: unknown[]) => Promise<unknown>).apply(api, call.args);
	return { ok: file !== undefined && file !== null, domain, kind, file: await encodeBlob(file, includeData) };
}
