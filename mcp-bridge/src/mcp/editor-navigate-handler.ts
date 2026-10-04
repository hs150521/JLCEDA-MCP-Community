import { getEdaRuntime, isPlainObjectRecord, isUnknownNativeRpcResult, toSafeErrorMessage } from '../utils.ts';

type EdaApi = Record<string, unknown>;
type PageKind = 'schematic' | 'pcb';

interface TargetDocument {
	projectUuid: string;
	documentUuid: string;
	pageKind: PageKind;
	name: string;
}

interface CurrentDocument {
	projectUuid?: string;
	documentProjectUuid?: string;
	documentUuid?: string;
	pageUuid?: string;
	tabId?: string;
}

const READBACK_INTERVAL_MS = 200;

function requiredString(value: unknown, field: string): string {
	if (typeof value !== 'string' || !value.trim())
		throw new TypeError(`${field} must be a non-empty string.`);
	return value.trim();
}

function api(runtime: EdaApi, name: string, methods: string[]): EdaApi {
	const value = runtime[name];
	if (!isPlainObjectRecord(value) || methods.some(method => typeof value[method] !== 'function'))
		throw new TypeError(`EDA ${name}.${methods.join('/')} API is unavailable.`);
	return value;
}

async function call(target: EdaApi, method: string, ...args: unknown[]): Promise<unknown> {
	return await (target[method] as (...values: unknown[]) => Promise<unknown>).call(target, ...args);
}

async function currentProjectUuid(projectApi: EdaApi): Promise<string> {
	const project = await call(projectApi, 'getCurrentProjectInfo');
	if (!isPlainObjectRecord(project))
		throw new TypeError('EDA current project is unavailable.');
	return requiredString(project.uuid, 'EDA current project uuid');
}

async function assertProject(projectApi: EdaApi, projectUuid: string): Promise<void> {
	if (await currentProjectUuid(projectApi) !== projectUuid)
		throw new Error('The active EDA project changed before editor navigation.');
}

async function findTarget(runtime: EdaApi, projectUuid: string, documentUuid: string): Promise<TargetDocument> {
	const pcbApi = api(runtime, 'dmt_Pcb', ['getAllPcbsInfo']);
	const schematicApi = api(runtime, 'dmt_Schematic', ['getAllSchematicsInfo', 'getAllSchematicPagesInfo']);
	const [pcbs, schematics, pages] = await Promise.all([
		call(pcbApi, 'getAllPcbsInfo'),
		call(schematicApi, 'getAllSchematicsInfo'),
		call(schematicApi, 'getAllSchematicPagesInfo'),
	]);
	if (!Array.isArray(pcbs) || !Array.isArray(schematics) || !Array.isArray(pages))
		throw new TypeError('EDA current project document inventory is unavailable.');
	const pcb = pcbs.find(item => isPlainObjectRecord(item) && item.uuid === documentUuid && item.parentProjectUuid === projectUuid);
	const page = pages.find(item => isPlainObjectRecord(item) && item.uuid === documentUuid);
	const schematic = isPlainObjectRecord(page)
		? schematics.find(item => isPlainObjectRecord(item) && item.uuid === page.parentSchematicUuid && item.parentProjectUuid === projectUuid)
		: undefined;
	if (pcb && schematic)
		throw new TypeError('EDA current project contains duplicate document UUIDs.');
	if (isPlainObjectRecord(pcb))
		return { projectUuid, documentUuid, pageKind: 'pcb', name: requiredString(pcb.name, 'EDA PCB name') };
	if (isPlainObjectRecord(page) && schematic)
		return { projectUuid, documentUuid, pageKind: 'schematic', name: requiredString(page.name, 'EDA schematic page name') };
	throw new TypeError(`Document ${documentUuid} is not a schematic page or PCB in the current project.`);
}

function hasTab(tree: unknown, tabId: string): boolean {
	if (!isPlainObjectRecord(tree))
		return false;
	if (Array.isArray(tree.tabs) && tree.tabs.some(tab => isPlainObjectRecord(tab) && tab.tabId === tabId))
		return true;
	return Array.isArray(tree.children) && tree.children.some(child => hasTab(child, tabId));
}

async function readCurrent(runtime: EdaApi, pageKind: PageKind): Promise<CurrentDocument> {
	const selectApi = api(runtime, 'dmt_SelectControl', ['getCurrentDocumentInfo']);
	const projectApi = api(runtime, 'dmt_Project', ['getCurrentProjectInfo']);
	const pageApi = pageKind === 'pcb'
		? api(runtime, 'dmt_Pcb', ['getCurrentPcbInfo'])
		: api(runtime, 'dmt_Schematic', ['getCurrentSchematicPageInfo']);
	const [document, project, page] = await Promise.all([
		call(selectApi, 'getCurrentDocumentInfo'),
		call(projectApi, 'getCurrentProjectInfo'),
		call(pageApi, pageKind === 'pcb' ? 'getCurrentPcbInfo' : 'getCurrentSchematicPageInfo'),
	]);
	return {
		projectUuid: isPlainObjectRecord(project) && typeof project.uuid === 'string' ? project.uuid : undefined,
		documentProjectUuid: isPlainObjectRecord(document) && typeof document.parentProjectUuid === 'string' ? document.parentProjectUuid : undefined,
		documentUuid: isPlainObjectRecord(document) && typeof document.uuid === 'string' ? document.uuid : undefined,
		pageUuid: isPlainObjectRecord(page) && typeof page.uuid === 'string' ? page.uuid : undefined,
		tabId: isPlainObjectRecord(document) && typeof document.tabId === 'string' ? document.tabId : undefined,
	};
}

