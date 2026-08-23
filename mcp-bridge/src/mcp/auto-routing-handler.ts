/**
 * ------------------------------------------------------------------------
 * 名称：自动布线任务处理
 * 说明：调用 EDA 的 autoRouting BETA API 实现原理图导线自动布线
 * 作者：Lion
 * 邮箱：chengbin@3578.cn
 * 日期：2026-07-02
 * 备注：封装 eda.sch_Document.autoRouting API
 * ------------------------------------------------------------------------
 */

import { getEdaRuntime, isPlainObjectRecord, toSafeErrorMessage } from '../utils';

interface AutoRoutingProps {
	uuids?: string[];
	netlist?: {
		component: {
			[uniqueId: string]: {
				pinInfoMap: {
					[key: string]: {
						name: string;
						number: string;
						net: string;
						props: {
							'Pin Number': string;
						};
					};
				};
			};
		};
	};
	designatorDeviceTypeMap?: {
		[designator: string]: 'resistor' | 'capacitor' | 'inductive' | 'diode' | 'triode' | 'oscillator' | 'chip' | 'otherDevice';
	};
}

type AutoRoutingDeviceType = NonNullable<AutoRoutingProps['designatorDeviceTypeMap']>[string];

interface SchDocumentApi {
	context: unknown;
	autoRouting: (props?: AutoRoutingProps) => Promise<unknown>;
}

/**
 * 解析 EDA 的 sch_Document API。
 * @returns sch_Document API 对象。
 */
function resolveSchDocumentApi(): SchDocumentApi {
	const edaGlobal = getEdaRuntime();
	if (!edaGlobal || typeof edaGlobal !== 'object') {
		throw new Error('EDA 环境未就绪，无法访问 eda 全局对象。');
	}

	const schDocModule = (edaGlobal as { sch_Document?: unknown }).sch_Document;
	if (!isPlainObjectRecord(schDocModule) || typeof schDocModule.autoRouting !== 'function') {
		throw new Error('未找到 eda.sch_Document.autoRouting API。此功能需要 EDA 支持 BETA 功能，请确保使用最新版本的嘉立创 EDA 专业版。');
	}

	return {
		context: schDocModule,
		autoRouting: schDocModule.autoRouting as (props?: AutoRoutingProps) => Promise<unknown>,
	};
}

/**
 * 验证并规范化 uuids 参数。
 * @param raw 原始 uuids 数据。
 * @returns 规范化后的 uuids 数组或 undefined。
 */
function normalizeUuids(raw: unknown): string[] | undefined {
	if (raw === undefined || raw === null) {
		return undefined;
	}

	if (!Array.isArray(raw)) {
		throw new TypeError('uuids 必须为数组。');
	}

	if (raw.length === 0) {
		throw new Error('uuids 不能是空数组。若要对整张图执行自动布线，请省略 uuids 参数。');
	}

	const result: string[] = [];
	for (let i = 0; i < raw.length; i += 1) {
		const uuid = String(raw[i] ?? '').trim();
		if (uuid.length === 0) {
			throw new Error(`uuids[${String(i)}] 不能为空字符串。`);
		}
		result.push(uuid);
	}

	return result;
}

/**
 * 验证器件类型映射。
 * @param raw 原始 designatorDeviceTypeMap 数据。
 * @returns 规范化后的器件类型映射或 undefined。
 */
function normalizeDesignatorDeviceTypeMap(raw: unknown): AutoRoutingProps['designatorDeviceTypeMap'] | undefined {
	if (raw === undefined || raw === null) {
		return undefined;
	}

	if (!isPlainObjectRecord(raw)) {
		throw new TypeError('designatorDeviceTypeMap 必须为对象。');
	}

	const validTypes = new Set<AutoRoutingDeviceType>(['resistor', 'capacitor', 'inductive', 'diode', 'triode', 'oscillator', 'chip', 'otherDevice']);
	const result: NonNullable<AutoRoutingProps['designatorDeviceTypeMap']> = {};

	for (const key in raw) {
		if (Object.prototype.hasOwnProperty.call(raw, key)) {
			const value = String(raw[key] ?? '').trim();
			if (!validTypes.has(value as AutoRoutingDeviceType)) {
				throw new Error(`designatorDeviceTypeMap["${key}"] 的值 "${value}" 不是有效的器件类型。有效类型：resistor, capacitor, inductive, diode, triode, oscillator, chip, otherDevice。`);
			}
			result[key] = value as AutoRoutingDeviceType;
		}
	}

	return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * 处理自动布线任务。
 * @param payload 任务参数。
 * @returns 自动布线结果。
 */
export async function handleAutoRoutingTask(payload: unknown): Promise<unknown> {
	try {
		const schDocApi = resolveSchDocumentApi();

		let props: AutoRoutingProps | undefined;

		if (payload !== null && payload !== undefined) {
			if (!isPlainObjectRecord(payload)) {
				throw new TypeError('auto/routing 任务参数必须为对象。');
			}

			const uuids = normalizeUuids(payload.uuids);
			const designatorDeviceTypeMap = normalizeDesignatorDeviceTypeMap(payload.designatorDeviceTypeMap);
			const netlist = payload.netlist as AutoRoutingProps['netlist'] | undefined;

			// 仅在有参数时构建 props 对象
			if (uuids || designatorDeviceTypeMap || netlist) {
				props = {
					uuids,
					netlist,
					designatorDeviceTypeMap,
				};
			}
		}

		const result = await Promise.resolve(schDocApi.autoRouting.call(schDocApi.context, props));

		return {
			ok: result !== false,
			result,
			message: props?.uuids
				? `已对 ${String(props.uuids.length)} 个指定网络执行自动布线。`
				: '已对所有未布线的网络执行自动布线。',
		};
	}
	catch (error: unknown) {
		return {
			ok: false,
			error: toSafeErrorMessage(error),
			errorCode: 'AUTO_ROUTING_FAILED',
		};
	}
}
