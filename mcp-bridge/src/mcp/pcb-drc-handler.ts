import { getEdaRuntime, isPlainObjectRecord, preserveBoundedJson } from '../utils.ts';

interface DetailBudget { remaining: number; truncated: boolean }

function projectDetail(value: unknown, budget: DetailBudget, depth = 0, parents = new Set<object>()): unknown {
	if (--budget.remaining < 0 || depth > 6) {
		budget.truncated = true;
		return '[DetailLimitExceeded]';
	}
	if (typeof value === 'string') {
		if (value.length > 1024)
			budget.truncated = true;
		return value.slice(0, 1024);
	}
	if (value === null || typeof value === 'number' || typeof value === 'boolean')
		return value;
	if (typeof value !== 'object')
		return undefined;
	if (parents.has(value)) {
		budget.truncated = true;
		return '[Circular]';
	}
	parents.add(value);
	let result: unknown;
	if (Array.isArray(value)) {
		if (value.length > 120)
			budget.truncated = true;
		result = value.slice(0, 120).map(item => projectDetail(item, budget, depth + 1, parents));
	}
	else {
		const entries = Object.entries(value);
		if (entries.length > 40)
			budget.truncated = true;
		result = Object.fromEntries(entries.slice(0, 40).map(([key, child]) => {
			if (key === 'parentId' && isPlainObjectRecord(child)) {
				// 原生 DRC 可能回指分类对象；保留分类信息，不沿 list 再次展开整棵树。
				const { list: _list, parentId: _parentId, ...reference } = child;
				if ('list' in child || 'parentId' in child)
					budget.truncated = true;
				return [key, projectDetail(reference, budget, depth + 1, parents)];
			}
			return [key, projectDetail(child, budget, depth + 1, parents)];
		}));
	}
	parents.delete(value);
	return result;
}

interface DrcDetailTree {
	value: unknown;
	children?: DrcDetailTree[];
	detailCount: number;
	nativeTruncated: boolean;
	serializationTruncated: boolean;
}

function collectDetailTree(value: unknown, parents = new Set<object>(), depth = 0): DrcDetailTree {
	if (!isPlainObjectRecord(value) || !Array.isArray(value.list)) {
		return {
			value,
			detailCount: 1,
			nativeTruncated: isPlainObjectRecord(value) && typeof value.count === 'number' && value.count > 1,
			serializationTruncated: false,
		};
	}
	if (parents.has(value) || depth > 6)
		return { value, children: [], detailCount: 0, nativeTruncated: false, serializationTruncated: true };
	parents.add(value);
	const children = value.list.map(child => collectDetailTree(child, parents, depth + 1));
	parents.delete(value);
	const detailCount = children.reduce((total, child) => total + child.detailCount, 0);
	const serializationTruncated = children.some(child => child.serializationTruncated);
	return {
		value,
		children,
		detailCount,
		nativeTruncated: children.some(child => child.nativeTruncated)
			|| (!serializationTruncated && typeof value.count === 'number' && value.count > detailCount),
		serializationTruncated,
	};
}

interface DetailPage {
	skip: number;
	remaining: number;
	returned: number;
	stopped: boolean;
}

function projectDetailPage(tree: DrcDetailTree, page: DetailPage, budget: DetailBudget): unknown {
	if (page.skip >= tree.detailCount) {
		page.skip -= tree.detailCount;
		return undefined;
	}
	if (page.remaining === 0 || page.stopped)
		return undefined;
	if (!tree.children) {
		// 深度从错误明细重新计算，分类层级不占用 errData.line 等几何数据的额度。
		const projected = projectDetail(tree.value, budget);
		if (budget.remaining < 0 && page.returned > 0) {
			page.stopped = true;
			return undefined;
		}
		page.returned += 1;
		page.remaining -= 1;
		if (budget.remaining < 0)
			page.stopped = true;
		return projected;
	}
	const { list: _list, ...metadata } = tree.value as Record<string, unknown>;
	const projectedMetadata = projectDetail(metadata, budget);
	const before = page.returned;
	const list: unknown[] = [];
	for (const child of tree.children) {
		const projected = projectDetailPage(child, page, budget);
		if (projected !== undefined)
			list.push(projected);
		if (page.remaining === 0 || page.stopped)
			break;
	}
	if (list.length === 0)
		return undefined;
	return { ...(isPlainObjectRecord(projectedMetadata) ? projectedMetadata : {}), list, returned: page.returned - before };
}

