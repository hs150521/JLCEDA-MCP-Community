import { getEdaRuntime, isPlainObjectRecord, parseBoundedIntegerValue, preserveBoundedArray, toSerializableAsync } from '../utils.ts';

type WorkspaceQueryAction = 'current' | 'workspaces' | 'teams' | 'projects' | 'folders';

const MAX_QUERY_ITEMS = 500;

function requiredAction(value: unknown): WorkspaceQueryAction {
	if (value === undefined || value === null)
		return 'current';
	if (value !== 'current' && value !== 'workspaces' && value !== 'teams' && value !== 'projects' && value !== 'folders')
		throw new TypeError('action must be current, workspaces, teams, projects, or folders.');
	return value;
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
	if (input[key] === undefined || input[key] === null)
		return undefined;
	if (typeof input[key] !== 'string' || input[key].trim().length === 0)
		throw new TypeError(`${key} must be a non-empty string.`);
	return input[key].trim();
}

function getModule(eda: Record<string, unknown>, moduleName: string): Record<string, unknown> {
	const api = eda[moduleName];
	if (!isPlainObjectRecord(api))
		throw new TypeError(`EDA ${moduleName} API is unavailable in this client version.`);
	return api;
}

async function call(api: Record<string, unknown>, moduleName: string, methodName: string, ...args: unknown[]): Promise<unknown> {
	const method = api[methodName];
	if (typeof method !== 'function')
		throw new TypeError(`EDA ${moduleName}.${methodName} API is unavailable in this client version.`);
	return await (method as (...parameters: unknown[]) => Promise<unknown>).apply(api, args);
}

async function serializeBounded(values: unknown[]): Promise<unknown[]> {
	return preserveBoundedArray(await Promise.all(values.map(value => toSerializableAsync(value))));
}

export async function handleWorkspaceQueryTask(payload: unknown): Promise<unknown> {
	if (payload !== undefined && payload !== null && !isPlainObjectRecord(payload))
		throw new TypeError('workspace_query payload must be an object.');
	const input = isPlainObjectRecord(payload) ? payload : {};
	const action = requiredAction(input.action);
	const limit = parseBoundedIntegerValue(input.limit, 100, 1, MAX_QUERY_ITEMS);
	const eda = getEdaRuntime();
	if (!isPlainObjectRecord(eda))
		throw new TypeError('EDA runtime is unavailable.');
	const workspace = getModule(eda, 'dmt_Workspace');
	const team = getModule(eda, 'dmt_Team');

	if (action === 'current') {
		return {
			ok: true,
			action,
			workspace: await toSerializableAsync(await call(workspace, 'dmt_Workspace', 'getCurrentWorkspaceInfo')),
			team: await toSerializableAsync(await call(team, 'dmt_Team', 'getCurrentTeamInfo')),
		};
	}
	if (action === 'workspaces') {
		const raw = await call(workspace, 'dmt_Workspace', 'getAllWorkspacesInfo');
		if (!Array.isArray(raw))
			throw new TypeError('EDA dmt_Workspace.getAllWorkspacesInfo returned an invalid result.');
		const workspaces = await serializeBounded(raw.slice(0, limit));
		return {
			ok: true,
			action,
			current: await toSerializableAsync(await call(workspace, 'dmt_Workspace', 'getCurrentWorkspaceInfo')),
			total: raw.length,
			returned: workspaces.length,
			truncated: raw.length > limit,
			workspaces,
		};
	}
	if (action === 'teams') {
		const direct = await call(team, 'dmt_Team', 'getAllTeamsInfo');
		if (!Array.isArray(direct))
			throw new TypeError('EDA dmt_Team.getAllTeamsInfo returned an invalid team list.');
		let involved: unknown;
		try {
			involved = await call(team, 'dmt_Team', 'getAllInvolvedTeamInfo');
		}
		catch {
			involved = undefined;
		}
		const directTeams = await serializeBounded(direct.slice(0, limit));
		const involvedList = Array.isArray(involved) ? involved : undefined;
		const involvedTeams = involvedList ? await serializeBounded(involvedList.slice(0, limit)) : undefined;
		return {
			ok: true,
			action,
			current: await toSerializableAsync(await call(team, 'dmt_Team', 'getCurrentTeamInfo')),
			direct: { total: direct.length, returned: directTeams.length, truncated: direct.length > limit, teams: directTeams },
			...(involvedList && involvedTeams
				? { involved: { available: true, total: involvedList.length, returned: involvedTeams.length, truncated: involvedList.length > limit, teams: involvedTeams } }
				: { involved: { available: false } }),
		};
	}
	const project = getModule(eda, 'dmt_Project');
	if (action === 'projects') {
		const uuids = await call(project, 'dmt_Project', 'getAllProjectsUuid', optionalString(input, 'teamUuid'), optionalString(input, 'folderUuid'), optionalString(input, 'workspaceUuid'));
		if (!Array.isArray(uuids) || uuids.some(uuid => typeof uuid !== 'string'))
			throw new TypeError('EDA dmt_Project.getAllProjectsUuid returned an invalid result.');
		const projects = await serializeBounded(await Promise.all(uuids.slice(0, limit).map(uuid => call(project, 'dmt_Project', 'getProjectInfo', uuid))));
		return { ok: true, action, total: uuids.length, returned: projects.length, truncated: uuids.length > limit, projects };
	}
	const teamUuid = optionalString(input, 'teamUuid');
	if (!teamUuid)
		throw new TypeError('teamUuid is required for folders.');
	const folder = getModule(eda, 'dmt_Folder');
	const uuids = await call(folder, 'dmt_Folder', 'getAllFoldersUuid', teamUuid);
	if (!Array.isArray(uuids) || uuids.some(uuid => typeof uuid !== 'string'))
		throw new TypeError('EDA dmt_Folder.getAllFoldersUuid returned an invalid result.');
	const folders = await serializeBounded(await Promise.all(uuids.slice(0, limit).map(uuid => call(folder, 'dmt_Folder', 'getFolderInfo', teamUuid, uuid))));
	return { ok: true, action, teamUuid, total: uuids.length, returned: folders.length, truncated: uuids.length > limit, folders };
}
