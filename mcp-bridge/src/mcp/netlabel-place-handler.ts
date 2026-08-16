/**
 * ------------------------------------------------------------------------
 * 名称：网络标签放置任务处理器
 * 说明：在指定引脚位置放置网络标签，支持自动识别电源/地符号类型。
 *       通过网络标签代替导线连接，避免 AI 绘制复杂路径。
 * 作者：Lion
 * 邮箱：chengbin@3578.cn
 * 日期：2026-07-04
 * 备注：支持批量放置，自动计算偏移量避免重叠。
 * ------------------------------------------------------------------------
 */

import { getSyncState, isPlainObjectRecord, toSafeErrorMessage } from '../utils';

interface NetLabelPlacement {
	componentId: string;
	pinIdentifier: string; // 引脚号或引脚名
	netName: string;
}

interface ComponentApi {
	context: unknown;
	getAllPinsByPrimitiveId: (primitiveId: string) => Promise<Array<unknown>>;
}

interface NetFlagApi {
	context: unknown;
	createNetFlag: (
		identification: 'Power' | 'Ground' | 'AnalogGround' | 'ProtectGround',
		net: string,
		x: number,
		y: number,
		rotation?: number,
		mirror?: boolean,
	) => Promise<unknown>;
}

interface NetLabelApi {
	context: unknown;
	createNetLabel: (x: number, y: number, net: string) => Promise<unknown>;
}

export type NetLabelKind = 'Power' | 'Ground' | 'AnalogGround' | 'ProtectGround' | 'NetLabel';
const NET_LABEL_CREATE_TIMEOUT_MS = 5_000;

interface PinObject {
	x: number;
	y: number;
	rotation: number;
	pinLength: number;
	pinNumber: string;
	pinName: string;
	net?: string;
}

// 解析单个网络标签放置参数
function normalizePlacement(raw: unknown, index: number): NetLabelPlacement {
	if (!isPlainObjectRecord(raw)) {
		throw new TypeError(`placements[${String(index)}] 必须为对象。`);
	}

	const componentId = String(raw.componentId ?? '').trim();
	const pinIdentifier = String(raw.pinIdentifier ?? '').trim();
	const netName = String(raw.netName ?? '').trim();

	if (componentId.length === 0) {
		throw new Error(`placements[${String(index)}].componentId 不能为空。`);
	}
	if (pinIdentifier.length === 0) {
		throw new Error(`placements[${String(index)}].pinIdentifier 不能为空。`);
	}
	if (netName.length === 0) {
		throw new Error(`placements[${String(index)}].netName 不能为空。`);
	}

	return { componentId, pinIdentifier, netName };
}

// 获取组件 API
function resolveComponentApi(): ComponentApi {
	const componentModule = eda.sch_PrimitiveComponent;
	if (
		!isPlainObjectRecord(componentModule)
		|| typeof componentModule.getAllPinsByPrimitiveId !== 'function'
	) {
		throw new Error('未找到 eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId API。');
	}

	return {
		context: componentModule,
		getAllPinsByPrimitiveId: componentModule.getAllPinsByPrimitiveId as (
			primitiveId: string,
		) => Promise<Array<unknown>>,
	};
}

// 获取网络标识 API
function resolveNetFlagApi(): NetFlagApi {
	const componentModule = eda.sch_PrimitiveComponent;
	if (
		!isPlainObjectRecord(componentModule)
		|| typeof componentModule.createNetFlag !== 'function'
	) {
		throw new Error('未找到 eda.sch_PrimitiveComponent.createNetFlag API。');
	}

	return {
		context: componentModule,
		createNetFlag: componentModule.createNetFlag as (
			identification: 'Power' | 'Ground' | 'AnalogGround' | 'ProtectGround',
			net: string,
			x: number,
			y: number,
			rotation?: number,
			mirror?: boolean,
		) => Promise<unknown>,
	};
}

export async function createNetLabelWithTimeout(
	task: Promise<unknown>,
	netName: string,
	timeoutMs = NET_LABEL_CREATE_TIMEOUT_MS,
): Promise<unknown> {
	let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;
	try {
		return await Promise.race([
			task,
			new Promise<never>((_resolve, reject) => {
				timeoutId = globalThis.setTimeout(() => {
					reject(new Error(`JLCEDA createNetLabel alpha API timed out for ${netName}`));
				}, timeoutMs);
			}),
		]);
	}
	finally {
		if (timeoutId !== undefined) {
			globalThis.clearTimeout(timeoutId);
		}
	}
}

// 获取普通网络标签 API。
function resolveNetLabelApi(): NetLabelApi {
	const attributeModule = eda.sch_PrimitiveAttribute;
	if (
		!isPlainObjectRecord(attributeModule)
		|| typeof attributeModule.createNetLabel !== 'function'
	) {
		throw new Error('未找到 eda.sch_PrimitiveAttribute.createNetLabel API。');
	}

	return {
		context: attributeModule,
		createNetLabel: attributeModule.createNetLabel as (
			x: number,
			y: number,
			net: string,
		) => Promise<unknown>,
	};
}

// 查找引脚
export function findPin(pins: Array<unknown>, identifier: string): PinObject | null {
	for (let i = 0; i < pins.length; i += 1) {
		const pin = pins[i];
		if (pin === null || (typeof pin !== 'object' && typeof pin !== 'function')) {
			continue;
		}

		const pinNumber = String(getSyncState(pin, 'getState_PinNumber', '')).trim();
		const pinName = String(getSyncState(pin, 'getState_PinName', '')).trim();

		if (pinNumber === identifier || pinName === identifier) {
			return {
				x: Number(getSyncState(pin, 'getState_X', 0)),
				y: Number(getSyncState(pin, 'getState_Y', 0)),
				rotation: Number(getSyncState(pin, 'getState_Rotation', 0)),
				pinLength: Number(getSyncState(pin, 'getState_PinLength', 0)),
				pinNumber,
				pinName,
			};
		}
	}

	return null;
}