interface PcbDrcApi {
	check: (strict: boolean, userInterface: boolean, includeVerboseError: true) => Promise<unknown>;
}

function resolvePcbDrcApi(): PcbDrcApi {
	const edaGlobal = getEdaRuntime();
	if (!isPlainObjectRecord(edaGlobal) || !isPlainObjectRecord(edaGlobal.pcb_Drc)) {
		throw new TypeError('EDA PCB DRC API is unavailable. Open a PCB document before running pcb_drc_check.');
	}

	const api = edaGlobal.pcb_Drc;
	if (typeof api.check !== 'function') {
		throw new TypeError('EDA pcb_Drc.check API is unavailable in this client version.');
	}

	return api as unknown as PcbDrcApi;
}

export async function handlePcbDrcCheckTask(payload: unknown): Promise<unknown> {
	if (payload !== undefined && payload !== null && !isPlainObjectRecord(payload)) {
		throw new TypeError('pcb_drc_check payload must be an object.');
	}

	const input = isPlainObjectRecord(payload) ? payload : {};
	const strict = input.strict === undefined ? true : input.strict;
	const showUi = input.showUi === undefined ? false : input.showUi;
	if (typeof strict !== 'boolean' || typeof showUi !== 'boolean') {
		throw new TypeError('strict and showUi must be booleans.');
	}
	const offset = input.offset ?? 0;
	const limit = input.limit ?? 120;
	if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0
		|| typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 500) {
		throw new TypeError('offset must be a non-negative integer and limit must be between 1 and 500.');
	}

	const api = resolvePcbDrcApi();
	const rawResult = await api.check(strict, showUi, true);
	const rawErrors = Array.isArray(rawResult) ? rawResult : [];
	const errorCount = rawErrors.reduce((total, error) => {
		if (isPlainObjectRecord(error) && typeof error.count === 'number' && Number.isFinite(error.count)) {
			return total + Math.max(0, Math.trunc(error.count));
		}
		return total + 1;
	}, 0);

	const categories = rawErrors.map(category => collectDetailTree(category));
	const budget: DetailBudget = { remaining: 5000, truncated: categories.some(category => category.serializationTruncated) };
	const availableDetails = categories.reduce((total, category) => total + category.detailCount, 0);
	const nativeTruncated = categories.some(category => category.nativeTruncated);
	const page: DetailPage = { skip: offset, remaining: limit, returned: 0, stopped: false };
	const errors: unknown[] = [];
	for (const category of categories) {
		const projected = projectDetailPage(category, page, budget);
		if (projected !== undefined)
			errors.push(projected);
		if (page.remaining === 0 || page.stopped)
			break;
	}
	const returnedDetails = page.returned;
	const nextOffset = offset + returnedDetails < availableDetails ? offset + returnedDetails : undefined;
	return preserveBoundedJson({
		ok: Array.isArray(rawResult) ? rawErrors.length === 0 : rawResult === true,
		strict,
		showUi,
		resultType: Array.isArray(rawResult) ? 'detailed' : typeof rawResult,
		errorCount,
		errors,
		offset,
		limit,
		totalAvailableDetails: availableDetails,
		returnedDetails,
		nextOffset,
		nativeTruncated,
		serializationTruncated: budget.truncated,
		truncated: offset > 0 || nextOffset !== undefined || nativeTruncated || budget.truncated,
	});
}
