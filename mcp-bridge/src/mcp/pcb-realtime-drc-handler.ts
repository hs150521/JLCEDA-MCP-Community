import { getEdaRuntime, isPlainObjectRecord, toSerializableAsync } from '../utils.ts';

export async function handlePcbRealtimeDrcTask(payload: unknown): Promise<unknown> {
	if (payload !== undefined && payload !== null && !isPlainObjectRecord(payload))
		throw new TypeError('pcb_realtime_drc payload must be an object.');
	const input = isPlainObjectRecord(payload) ? payload : {};
	const action = input.action === undefined ? 'status' : input.action;
	if (action !== 'status' && action !== 'start' && action !== 'stop')
		throw new TypeError('action must be status, start, or stop.');
	const eda = getEdaRuntime();
	const api = eda?.pcb_Drc;
	if (!isPlainObjectRecord(api))
		throw new TypeError('EDA pcb_Drc API is unavailable. Open a PCB document first.');
	const methodName = action === 'status' ? 'getRealTimeDrcStatus' : action === 'start' ? 'startRealTimeDrc' : 'stopRealTimeDrc';
	const method = api[methodName];
	if (typeof method !== 'function')
		throw new TypeError(`EDA pcb_Drc.${methodName} API is unavailable in this client version (requires EDA v4.2).`);
	const result = await toSerializableAsync(await (method as () => Promise<unknown>).call(api));
	return { ok: action === 'status' || result === true, action, ...(action === 'status' ? { enabled: result } : { changed: result }) };
}