// 计算标签偏移量（直接放在引脚位置，无偏移）
function calculateLabelOffset(): { x: number; y: number } {
	// 所有类型的网络标签/符号都直接放在引脚坐标上，不添加偏移
	return { x: 0, y: 0 };
}

// 检测网络标识类型（电源/地/自定义）
export function detectNetLabelKind(netName: string): NetLabelKind {
	const name = netName.toUpperCase();

	// 保护地
	if (/^(?:PE|PGND|PROTECTIVE|EARTH)/.test(name)) {
		return 'ProtectGround';
	}

	// 模拟地
	if (/^(?:AGND|ANALOG|GND_A)/.test(name)) {
		return 'AnalogGround';
	}

	// 普通地
	if (/^(?:GND|VSS|V-|DGND|GROUND)/.test(name)) {
		return 'Ground';
	}

	// 常见电源轨名称或名称中包含明确电压轨记法。
	if (/^(?:VCC|VDD|VEE|VBAT|VSYS|VIN|VOUT|VREF)(?:$|[_+-])/.test(name)
		|| /(?:^|_)[+-]?(?:\d+(?:\.\d+)?V|\d+V\d+)(?:$|_)/.test(name)) {
		return 'Power';
	}

	return 'NetLabel';
}

/**
 * 处理网络标签放置任务。
 * @param payload 任务参数。
 * @returns 放置结果。
 */
export async function handleNetLabelPlaceTask(payload: unknown): Promise<unknown> {
	if (!isPlainObjectRecord(payload)) {
		throw new TypeError('netlabel/place 任务参数必须为对象。');
	}

	const rawPlacements = payload.placements;
	if (!Array.isArray(rawPlacements)) {
		throw new TypeError('缺少 placements 参数，且其必须为数组。');
	}
	if (rawPlacements.length < 1) {
		throw new Error('placements 不能为空，至少需要提供一个待放置的网络标签。');
	}
	if (rawPlacements.length > 100) {
		throw new Error('placements 数量过多，单次最多允许 100 个网络标签。');
	}

	const placements = rawPlacements.map((item: unknown, index: number) =>
		normalizePlacement(item, index),
	);

	const componentApi = resolveComponentApi();
	const netFlagApi = resolveNetFlagApi();
	const netLabelApi = resolveNetLabelApi();

	const results = [];
	let successCount = 0;
	let failureCount = 0;

	for (let i = 0; i < placements.length; i += 1) {
		const placement = placements[i];

		try {
			// 获取器件的所有引脚
			const pins = await Promise.resolve(
				componentApi.getAllPinsByPrimitiveId.call(componentApi.context, placement.componentId),
			);

			if (!Array.isArray(pins) || pins.length === 0) {
				results.push({
					index: i,
					componentId: placement.componentId,
					pinIdentifier: placement.pinIdentifier,
					netName: placement.netName,
					success: false,
					error: '未找到器件引脚，请检查 componentId 是否正确。',
				});
				failureCount += 1;
				continue;
			}

			// 查找目标引脚
			const pin = findPin(pins, placement.pinIdentifier);
			if (!pin) {
				results.push({
					index: i,
					componentId: placement.componentId,
					pinIdentifier: placement.pinIdentifier,
					netName: placement.netName,
					success: false,
					error: `未找到引脚 "${placement.pinIdentifier}"，请检查引脚编号或名称。`,
				});
				failureCount += 1;
				continue;
			}

			// 检测网络类型（所有网络都使用网络符号）
			const netLabelKind = detectNetLabelKind(placement.netName);

			// 计算标签位置（加上偏移量）
			const offset = calculateLabelOffset();
			const labelX = pin.x + offset.x;
			const labelY = pin.y + offset.y;

			const result = netLabelKind === 'NetLabel'
				? await createNetLabelWithTimeout(
						Promise.resolve(netLabelApi.createNetLabel.call(
							netLabelApi.context,
							labelX,
							labelY,
							placement.netName,
						)),
						placement.netName,
					)
				: await Promise.resolve(
						netFlagApi.createNetFlag.call(
							netFlagApi.context,
							netLabelKind,
							placement.netName,
							labelX,
							labelY,
							0,
							false,
						),
					);

			if (result) {
				results.push({
					index: i,
					componentId: placement.componentId,
					pinIdentifier: placement.pinIdentifier,
					netName: placement.netName,
					success: true,
					type: netLabelKind,
					position: { x: labelX, y: labelY },
				});
				successCount += 1;
			}
			else {
				results.push({
					index: i,
					componentId: placement.componentId,
					pinIdentifier: placement.pinIdentifier,
					netName: placement.netName,
					success: false,
					error: 'API 返回空结果，创建失败。',
				});
				failureCount += 1;
			}
		}
		catch (error: unknown) {
			results.push({
				index: i,
				componentId: placement.componentId,
				pinIdentifier: placement.pinIdentifier,
				netName: placement.netName,
				success: false,
				error: toSafeErrorMessage(error),
			});
			failureCount += 1;
		}
	}

	return {
		ok: failureCount === 0,
		partial: successCount > 0 && failureCount > 0,
		successCount,
		failureCount,
		total: placements.length,
		results,
		message: `网络标签放置完成：成功 ${String(successCount)} 个，失败 ${String(failureCount)} 个。`,
	};
}
