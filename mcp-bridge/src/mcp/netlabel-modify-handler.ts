/**
 * ------------------------------------------------------------------------
 * 名称：网络标签修改任务处理器
 * 说明：修改指定引脚附近或指定 ID 的网络标签名称。
 *       作为备用方案，用于修正已放置的网络标签。
 * 作者：Lion
 * 邮箱：chengbin@3578.cn
 * 日期：2026-07-04
 * 备注：支持按引脚位置查找或按图元 ID 直接修改。
 * ------------------------------------------------------------------------
 */

import { getSyncState, isPlainObjectRecord } from '../utils';

interface ComponentApi {
	context: unknown;
	getAllPinsByPrimitiveId: (primitiveId: string) => Promise<Array<unknown>>;
	get: (primitiveId: string) => Promise<unknown>;
}

interface AttributeApi {
	context: unknown;
	modify: (
		primitiveId: string,
		property: { value?: string },
	) => Promise<unknown>;
	get: (primitiveId: string) => Promise<unknown>;
}

interface DocumentApi {
	context: unknown;
	getPrimitivesInRegion: (
		left: number,
		right: number,
		top: number,
		bottom: number,
	) => Array<unknown> | Promise<Array<unknown>>;
}

interface PinObject {
	x: number;
	y: number;
	pinNumber: string;
	pinName: string;
}

type NetLabelPrimitiveKind = 'attribute' | 'netFlag';

interface NetLabelTarget {
	primitiveId: string;
	kind: NetLabelPrimitiveKind;
}

// 获取组件 API
function resolveComponentApi(): ComponentApi {
	const componentModule = eda.sch_PrimitiveComponent;
	if (
		!isPlainObjectRecord(componentModule)
		|| typeof componentModule.getAllPinsByPrimitiveId !== 'function'
		|| typeof componentModule.get !== 'function'
	) {
		throw new Error('未找到 eda.sch_PrimitiveComponent.get/getAllPinsByPrimitiveId API。');
	}

	return {
		context: componentModule,
		getAllPinsByPrimitiveId: componentModule.getAllPinsByPrimitiveId as (
			primitiveId: string,
		) => Promise<Array<unknown>>,
		get: componentModule.get as (primitiveId: string) => Promise<unknown>,
	};
}

// 获取属性 API
function resolveAttributeApi(): AttributeApi {
	const attributeModule = eda.sch_PrimitiveAttribute;
	if (
		!isPlainObjectRecord(attributeModule)
		|| typeof attributeModule.modify !== 'function'
		|| typeof attributeModule.get !== 'function'
	) {
		throw new Error('未找到 eda.sch_PrimitiveAttribute API。');
	}

	return {
		context: attributeModule,
		modify: attributeModule.modify as (
			primitiveId: string,
			property: { value?: string },
		) => Promise<unknown>,
		get: attributeModule.get as (primitiveId: string) => Promise<unknown>,
	};
}

// 获取文档 API
function resolveDocumentApi(): DocumentApi {
	const documentModule = eda.sch_Document;
	if (
		!isPlainObjectRecord(documentModule)
		|| typeof documentModule.getPrimitivesInRegion !== 'function'
	) {
		throw new Error('未找到 eda.sch_Document.getPrimitivesInRegion API。');
	}

	return {
		context: documentModule,
		getPrimitivesInRegion: documentModule.getPrimitivesInRegion as (
			left: number,
			right: number,
			top: number,
			bottom: number,
		) => Array<unknown> | Promise<Array<unknown>>,
	};
}

// 查找引脚
function findPin(pins: Array<unknown>, identifier: string): PinObject | null {
	for (let i = 0; i < pins.length; i += 1) {
		const pin = pins[i];
		if (!isPlainObjectRecord(pin)) {
			continue;
		}

		const pinNumber = String(getSyncState(pin, 'getState_PinNumber', '')).trim();
		const pinName = String(getSyncState(pin, 'getState_PinName', '')).trim();

		if (pinNumber === identifier || pinName === identifier) {
			return {
				x: Number(getSyncState(pin, 'getState_X', 0)),
				y: Number(getSyncState(pin, 'getState_Y', 0)),
				pinNumber,
				pinName,
			};
		}
	}

	return null;
}

