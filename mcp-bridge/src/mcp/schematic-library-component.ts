import { getEdaRuntime, isPlainObjectRecord, toSafeErrorMessage } from '../utils.ts';

type Resolution = { ok: true; component: Record<string, unknown>; subPartName?: string }
	| { ok: false; errorCode: string; reason: string; error: string; applied: false; nativeCallStarted: false };

function defaultSubPart(component: Record<string, unknown>, requested: unknown): string | undefined {
	if (typeof requested === 'string' && requested.trim())
		return requested;
	return Array.isArray(component.subPartNames) && component.subPartNames.length === 1 && typeof component.subPartNames[0] === 'string'
		? component.subPartNames[0]
		: undefined;
}

function completeDeviceItem(component: Record<string, unknown>): boolean {
	const association = component.association;
	return (isPlainObjectRecord(association) && (typeof association.symbolUuid === 'string' || isPlainObjectRecord(association.symbol)))
		|| isPlainObjectRecord(component.symbol) || typeof component.symbolUuid === 'string';
}

/** 裸引用先确认器件存在；官方完整 DeviceItem/SearchItem 保留其原生创建重载。 */
export async function resolveSchematicLibraryComponent(raw: unknown, requestedSubPart: unknown): Promise<Resolution> {
	if (!isPlainObjectRecord(raw))
		throw new TypeError('Schematic library component must be an object.');
	const runtime = getEdaRuntime();
	const libraryTypes = isPlainObjectRecord(runtime?.ELIB_LibraryType) ? runtime.ELIB_LibraryType : {};
	// SYMBOL 引用使用其独立原生重载；DEVICE 在官方及 3.2.181 均为字符串 3。
	if (raw.libraryType === (libraryTypes.SYMBOL ?? '2') || completeDeviceItem(raw))
		return { ok: true, component: raw, subPartName: defaultSubPart(raw, requestedSubPart) };
	const device = runtime?.lib_Device;
	// 某些宿主未暴露 get；官方仍允许裸引用创建，保留该兼容路径。
	if (!isPlainObjectRecord(device) || typeof device.get !== 'function')
		return { ok: true, component: raw, subPartName: defaultSubPart(raw, requestedSubPart) };
	let item: unknown;
	try {
		item = await device.get(raw.uuid, raw.libraryUuid);
	}
	catch (error: unknown) {
		return { ok: false, errorCode: 'DEVICE_LOOKUP_FAILED', reason: 'device_lookup_failed', error: toSafeErrorMessage(error), applied: false, nativeCallStarted: false };
	}
	if (item === undefined || item === null) {
		return { ok: false, errorCode: 'DEVICE_NOT_FOUND', reason: 'device_not_found', error: 'The requested device UUID was not found in the specified EDA library.', applied: false, nativeCallStarted: false };
	}
	if (!isPlainObjectRecord(item) || item.uuid !== raw.uuid
		|| (typeof raw.libraryUuid === 'string' && raw.libraryUuid !== '' && item.libraryUuid !== raw.libraryUuid)) {
		return { ok: false, errorCode: 'DEVICE_LOOKUP_MISMATCH', reason: 'device_lookup_mismatch', error: 'EDA library lookup did not return the requested device.', applied: false, nativeCallStarted: false };
	}
	return { ok: true, component: item, subPartName: defaultSubPart(item, requestedSubPart) };
}
