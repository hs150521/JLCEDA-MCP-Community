import type { FootprintPrimitiveKind } from './footprint-primitive-state.ts';
import { isPlainObjectRecord } from '../utils.ts';
import { comparePcbPolygonSource } from './pcb-polygon-equivalence.ts';

// 与官方 modify 字段及 setter 顺序保持一致；未知字段仍由原生语义忽略。
const FIELDS: Record<FootprintPrimitiveKind, readonly string[]> = {
	pad: ['layer', 'padNumber', 'x', 'y', 'rotation', 'pad', 'net', 'hole', 'holeOffsetX', 'holeOffsetY', 'holeRotation', 'metallization', 'specialPad', 'solderMaskAndPasteMaskExpansion', 'heatWelding', 'primitiveLock'],
	via: ['net', 'x', 'y', 'holeDiameter', 'diameter', 'viaType', 'designRuleBlindViaName', 'solderMaskExpansion', 'primitiveLock'],
	line: ['net', 'layer', 'startX', 'startY', 'endX', 'endY', 'lineWidth', 'primitiveLock'],
	arc: ['net', 'layer', 'startX', 'startY', 'endX', 'endY', 'arcAngle', 'lineWidth', 'interactiveMode', 'primitiveLock'],
	polyline: ['net', 'layer', 'polygon', 'lineWidth', 'primitiveLock'],
	string: ['fontFamily', 'layer', 'x', 'y', 'text', 'fontSize', 'lineWidth', 'alignMode', 'rotation', 'reverse', 'expansion', 'mirror', 'primitiveLock'],
	attribute: ['layer', 'x', 'y', 'key', 'value', 'keyVisible', 'valueVisible', 'fontFamily', 'fontSize', 'lineWidth', 'alignMode', 'rotation', 'reverse', 'expansion', 'mirror', 'primitiveLock'],
};

/** 准备原生异步 DTO；返回的 done 必须在最终身份与租约核对后仅调用一次。 */
export async function prepareFootprintModification(
	runtime: Record<string, unknown>,
	api: Record<string, unknown>,
	kind: FootprintPrimitiveKind,
	primitiveId: string,
	property: unknown,
): Promise<() => unknown> {
	if (!isPlainObjectRecord(property))
		throw new TypeError('Footprint modify requires a property object.');
	const get = api.get;
	if (typeof get !== 'function')
		throw new TypeError('EDA footprint primitive get API is unavailable before modification.');
	const raw = await get.call(api, primitiveId);
	if (!raw || typeof raw !== 'object' || Array.isArray(raw))
		throw new Error(`Footprint primitive ${primitiveId} was not found; modification was not started.`);
	const primitive = raw as Record<string, unknown>;
	const getId = primitive.getState_PrimitiveId;
	const toAsync = primitive.toAsync;
	const isAsync = primitive.isAsync;
	const done = primitive.done;
	if (typeof getId !== 'function' || getId.call(primitive) !== primitiveId)
		throw new Error('EDA footprint modification target ID differs from the requested primitive.');
	if (typeof toAsync !== 'function' || typeof isAsync !== 'function' || typeof done !== 'function')
		throw new TypeError('EDA footprint primitive asynchronous mutation API is unavailable.');
	const setters = FIELDS[kind].filter(field => property[field] !== undefined).map((field) => {
		const name = `setState_${field[0].toUpperCase()}${field.slice(1)}`;
		const setter = primitive[name];
		if (typeof setter !== 'function')
			throw new TypeError(`EDA footprint ${kind} ${name} API is unavailable.`);
		return { setter, value: property[field] };
	});
	if (kind === 'via' && property.solderMaskExpansion
		&& (typeof property.solderMaskExpansion !== 'object' || Array.isArray(property.solderMaskExpansion))) {
		throw new TypeError('EDA via solderMaskExpansion must be an object or null.');
	}
	// 官方 String.modify 会先检查字体列表；使用 DTO 提交时保留此行为。
	if (kind === 'string' && property.fontFamily !== undefined) {
		const fonts = runtime.sys_FontManager as { getFontsList?: () => Promise<string[]> } | undefined;
		if (typeof fonts?.getFontsList !== 'function')
			throw new TypeError('EDA font list API is unavailable before string modification.');
		if (!(await fonts.getFontsList()).includes(property.fontFamily as string))
			throw new Error('EDA font list does not contain the requested font family.');
	}
	toAsync.call(primitive);
	if (isAsync.call(primitive) !== true)
		throw new Error('EDA footprint primitive did not enter asynchronous mode; modification was not started.');
	for (const { setter, value } of setters)
		setter.call(primitive, value);
	// 0.3.15 的 modify wrapper 未等待 done，直接提交 DTO 才能核对真实 RPC 结局。
	return () => done.call(primitive);
}

export interface FootprintFieldMismatch {
	field: string;
	requested: unknown;
	actual: unknown;
}

function matchesRequested(actual: unknown, requested: unknown, inheritMaskRule = false): boolean {
	// mask 的 null 表示继承规则；getter 回读的是有效数值，不能据此判为未应用。
	if (inheritMaskRule && requested === null)
		return true;
	if (typeof requested === 'number') {
		return typeof actual === 'number' && Number.isFinite(actual)
			&& Math.abs(actual - requested) <= 1e-6 + 1e-9 * Math.max(Math.abs(actual), Math.abs(requested));
	}
	if (Array.isArray(requested))
		return Array.isArray(actual) && actual.length === requested.length && requested.every((value, index) => matchesRequested(actual[index], value, inheritMaskRule));
	if (isPlainObjectRecord(requested)) {
		return Object.entries(requested).every(([key, value]) =>
			value === undefined || (inheritMaskRule && value === null) || (isPlainObjectRecord(actual) && matchesRequested(actual[key], value, inheritMaskRule)));
	}
	return actual === requested;
}

/** 只报告 fresh DTO 能证实的差异；已知部分应用仍允许后续写入。 */
export function compareFootprintModification(kind: FootprintPrimitiveKind, property: Record<string, unknown>, after: Record<string, unknown>): FootprintFieldMismatch[] {
	const mismatches: FootprintFieldMismatch[] = [];
	for (const field of FIELDS[kind]) {
		let requested = property[field];
		if (requested === undefined || (kind === 'pad' && field === 'holeRotation' && after.hole === null))
			continue;
		const observedField = field === 'polygon' ? 'polygonSource' : field;
		if (field === 'polygon') {
			const polygon = requested as { getSource: () => unknown };
			requested = polygon.getSource();
		}
		const actual = after[observedField];
		if (field === 'net' && (requested === '' || requested === null) && (actual === '' || actual === null))
			continue;
		const inheritMaskRule = field === 'solderMaskAndPasteMaskExpansion' || field === 'solderMaskExpansion';
		const equivalent = field === 'polygon'
			? comparePcbPolygonSource(actual, requested, 'polyline').equivalent
			: matchesRequested(actual, requested, inheritMaskRule);
		if (!equivalent)
			mismatches.push({ field: observedField, requested, actual });
	}
	return mismatches;
}
