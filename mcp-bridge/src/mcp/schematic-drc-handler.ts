import { getEdaRuntime, isPlainObjectRecord, toSerializableAsync } from '../utils.ts';

interface SchematicDrcApi {
	check: (strict: boolean, userInterface: boolean, includeVerboseError: true) => Promise<unknown>;
}

export async function handleSchematicDrcCheckTask(payload: unknown): Promise<unknown> {
	if (payload !== undefined && payload !== null && !isPlainObjectRecord(payload)) {
		throw new TypeError('schematic_drc_check payload must be an object.');
	}
	const input = isPlainObjectRecord(payload) ? payload : {};
	const strict = input.strict === undefined ? true : input.strict;
	const showUi = input.showUi === undefined ? false : input.showUi;
	if (typeof strict !== 'boolean' || typeof showUi !== 'boolean') {
		throw new TypeError('strict and showUi must be booleans.');
	}
	const eda = getEdaRuntime();
	const api = eda?.sch_Drc;
	if (!isPlainObjectRecord(api) || typeof api.check !== 'function') {
		throw new TypeError('EDA sch_Drc.check API is unavailable in this client version.');
	}
	const rawResult = await (api.check as SchematicDrcApi['check']).call(api, strict, showUi, true);
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
		errors: await toSerializableAsync(rawErrors),
		truncated: rawErrors.length > 120,
	};
}