// 在引脚附近查找普通网络标签或组件形式的电源/地网络标识。
function findNetLabelNearPin(primitives: Array<unknown>, pinX: number, pinY: number): NetLabelTarget | null {
	const searchRadius = 30; // 搜索半径（mil）

	for (let i = 0; i < primitives.length; i += 1) {
		const primitive = primitives[i];
		if (!isPlainObjectRecord(primitive)) {
			continue;
		}

		const primitiveType = String(getSyncState(primitive, 'getState_PrimitiveType', ''));
		const isAttribute = primitiveType === 'Attribute';
		const isNetFlag = primitiveType === 'Component'
			&& String(getSyncState(primitive, 'getState_ComponentType', '')) === 'netflag';
		if (!isAttribute && !isNetFlag) {
			continue;
		}

		const x = Number(getSyncState(primitive, 'getState_X', 0));
		const y = Number(getSyncState(primitive, 'getState_Y', 0));
		const distance = Math.sqrt((x - pinX) ** 2 + (y - pinY) ** 2);

		if (distance <= searchRadius) {
			const primitiveId = String(getSyncState(primitive, 'getState_PrimitiveId', '')).trim();
			if (primitiveId.length > 0) {
				return {
					primitiveId,
					kind: isNetFlag ? 'netFlag' : 'attribute',
				};
			}
		}
	}

	return null;
}

async function resolveNetLabelTargetById(
	primitiveId: string,
	attributeApi: AttributeApi,
	componentApi: ComponentApi,
): Promise<{ target: NetLabelTarget; primitive: unknown }> {
	try {
		const attribute = await Promise.resolve(
			attributeApi.get.call(attributeApi.context, primitiveId),
		);
		if (attribute !== undefined && attribute !== null) {
			return {
				target: { primitiveId, kind: 'attribute' },
				primitive: attribute,
			};
		}
	}
	catch {
		// The ID may refer to a component-backed net flag.
	}

	const component = await Promise.resolve(
		componentApi.get.call(componentApi.context, primitiveId),
	);
	if (
		component !== undefined
		&& component !== null
		&& String(getSyncState(component, 'getState_ComponentType', '')) === 'netflag'
	) {
		return {
			target: { primitiveId, kind: 'netFlag' },
			primitive: component,
		};
	}

	throw new Error('目标图元不是普通网络标签或电源/地网络标识。');
}

async function modifyNetFlag(component: unknown, newNetName: string): Promise<unknown> {
	const setStateNet = (component as Record<string, unknown>)?.setState_Net;
	if (typeof setStateNet !== 'function') {
		throw new TypeError('当前 EDA SDK 返回的 NetFlag 不支持 setState_Net。');
	}

	const updated = (setStateNet as (net: string) => unknown).call(component, newNetName);
	const updateTarget = updated !== null && (typeof updated === 'object' || typeof updated === 'function')
		? updated
		: component;
	const done = (updateTarget as Record<string, unknown>)?.done;
	if (typeof done !== 'function') {
		throw new TypeError('当前 EDA SDK 返回的 NetFlag 不支持 done。');
	}

	return await Promise.resolve((done as () => unknown).call(updateTarget));
}

/**
 * 处理网络标签修改任务。
 * @param payload 任务参数。
 * @returns 修改结果。
 */
