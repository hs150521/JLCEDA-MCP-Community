import { isPlainObjectRecord, toSerializableAsync } from '../utils.ts';

interface PcbDrcApi {
	check: (strict: boolean, userInterface: boolean, includeVerboseError: true) => Promise<unknown>;
}

function resolvePcbDrcApi(): PcbDrcApi {
	const edaGlobal = (globalThis as unknown as { eda?: unknown }).eda;
	if (!isPlainObjectRecord(edaGlobal) || !isPlainObjectRecord(edaGlobal.pcb_Drc)) {
		throw new TypeError('EDA PCB DRC API is unavailable. Open a PCB document before running pcb_drc_check.');
	}

	const api = edaGlobal.pcb_Drc;
	if (typeof api.check !== 'function') {
		throw new TypeError('EDA pcb_Drc.check API is unavailable in this client version.');
	}

	return { check: api.check as PcbDrcApi['check'] };
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

	const rawResult = await resolvePcbDrcApi().check(strict, showUi, true);
	const result = await toSerializableAsync(rawResult);
	const errors = Array.isArray(result) ? result : [];

	return {
		ok: Array.isArray(result) ? errors.length === 0 : result === true,
		strict,
		showUi,
		resultType: Array.isArray(result) ? 'detailed' : typeof result,
		errorCount: errors.length,
		errors,
	};
}
