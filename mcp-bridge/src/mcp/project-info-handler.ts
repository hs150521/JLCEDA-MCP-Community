import { isPlainObjectRecord, toSerializableAsync } from '../utils.ts';

type EdaRecord = Record<string, unknown>;

function resolveEda(): EdaRecord {
	const eda = (globalThis as unknown as { eda?: unknown }).eda;
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

export async function handleProjectInfoTask(payload: unknown): Promise<unknown> {
	if (payload !== undefined && payload !== null && !isPlainObjectRecord(payload)) {
		throw new TypeError('project_info payload must be an object.');
	}
	const input = isPlainObjectRecord(payload) ? payload : {};
	const includePages = input.includePages === undefined ? true : input.includePages;
	if (typeof includePages !== 'boolean') {
		throw new TypeError('includePages must be a boolean.');
	}
	const eda = resolveEda();
	const project = await callEda(eda, 'dmt_Project', 'getCurrentProjectInfo');
	const board = await callEda(eda, 'dmt_Board', 'getCurrentBoardInfo');
	const schematic = await callEda(eda, 'dmt_Schematic', 'getCurrentSchematicInfo');
	const pcb = await callEda(eda, 'dmt_Pcb', 'getCurrentPcbInfo');
	const document = await callEda(eda, 'dmt_SelectControl', 'getCurrentDocumentInfo');
	const pages = includePages
		? await callEda(eda, 'dmt_Schematic', 'getCurrentSchematicAllSchematicPagesInfo')
		: undefined;
	return {
		ok: true,
		project: await toSerializableAsync(project),
		board: await toSerializableAsync(board),
		schematic: await toSerializableAsync(schematic),
		pcb: await toSerializableAsync(pcb),
		currentDocument: await toSerializableAsync(document),
		...(includePages ? { schematicPages: await toSerializableAsync(pages) } : {}),
	};
}
