import type { SchematicPinAdapter } from '../bridge/protocol.ts';
import { getEdaRuntime, getSyncState, isPlainObjectRecord, isUnknownNativeRpcResult, preserveBoundedArray, toSafeErrorMessage } from '../utils.ts';

type Api = Record<string, unknown>;
type PinState = Record<string, unknown> & { primitiveId: string; pinNumber: string; noConnected: boolean };

const GETTERS: Record<string, string> = {
	x: 'getState_X',
	y: 'getState_Y',
	rotation: 'getState_Rotation',
	pinNumber: 'getState_PinNumber',
	pinName: 'getState_PinName',
	pinLength: 'getState_PinLength',
	pinColor: 'getState_PinColor',
	pinShape: 'getState_PinShape',
	pinType: 'getState_pinType',
	noConnected: 'getState_NoConnected',
};

function readPin(pin: unknown): PinState {
	if (!isPlainObjectRecord(pin))
		throw new TypeError('EDA component pin is not readable.');
	const primitiveId = getSyncState(pin, 'getState_PrimitiveId', '');
	if (typeof primitiveId !== 'string' || !primitiveId)
		throw new TypeError('EDA component pin ID is not readable.');
	const state: Record<string, unknown> = { primitiveId, primitiveType: 'ComponentPin' };
	for (const [key, method] of Object.entries(GETTERS)) {
		const getter = pin[method] ?? (key === 'pinType' ? pin.getState_PinType : undefined);
		if (typeof getter !== 'function')
			throw new TypeError(`EDA component pin getter is unavailable: ${method}`);
		state[key] = getter.call(pin);
	}
	if (state.noConnected === undefined)
		state.noConnected = false;
	if (typeof state.pinNumber !== 'string' || typeof state.noConnected !== 'boolean'
		|| ['x', 'y', 'rotation', 'pinLength'].some(key => typeof state[key] !== 'number' || !Number.isFinite(state[key]))) {
		throw new TypeError('EDA component pin geometry or NC state is not readable.');
	}
	const property = typeof pin.getState_OtherProperty === 'function' ? pin.getState_OtherProperty() : undefined;
	if (property !== undefined && !isPlainObjectRecord(property))
		throw new TypeError('EDA component pin properties are not readable.');
	state.otherProperty = property === undefined ? {} : { ...property };
	return state as PinState;
}

function clonePin(state: PinState): PinState {
	return { ...state, otherProperty: isPlainObjectRecord(state.otherProperty) ? { ...state.otherProperty } : state.otherProperty };
}

function comparable(value: unknown): string {
	return JSON.stringify(isPlainObjectRecord(value) ? Object.entries(value).sort(([left], [right]) => left.localeCompare(right)) : value);
}

async function assertPage(runtime: Api, pageUuid: string): Promise<void> {
	const schematic = runtime.dmt_Schematic as Api;
	const page = await (schematic.getCurrentSchematicPageInfo as () => Promise<unknown>).call(schematic);
	if (!isPlainObjectRecord(page) || page.uuid !== pageUuid)
		throw new Error('The active schematic page changed during the component pin edit.');
}

interface Owner {
	primitiveId: string;
	pins: Api[];
	readPins: () => Promise<unknown>;
}

async function findOwner(api: Api, targetId: string): Promise<Owner | undefined> {
	if (typeof api.getAll !== 'function')
		throw new TypeError('EDA current-page components are unavailable for component pin editing.');
	const components = await api.getAll(undefined, false);
	if (!Array.isArray(components))
		throw new TypeError('EDA current-page components are not readable.');
	// 分组读取保持 IPC 数量有界；必须取得原生 ComponentPin 实例，不能用 Pin.get 的结果替代。
	for (let index = 0; index < components.length; index += 4) {
		const owners = await Promise.all(components.slice(index, index + 4).map(async (component): Promise<Owner | undefined> => {
			if (!isPlainObjectRecord(component))
				throw new TypeError('EDA schematic component is not readable.');
			const primitiveId = getSyncState(component, 'getState_PrimitiveId', '');
			if (typeof primitiveId !== 'string' || !primitiveId)
				throw new TypeError('EDA schematic component ID is not readable.');
			const instanceReadPins = component.getAllPins;
			const moduleReadPins = api.getAllPinsByPrimitiveId;
			const readPins = typeof instanceReadPins === 'function'
				? async () => await instanceReadPins.call(component)
				: typeof moduleReadPins === 'function'
					? async () => await moduleReadPins.call(api, primitiveId)
					: undefined;
			if (!readPins)
				throw new TypeError('EDA component pin enumeration is unavailable.');
			const pins = await readPins();
			if (pins === undefined)
				return undefined;
			if (!Array.isArray(pins))
				throw new TypeError('EDA component pins are not readable.');
			return pins.some(pin => getSyncState(pin, 'getState_PrimitiveId', '') === targetId)
				? { primitiveId, pins, readPins }
				: undefined;
		}));
		const matches = owners.filter((owner): owner is Owner => owner !== undefined);
		if (matches.length > 1)
			throw new TypeError('EDA component pin has multiple current-page owners.');
		if (matches.length === 1)
			return matches[0];
	}
	return undefined;
}