function isTarget(current: CurrentDocument, target: TargetDocument, tabId?: string): boolean {
	return current.projectUuid === target.projectUuid
		&& (current.documentProjectUuid === undefined || current.documentProjectUuid === target.projectUuid)
		&& current.documentUuid === target.documentUuid
		&& current.pageUuid === target.documentUuid
		&& typeof current.tabId === 'string'
		&& current.tabId.length > 0
		&& (tabId === undefined || current.tabId === tabId);
}

async function waitForTarget(runtime: EdaApi, target: TargetDocument, deadline: number, tabId?: string): Promise<CurrentDocument> {
	let current: CurrentDocument = {};
	let lastError: unknown;
	do {
		try {
			current = await readCurrent(runtime, target.pageKind);
			if (isTarget(current, target, tabId))
				return current;
		}
		catch (error: unknown) {
			lastError = error;
		}
		if (Date.now() >= deadline)
			break;
		await new Promise<void>(resolve => globalThis.setTimeout(resolve, READBACK_INTERVAL_MS));
	} while (true);
	if (lastError)
		throw lastError;
	return current;
}

function uncertainNavigation(operation: string, target: TargetDocument, error: unknown, nativeCallSettled: boolean, tabId?: string): Record<string, unknown> {
	return {
		ok: false,
		operation,
		...target,
		...(tabId ? { tabId } : {}),
		reason: nativeCallSettled ? 'post_navigation_readback_failed' : 'native_call_result_unknown',
		error: toSafeErrorMessage(error),
		commitUnknown: true,
		readbackRequired: true,
		nativeCallSettled,
	};
}

export async function handleEditorNavigateTask(payload: unknown): Promise<unknown> {
	if (!isPlainObjectRecord(payload))
		throw new TypeError('editor_navigate payload must be an object.');
	const startedAt = Date.now();
	const timeoutMs = typeof payload.timeoutMs === 'number' ? payload.timeoutMs : 30_000;
	const operation = payload.operation;
	if (operation !== 'open' && operation !== 'activate')
		throw new TypeError('operation must be open or activate.');
	const projectUuid = requiredString(payload.projectUuid, 'projectUuid');
	const documentUuid = requiredString(payload.documentUuid, 'documentUuid');
	const requestedTabId = operation === 'activate' ? requiredString(payload.tabId, 'tabId') : undefined;
	const runtime = getEdaRuntime();
	if (!runtime)
		throw new TypeError('EDA runtime is unavailable.');
	const projectApi = api(runtime, 'dmt_Project', ['getCurrentProjectInfo']);
	const editorApi = api(runtime, 'dmt_EditorControl', ['openDocument', 'activateDocument', 'getSplitScreenTree']);
	await assertProject(projectApi, projectUuid);
	const target = await findTarget(runtime, projectUuid, documentUuid);
	if (requestedTabId) {
		const tree = await call(editorApi, 'getSplitScreenTree');
		if (!hasTab(tree, requestedTabId))
			throw new TypeError(`Tab ${requestedTabId} is not open in the current editor.`);
	}
	await assertProject(projectApi, projectUuid);
	const before = await readCurrent(runtime, target.pageKind);
	if (isTarget(before, target, requestedTabId))
		return { ok: true, operation, ...target, tabId: before.tabId, pageUuid: before.pageUuid, changed: false, verified: true };
	await assertProject(projectApi, projectUuid);
	let nativeResult: unknown;
	try {
		nativeResult = operation === 'open'
			? await call(editorApi, 'openDocument', documentUuid)
			: await call(editorApi, 'activateDocument', requestedTabId);
	}
	catch (error: unknown) {
		if (!isUnknownNativeRpcResult(toSafeErrorMessage(error)))
			throw error;
		return uncertainNavigation(operation, target, error, false, requestedTabId);
	}
	if (operation === 'activate' && nativeResult === false) {
		try {
			const current = await readCurrent(runtime, target.pageKind);
			if (isTarget(current, target, requestedTabId))
				return { ok: true, operation, ...target, tabId: current.tabId, pageUuid: current.pageUuid, changed: true, verified: true };
		}
		catch { /* The native rejection remains deterministic. */ }
		return { ok: false, operation, ...target, tabId: requestedTabId, reason: 'native_activation_rejected', changed: false, verified: false, commitUnknown: false, nativeCallSettled: true };
	}
	const tabId = operation === 'open' && typeof nativeResult === 'string' && nativeResult.trim()
		? nativeResult.trim()
		: requestedTabId;
	try {
		const current = await waitForTarget(runtime, target, startedAt + timeoutMs - 1_000, tabId);
		if (!isTarget(current, target, tabId))
			throw new Error(`EDA active editor identity does not match ${documentUuid}${tabId ? ` in tab ${tabId}` : ''}.`);
		return { ok: true, operation, ...target, tabId: current.tabId, pageUuid: current.pageUuid, changed: true, verified: true };
	}
	catch (error: unknown) {
		return uncertainNavigation(operation, target, error, true, tabId);
	}
}
