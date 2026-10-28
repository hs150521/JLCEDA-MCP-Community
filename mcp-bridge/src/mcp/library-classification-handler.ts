import { getEdaRuntime, isPlainObjectRecord, parseBoundedIntegerValue, preserveBoundedArray } from '../utils.ts';

type LibraryKind = 'device' | 'symbol' | 'footprint' | 'model_3d' | 'cbb' | 'panel_library';
type ClassificationApi = 'getClassificationTree' | 'getAllClassificationTree';
type ClassificationFallbackReason = 'modern_api_unavailable' | 'modern_tree_empty';

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
	namePath: string[];
	uuid?: string;
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

function limitTree(value: unknown, maxDepth: number, remaining: { value: number }, seen: Set<object>, parentPath: string[] = []): ClassificationNode | undefined {
	if (!isPlainObjectRecord(value) || seen.has(value) || remaining.value <= 0)
		return undefined;
	if (typeof value.name !== 'string' || (value.uuid !== undefined && typeof value.uuid !== 'string'))
		throw new TypeError('EDA lib_Classification returned an invalid classification node.');
	seen.add(value);
	remaining.value -= 1;
	// v4 多级分类以名称路径标识；旧接口的 UUID 在存在时仍保留。
	const namePath = [...parentPath, value.name];
	const output: ClassificationNode = { name: value.name, namePath, ...(typeof value.uuid === 'string' ? { uuid: value.uuid } : {}) };
	if (maxDepth > 1 && Array.isArray(value.children)) {
		const children = value.children
			.map(child => limitTree(child, maxDepth - 1, remaining, seen, namePath))
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
	if (!isPlainObjectRecord(api))
		throw new TypeError('EDA lib_Classification API is unavailable in this client version.');
	let classificationApi: ClassificationApi = typeof api.getClassificationTree === 'function' ? 'getClassificationTree' : 'getAllClassificationTree';
	let fallbackReason: ClassificationFallbackReason | undefined = classificationApi === 'getAllClassificationTree' ? 'modern_api_unavailable' : undefined;
	if (typeof api[classificationApi] !== 'function')
		throw new TypeError('EDA lib_Classification.getClassificationTree/getAllClassificationTree APIs are unavailable in this client version.');
	const readTree = async (methodName: ClassificationApi): Promise<unknown[]> => {
		const result = await (api[methodName] as (uuid: string, type: string) => Promise<unknown>).call(api, libraryUuid, LIBRARY_TYPE_BY_KIND[kind]);
		if (!Array.isArray(result))
			throw new TypeError(`EDA lib_Classification.${methodName} returned an invalid result.`);
		return result;
	};
	let rawTree = await readTree(classificationApi);
	// 部分 v4 公共库的新分类接口合法返回空树，旧接口仍提供可用分类。
	if (classificationApi === 'getClassificationTree' && rawTree.length === 0 && typeof api.getAllClassificationTree === 'function') {
		const legacyTree = await readTree('getAllClassificationTree');
		if (legacyTree.length > 0) {
			rawTree = legacyTree;
			classificationApi = 'getAllClassificationTree';
			fallbackReason = 'modern_tree_empty';
		}
	}
	const total = rawTree.reduce<number>((count, item) => count + countNodes(item, new Set<object>()), 0);
	const remaining = { value: maxNodes };
	const tree = preserveBoundedArray(rawTree
		.map(item => limitTree(item, maxDepth, remaining, new Set<object>()))
		.filter((item): item is ClassificationNode => item !== undefined));
	const returned = maxNodes - remaining.value;
	return {
		ok: true,
		kind,
		libraryUuid,
		classificationApi,
		...(fallbackReason ? { fallbackReason } : {}),
		total,
		returned,
		truncated: returned < total,
		maxDepth,
		tree,
	};
}