/** 将 ComponentPin 的可写字段通过其真实实例提交，普通符号 Pin 留给原生 API。 */
export async function tryModifySchematicComponentPin(args: unknown[], reportAdapter?: (adapter: SchematicPinAdapter) => void): Promise<Record<string, unknown> | undefined> {
	const primitiveId = args[0];
	const property = args[1];
	if (typeof primitiveId !== 'string' || !isPlainObjectRecord(property))
		return undefined;
	const runtime = getEdaRuntime();
	const schematic = runtime?.dmt_Schematic;
	const select = runtime?.dmt_SelectControl;
	if (!runtime || !isPlainObjectRecord(schematic) || typeof schematic.getCurrentSchematicPageInfo !== 'function')
		return undefined;
	const document = isPlainObjectRecord(select) && typeof select.getCurrentDocumentInfo === 'function'
		? await select.getCurrentDocumentInfo()
		: undefined;
	const types = isPlainObjectRecord(runtime.EDMT_EditorDocumentType) ? runtime.EDMT_EditorDocumentType : {};
	if (isPlainObjectRecord(document) && document.documentType !== undefined
		&& document.documentType !== (types.SCHEMATIC_PAGE ?? 1)) {
		return undefined;
	}
	const page = await schematic.getCurrentSchematicPageInfo();
	if (!isPlainObjectRecord(page) || typeof page.uuid !== 'string' || !page.uuid)
		return undefined;
	const componentApi = runtime.sch_PrimitiveComponent;
	if (!isPlainObjectRecord(componentApi))
		throw new TypeError('EDA component API is unavailable for component pin editing.');
	const owner = await findOwner(componentApi, primitiveId);
	await assertPage(runtime, page.uuid);
	if (!owner)
		return undefined;
	if (Object.keys(property).some(key => key !== 'noConnected' && key !== 'pinNumber'))
		throw new TypeError('ComponentPin only supports pinNumber and noConnected edits; its geometry belongs to the library symbol.');
	if (property.noConnected !== undefined && typeof property.noConnected !== 'boolean')
		throw new TypeError('noConnected must be a boolean.');
	if (property.pinNumber !== undefined && (typeof property.pinNumber !== 'string' || !property.pinNumber))
		throw new TypeError('pinNumber must be a non-empty string.');
	const beforePins = owner.pins.map(readPin);
	const before = beforePins.find(pin => pin.primitiveId === primitiveId)!;
	const requested = Object.fromEntries(Object.entries(property).filter(([, value]) => value !== undefined));
	const context = { pageUuid: page.uuid, parentPrimitiveId: owner.primitiveId, primitiveId, scope: 'current_schematic_page', adapter: 'component_pin_instance' };
	if (Object.entries(requested).every(([key, value]) => before[key] === value))
		return { ok: true, ...context, result: clonePin(before), before, after: clonePin(before), changed: false, verified: true };
	const target = owner.pins.find(pin => getSyncState(pin, 'getState_PrimitiveId', '') === primitiveId)!;
	if (typeof target.toAsync !== 'function')
		throw new TypeError('EDA ComponentPin.toAsync is unavailable; the pin was not modified.');
	const editable = target.toAsync();
	if (!isPlainObjectRecord(editable) || typeof editable.done !== 'function'
		|| Object.keys(requested).some(key => typeof editable[key === 'noConnected' ? 'setState_NoConnected' : 'setState_PinNumber'] !== 'function')) {
		throw new TypeError('EDA ComponentPin setters/done are unavailable; the pin was not modified.');
	}
	for (const [key, value] of Object.entries(requested))
		(editable[key === 'noConnected' ? 'setState_NoConnected' : 'setState_PinNumber'] as (value: unknown) => unknown).call(editable, value);
	await assertPage(runtime, page.uuid);
	// 紧邻原生写入上报执行路径，同时重新核对租约和连接；此后不能再 await 只读查询。
	reportAdapter?.('component_pin_instance');
	try {
		await editable.done();
	}
	catch (error: unknown) {
		const message = toSafeErrorMessage(error);
		return { ok: false, ...context, before, reason: 'native_call_result_unknown', error: message, commitUnknown: true, readbackRequired: true, nativeCallSettled: !isUnknownNativeRpcResult(message) };
	}
	let after: PinState | undefined;
	try {
		const rawAfter = await owner.readPins();
		await assertPage(runtime, page.uuid);
		if (!Array.isArray(rawAfter))
			throw new TypeError('EDA component pins are not readable after modification.');
		const afterPins = rawAfter.map(readPin);
		after = afterPins.find(pin => pin.primitiveId === primitiveId);
		const sideEffects: Record<string, unknown>[] = [];
		for (const previous of beforePins) {
			const observed = afterPins.find(pin => pin.primitiveId === previous.primitiveId);
			if (!observed) {
				sideEffects.push({ primitiveId: previous.primitiveId, field: 'primitiveId', before: previous.primitiveId, after: null });
				continue;
			}
			for (const [key, value] of Object.entries(previous)) {
				const expected = previous.primitiveId === primitiveId && Object.hasOwn(requested, key) ? requested[key] : value;
				if (comparable(observed[key]) !== comparable(expected))
					sideEffects.push({ primitiveId: previous.primitiveId, field: key, before: isPlainObjectRecord(expected) ? { ...expected } : expected, after: isPlainObjectRecord(observed[key]) ? { ...observed[key] } : observed[key] });
			}
		}
		for (const observed of afterPins) {
			if (!beforePins.some(pin => pin.primitiveId === observed.primitiveId))
				sideEffects.push({ primitiveId: observed.primitiveId, field: 'primitiveId', before: null, after: observed.primitiveId });
		}
		if (!after || sideEffects.length) {
			return { ok: false, ...context, before, after, sideEffects: preserveBoundedArray(sideEffects), reason: 'post_write_readback_failed', error: 'EDA component pin state differs from the requested modification.', commitUnknown: true, readbackRequired: true, nativeCallSettled: true };
		}
		return { ok: true, ...context, before, after, result: clonePin(after), changed: true, verified: true };
	}
	catch (error: unknown) {
		return { ok: false, ...context, before, ...(after ? { after } : {}), reason: 'post_write_readback_failed', error: toSafeErrorMessage(error), commitUnknown: true, readbackRequired: true, nativeCallSettled: true };
	}
}
