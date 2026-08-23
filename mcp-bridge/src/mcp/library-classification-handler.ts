import { getEdaRuntime, isPlainObjectRecord, parseBoundedIntegerValue, preserveBoundedArray } from '../utils.ts';

type LibraryKind = 'device' | 'symbol' | 'footprint' | 'model_3d' | 'cbb' | 'panel_library';

const LIBRARY_TYPE_BY_KIND: Record<LibraryKind, string> = {
	cbb: '1',
	symbol: '2',
	device: '3',
	footprint: '4',
	model_3d: '5',
	panel_library: '29',
};

interface ClassificationNode {
	name: string;
	uuid: string;
	children?: ClassificationNode[];
}

function requiredString(input: Record<string, unknown>, key: string): string {
	if (typeof input[key] !== 'string' || input[key].trim().length === 0)
		throw new TypeError(`${key} is required and must be a non-empty string.`);
	return input[key].trim();
}

function parseKind(value: unknown): LibraryKind {
	if (value !== 'device' && value !== 'symbol' && value !== 'footprint' && value !== 'model_3d' && value !== 'cbb' && value !== 'panel_library')
		throw new TypeError('kind must be device, symbol, footprint, model_3d, cbb, or panel_library.');
	return value;
}

function countNodes(value: unknown, seen: Set<object>): number {
	if (!isPlainObjectRecord(value) || seen.has(value))
		return 0;
	seen.add(value);
	const children = Array.isArray(value.children) ? value.children : [];
	return 1 + children.reduce((total, child) => total + countNodes(child, seen), 0);
}

function limitTree(value: unknown, maxDepth: number, remaining: { value: number }, seen: Set<object>): ClassificationNode | undefined {
	if (!isPlainObjectRecord(value) || seen.has(value) || remaining.value <= 0)
		return undefined;
	if (typeof value.name !== 'string' || typeof value.uuid !== 'string')
		throw new TypeError('EDA lib_Classification.getAllClassificationTree returned an invalid node.');
	seen.add(value);
	remaining.value -= 1;
	const output: ClassificationNode = { name: value.name, uuid: value.uuid };
	if (maxDepth > 1 && Array.isArray(value.children)) {
		const children = value.children
			.map(child => limitTree(child, maxDepth - 1, remaining, seen))
			.filter((child): child is ClassificationNode => child !== undefined);
		if (children.length > 0)
			output.children = children;
	}
	return output;
}

export async function handleLibraryClassificationTask(payload: unknown): Promise<unknown> {
	if (!isPlainObjectRecord(payload))
		throw new TypeError('library_classification_query payload must be an object.');
	const kind = parseKind(payload.kind);
	const libraryUuid = requiredString(payload, 'libraryUuid');
	const maxNodes = parseBoundedIntegerValue(payload.maxNodes, 500, 1, 2000);
	const maxDepth = parseBoundedIntegerValue(payload.maxDepth, 8, 1, 20);
	const eda = getEdaRuntime();
	const api = eda?.lib_Classification;
	if (!isPlainObjectRecord(api) || typeof api.getAllClassificationTree !== 'function')
		throw new TypeError('EDA lib_Classification.getAllClassificationTree API is unavailable in this client version.');
	const rawTree = await (api.getAllClassificationTree as (uuid: string, type: string) => Promise<unknown>).call(api, libraryUuid, LIBRARY_TYPE_BY_KIND[kind]);
	if (!Array.isArray(rawTree))
		throw new TypeError('EDA lib_Classification.getAllClassificationTree returned an invalid result.');
	const total = rawTree.reduce((count, item) => count + countNodes(item, new Set<object>()), 0);
	const remaining = { value: maxNodes };
	const tree = preserveBoundedArray(rawTree
		.map(item => limitTree(item, maxDepth, remaining, new Set<object>()))
		.filter((item): item is ClassificationNode => item !== undefined));
	const returned = maxNodes - remaining.value;
	return {
		ok: true,
		kind,
		libraryUuid,
		total,
		returned,
		truncated: returned < total,
		maxDepth,
		tree,
	};
}
