import { getEdaRuntime, isPlainObjectRecord, toSerializableAsync } from '../utils.ts';

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

	return api as PcbDrcApi;
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

	const api = resolvePcbDrcApi();
	const rawResult = await api.check(strict, showUi, true);
	const rawErrors = Array.isArray(rawResult) ? rawResult : [];
	const errorCount = rawErrors.reduce((total, error) => {
		if (isPlainObjectRecord(error) && typeof error.count === 'number' && Number.isFinite(error.count)) {
			return total + Math.max(0, Math.trunc(error.count));
		}
		return total + 1;
	}, 0);

	return {
		ok: Array.isArray(rawResult) ? rawErrors.length === 0 : rawResult === true,
		strict,
		showUi,
		resultType: Array.isArray(rawResult) ? 'detailed' : typeof rawResult,
		errorCount,
		errors: await toSerializableAsync(rawErrors.slice(0, 120)),
		truncated: rawErrors.length > 120,
	};
}
