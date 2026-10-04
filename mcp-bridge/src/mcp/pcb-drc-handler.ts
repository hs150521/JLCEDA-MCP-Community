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
		result = Object.fromEntries(entries.slice(0, 40).map(([key, child]) => [key, projectDetail(child, budget, depth + 1, parents)]));
	}
	parents.delete(value);
	return result;
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

	const budget: DetailBudget = { remaining: 5000, truncated: false };
	const categories = rawErrors.map((category) => {
		const list = isPlainObjectRecord(category) && Array.isArray(category.list) ? category.list : undefined;
		return { category, list, items: list ?? [category] };
	});
	const availableDetails = categories.reduce((total, { items }) => total + items.length, 0);
	const nativeTruncated = categories.some(({ category, items }) => isPlainObjectRecord(category)
		&& typeof category.count === 'number' && category.count > items.length);
	let visitedDetails = 0;
	let returnedDetails = 0;
	let detailLimitReached = false;
	const errors: unknown[] = [];
	for (const { category, list, items } of categories) {
		const start = Math.max(0, offset - visitedDetails);
		const selected = items.slice(start, start + Math.max(0, limit - returnedDetails));
		visitedDetails += items.length;
		if (selected.length === 0)
			continue;
		if (budget.remaining <= 0) {
			budget.truncated = true;
			break;
		}
		let metadata: Record<string, unknown> | undefined;
		if (list && isPlainObjectRecord(category)) {
			const { list: _list, ...nativeMetadata } = category;
			const projected = projectDetail(nativeMetadata, budget);
			metadata = isPlainObjectRecord(projected) ? projected : { detail: projected };
		}
		const projectedItems: unknown[] = [];
		for (const item of selected) {
			const projected = projectDetail(item, budget);
			if (budget.remaining < 0 && returnedDetails > 0) {
				// 当前细节尚未完整发送，下页从该条重新投影，不跳过占位项。
				detailLimitReached = true;
				break;
			}
			projectedItems.push(projected);
			returnedDetails += 1;
			if (budget.remaining < 0) {
				detailLimitReached = true;
				break;
			}
		}
		if (projectedItems.length > 0)
			errors.push(list ? { ...metadata, list: projectedItems, returned: projectedItems.length } : projectedItems[0]);
		if (detailLimitReached)
			break;
	}
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
