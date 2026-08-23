import { getEdaRuntime, isPlainObjectRecord, parseBoundedIntegerValue, preserveBoundedArray, toSerializableAsync } from '../utils.ts';

type EdaRecord = Record<string, unknown>;
const MAX_INVENTORY_ITEMS = 500;

function resolveEda(): EdaRecord {
	const eda = getEdaRuntime();
	if (!isPlainObjectRecord(eda)) {
		throw new TypeError('EDA runtime is unavailable.');
	}
	return eda;
}

async function callEda(eda: EdaRecord, moduleName: string, methodName: string): Promise<unknown> {
	const module = eda[moduleName];
	if (!isPlainObjectRecord(module) || typeof module[methodName] !== 'function') {
		throw new TypeError(`EDA ${moduleName}.${methodName} API is unavailable in this client version.`);
	}
	return (module[methodName] as () => Promise<unknown>).call(module);
}

async function serializeInventory(value: unknown, moduleName: string, methodName: string, limit: number): Promise<{ total: number; returned: number; truncated: boolean; items: unknown[] }> {
	if (!Array.isArray(value))
		throw new TypeError(`EDA ${moduleName}.${methodName} returned an invalid result.`);
	const items = preserveBoundedArray(await Promise.all(value.slice(0, limit).map(item => toSerializableAsync(item))));
	return { total: value.length, returned: items.length, truncated: value.length > limit, items };
}

export async function handleProjectInfoTask(payload: unknown): Promise<unknown> {
	if (payload !== undefined && payload !== null && !isPlainObjectRecord(payload)) {
		throw new TypeError('project_info payload must be an object.');
	}
	const input = isPlainObjectRecord(payload) ? payload : {};
	const includePages = input.includePages === undefined ? true : input.includePages;
	const includeSchematics = input.includeSchematics === undefined ? false : input.includeSchematics;
	const includePcbs = input.includePcbs === undefined ? false : input.includePcbs;
	const includeBoards = input.includeBoards === undefined ? false : input.includeBoards;
	const includePanels = input.includePanels === undefined ? false : input.includePanels;
	if (typeof includePages !== 'boolean') {
		throw new TypeError('includePages must be a boolean.');
	}
	if (typeof includeSchematics !== 'boolean' || typeof includePcbs !== 'boolean' || typeof includeBoards !== 'boolean' || typeof includePanels !== 'boolean')
		throw new TypeError('includeSchematics, includePcbs, includeBoards, and includePanels must be booleans.');
	const limit = parseBoundedIntegerValue(input.limit, 100, 1, MAX_INVENTORY_ITEMS);
	const eda = resolveEda();
	const project = await callEda(eda, 'dmt_Project', 'getCurrentProjectInfo');
	const board = await callEda(eda, 'dmt_Board', 'getCurrentBoardInfo');
	const schematic = await callEda(eda, 'dmt_Schematic', 'getCurrentSchematicInfo');
	const pcb = await callEda(eda, 'dmt_Pcb', 'getCurrentPcbInfo');
	const document = await callEda(eda, 'dmt_SelectControl', 'getCurrentDocumentInfo');
	const pages = includePages
		? await callEda(eda, 'dmt_Schematic', 'getCurrentSchematicAllSchematicPagesInfo')
		: undefined;
	const schematics = includeSchematics
		? await callEda(eda, 'dmt_Schematic', 'getAllSchematicsInfo')
		: undefined;
	const pcbs = includePcbs
		? await callEda(eda, 'dmt_Pcb', 'getAllPcbsInfo')
		: undefined;
	const boards = includeBoards
		? await callEda(eda, 'dmt_Board', 'getAllBoardsInfo')
		: undefined;
	const panels = includePanels
		? await callEda(eda, 'dmt_Panel', 'getAllPanelsInfo')
		: undefined;
	return {
		ok: true,
		project: await toSerializableAsync(project),
		board: await toSerializableAsync(board),
		schematic: await toSerializableAsync(schematic),
		pcb: await toSerializableAsync(pcb),
		currentDocument: await toSerializableAsync(document),
		...(includePages ? { schematicPages: await toSerializableAsync(pages) } : {}),
		...(includeSchematics ? { schematics: await serializeInventory(schematics, 'dmt_Schematic', 'getAllSchematicsInfo', limit) } : {}),
		...(includePcbs ? { pcbs: await serializeInventory(pcbs, 'dmt_Pcb', 'getAllPcbsInfo', limit) } : {}),
		...(includeBoards ? { boards: await serializeInventory(boards, 'dmt_Board', 'getAllBoardsInfo', limit) } : {}),
		...(includePanels ? { panels: await serializeInventory(panels, 'dmt_Panel', 'getAllPanelsInfo', limit) } : {}),
	};
}