export async function handleNetLabelModifyTask(payload: unknown): Promise<unknown> {
	if (!isPlainObjectRecord(payload)) {
		throw new TypeError('netlabel/modify 任务参数必须为对象。');
	}

	const target = payload.target;
	const newNetName = String(payload.newNetName ?? '').trim();

	if (!isPlainObjectRecord(target)) {
		throw new TypeError('target 参数必须为对象。');
	}
	if (newNetName.length === 0) {
		throw new Error('newNetName 不能为空。');
	}

	const targetType = String(target.type ?? '').trim();

	let targetPrimitive: NetLabelTarget | null = null;
	let oldNetName: string | undefined;

	// 方式 1：直接通过 primitiveId 修改
	if (targetType === 'primitiveId') {
		const primitiveId = String(target.primitiveId ?? '').trim();
		if (primitiveId.length === 0) {
			throw new Error('target.primitiveId 不能为空。');
		}
		targetPrimitive = { primitiveId, kind: 'attribute' };
	}
	// 方式 2：通过引脚位置查找网络标签
	else if (targetType === 'pin') {
		const componentId = String(target.componentId ?? '').trim();
		const pinIdentifier = String(target.pinIdentifier ?? '').trim();

		if (componentId.length === 0) {
			throw new Error('target.componentId 不能为空。');
		}
		if (pinIdentifier.length === 0) {
			throw new Error('target.pinIdentifier 不能为空。');
		}

		const componentApi = resolveComponentApi();
		const documentApi = resolveDocumentApi();

		// 获取器件引脚
		const pins = await Promise.resolve(
			componentApi.getAllPinsByPrimitiveId.call(componentApi.context, componentId),
		);

		if (!Array.isArray(pins) || pins.length === 0) {
			throw new Error('未找到器件引脚，请检查 componentId 是否正确。');
		}

		// 查找目标引脚
		const pin = findPin(pins, pinIdentifier);
		if (!pin) {
			throw new Error(`未找到引脚 "${pinIdentifier}"，请检查引脚编号或名称。`);
		}

		// 在引脚附近搜索网络标签
		const searchRadius = 30;
		const primitives = await Promise.resolve(
			documentApi.getPrimitivesInRegion.call(
				documentApi.context,
				pin.x - searchRadius,
				pin.x + searchRadius,
				pin.y - searchRadius,
				pin.y + searchRadius,
			),
		);

		if (!Array.isArray(primitives)) {
			throw new TypeError('getPrimitivesInRegion 返回无效结果。');
		}

		targetPrimitive = findNetLabelNearPin(primitives, pin.x, pin.y);
		if (!targetPrimitive) {
			throw new Error(`在引脚 "${pinIdentifier}" 附近未找到网络标签，请检查是否已放置。`);
		}
	}
	else {
		throw new Error('target.type 必须为 "primitiveId" 或 "pin"。');
	}

	if (!targetPrimitive) {
		throw new Error('无法解析目标网络标签。');
	}

	const attributeApi = resolveAttributeApi();
	const componentApi = resolveComponentApi();
	let currentPrimitive: unknown;
	if (targetType === 'primitiveId') {
		const resolved = await resolveNetLabelTargetById(
			targetPrimitive.primitiveId,
			attributeApi,
			componentApi,
		);
		targetPrimitive = resolved.target;
		currentPrimitive = resolved.primitive;
	}

	if (targetPrimitive.kind === 'attribute') {
		try {
			const currentAttribute = currentPrimitive ?? await Promise.resolve(
				attributeApi.get.call(attributeApi.context, targetPrimitive.primitiveId),
			);
			if (isPlainObjectRecord(currentAttribute)) {
				oldNetName = String(getSyncState(currentAttribute, 'getState_Value', '')).trim();
			}
		}
		catch {
			// 忽略获取失败，继续修改
		}
	}
	else {
		currentPrimitive = currentPrimitive ?? await Promise.resolve(
			componentApi.get.call(componentApi.context, targetPrimitive.primitiveId),
		);
		oldNetName = String(getSyncState(currentPrimitive, 'getState_Net', '')).trim();
	}

	const result = targetPrimitive.kind === 'attribute'
		? await Promise.resolve(
				attributeApi.modify.call(attributeApi.context, targetPrimitive.primitiveId, {
					value: newNetName,
				}),
			)
		: await modifyNetFlag(currentPrimitive, newNetName);

	if (!result) {
		return {
			ok: false,
			error: 'API 返回空结果，修改失败。',
		};
	}

	return {
		ok: true,
		primitiveId: targetPrimitive.primitiveId,
		kind: targetPrimitive.kind,
		oldNetName: oldNetName || '(未知)',
		newNetName,
		message: `网络标签已修改：${oldNetName || '(未知)'} → ${newNetName}`,
	};
}
