import { getEdaRuntime, isPlainObjectRecord } from '../utils.ts';
import { getApiMetadata } from './api-search-handler.ts';

function parseVersion(value: string): number[] | undefined {
	const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[.\-+]|$)/i.exec(value.trim());
	return match ? [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)] : undefined;
}

export function editorVersionSupports(version: string, minimumVersions: string[]): boolean | undefined {
	const current = parseVersion(version);
	const minimums = minimumVersions.map(parseVersion).filter((item): item is number[] => item !== undefined);
	if (!current || minimums.length === 0)
		return undefined;
	const sameMajor = minimums.filter(item => item[0] === current[0]);
	if (sameMajor.length === 0)
		return current[0] > Math.max(...minimums.map(item => item[0]));
	return sameMajor.some(minimum => current[1] > minimum[1] || (current[1] === minimum[1] && current[2] >= minimum[2]));
}

export async function unsupportedApiVersion(apiFullName: string, knownMinimums?: string[]): Promise<Record<string, unknown> | undefined> {
	const runtime = getEdaRuntime();
	const environment = runtime?.sys_Environment;
	if (!isPlainObjectRecord(environment) || typeof environment.getEditorCurrentVersion !== 'function')
		return undefined;
	const version: unknown = environment.getEditorCurrentVersion();
	if (typeof version !== 'string')
		return undefined;
	let minimumEditorVersions = knownMinimums;
	if (!minimumEditorVersions) {
		// Older hosts and test adapters may not expose extension-file access.
		if (!isPlainObjectRecord(runtime?.sys_FileSystem) || typeof runtime.sys_FileSystem.getExtensionFile !== 'function')
			return undefined;
		minimumEditorVersions = (await getApiMetadata(apiFullName))?.minimumEditorVersions;
	}
	if (!minimumEditorVersions || editorVersionSupports(version, minimumEditorVersions) !== false)
		return undefined;
	return {
		apiFullName,
		ok: false,
		errorCode: 'EDA_VERSION_UNSUPPORTED',
		editorVersion: version,
		minimumEditorVersions,
		commitStatus: 'not_started',
		nativeCallAttempted: false,
		error: `EDA ${version} does not support ${apiFullName}; requires ${minimumEditorVersions.join(' / ')} or later on the corresponding release line.`,
	};
}
