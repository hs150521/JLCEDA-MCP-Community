import type { FootprintIdentity } from '../bridge/editor-context.ts';
import { assertFootprintIdentity, readFootprintIdentity } from '../bridge/editor-context.ts';
import { getEdaRuntime, isPlainObjectRecord, isUnknownNativeRpcResult, toSafeErrorMessage } from '../utils.ts';

/** 将当前封装源码原样写回共享库封装；库 ACK 不等同于引用 PCB 的持久化验证。 */
export async function handleFootprintSaveTask(payload: unknown, _reportPinAdapter?: unknown, beforeNativeMutation?: () => void): Promise<unknown> {
	if (payload !== undefined && payload !== null && (!isPlainObjectRecord(payload)
		|| Object.keys(payload).some(key => key !== 'timeoutMs' && key !== 'expectedFootprintIdentity'))) {
		throw new TypeError('footprint_save only accepts timeoutMs and saves the current footprint source.');
	}
	const runtime = getEdaRuntime();
	if (!runtime)
		throw new TypeError('EDA runtime is unavailable.');
	const fileApi = runtime.sys_FileManager;
	const libraryApi = runtime.lib_Footprint;
	if (!isPlainObjectRecord(fileApi) || typeof fileApi.getDocumentSource !== 'function'
		|| !isPlainObjectRecord(libraryApi) || typeof libraryApi.updateDocumentSource !== 'function') {
		throw new TypeError('EDA footprint source saving APIs are unavailable.');
	}
	const identity = await readFootprintIdentity(runtime);
	const expected = isPlainObjectRecord(payload) ? payload.expectedFootprintIdentity : undefined;
	if (expected !== undefined)
		await assertFootprintIdentity(runtime, expected as FootprintIdentity);
	const source: unknown = await fileApi.getDocumentSource();
	if (typeof source !== 'string' || !source.trim())
		throw new TypeError('Current footprint document source is unavailable.');
	await assertFootprintIdentity(runtime, identity);
	beforeNativeMutation?.();
	const result = { scope: 'library_source', ...identity, sharedSource: true, sourceLength: source.length, nativeCallAttempted: true, nativeCallSettled: true };
	let acknowledged: unknown;
	try {
		acknowledged = await libraryApi.updateDocumentSource(identity.documentUuid, identity.libraryUuid, source);
	}
	catch (error: unknown) {
		const message = toSafeErrorMessage(error);
		return isUnknownNativeRpcResult(message)
			? { ...result, ok: false, commitUnknown: true, readbackRequired: true, nativeCallSettled: false, reason: 'native_footprint_save_unknown', error: message }
			: { ...result, ok: false, saved: false, saveAcknowledged: false, reason: 'native_footprint_save_rejected', error: message };
	}
	if (acknowledged !== true)
		return { ...result, ok: false, saved: false, saveAcknowledged: false, reason: 'native_footprint_save_not_acknowledged' };
	try {
		await assertFootprintIdentity(runtime, identity);
		return { ...result, ok: true, saved: true, saveAcknowledged: true, identityVerified: true };
	}
	catch (error: unknown) {
		// updateDocumentSource 明确指定库和封装，ACK 后换页不否定已经完成的库写入。
		return { ...result, ok: false, saved: true, saveAcknowledged: true, identityVerified: false, reason: 'footprint_changed_after_save', error: toSafeErrorMessage(error) };
	}
}
