import { isPlainObjectRecord, preserveBoundedJson } from '../utils.ts';

export type FootprintPrimitiveKind = 'pad' | 'via' | 'line' | 'arc' | 'polyline' | 'string' | 'attribute';
export const FOOTPRINT_PRIMITIVE_KINDS: readonly FootprintPrimitiveKind[] = ['pad', 'via', 'line', 'arc', 'polyline', 'string', 'attribute'];
export type FootprintPrimitiveState = Record<string, unknown> & { primitiveId: string; primitiveType: string; primitiveLock: boolean };

type FieldType = 'number' | 'nullable-number' | 'string' | 'nullable-string' | 'boolean' | 'nullable-json';
type Fields = Record<string, FieldType>;
const LOCATION: Fields = { layer: 'number', x: 'number', y: 'number', rotation: 'number' };
const LINE: Fields = { net: 'nullable-string', layer: 'number', startX: 'number', startY: 'number', endX: 'number', endY: 'number', lineWidth: 'number' };
const TEXT: Fields = { ...LOCATION, fontFamily: 'string', fontSize: 'number', lineWidth: 'number', alignMode: 'number', reverse: 'boolean', expansion: 'number', mirror: 'boolean' };
const FIELDS: Record<FootprintPrimitiveKind, Fields> = {
	pad: { ...LOCATION, padNumber: 'string', net: 'nullable-string', holeOffsetX: 'number', holeOffsetY: 'number', metallization: 'boolean', padType: 'number', solderMaskAndPasteMaskExpansion: 'nullable-json', heatWelding: 'nullable-json' },
	via: { net: 'string', x: 'number', y: 'number', holeDiameter: 'number', diameter: 'number', viaType: 'number', designRuleBlindViaName: 'nullable-string', solderMaskExpansion: 'nullable-json' },
	line: LINE,
	arc: { ...LINE, arcAngle: 'number', interactiveMode: 'number' },
	polyline: { net: 'nullable-string', layer: 'number', lineWidth: 'number' },
	string: { ...TEXT, text: 'string' },
	attribute: { ...TEXT, x: 'nullable-number', y: 'nullable-number', parentPrimitiveId: 'string', key: 'string', value: 'string', keyVisible: 'boolean', valueVisible: 'boolean' },
};
const NATIVE_TYPE: Record<FootprintPrimitiveKind, string> = { pad: 'Pad', via: 'Via', line: 'Line', arc: 'Arc', polyline: 'Polyline', string: 'String', attribute: 'Attribute' };

function getter(raw: unknown, name: string): unknown {
	if (!isPlainObjectRecord(raw) || typeof raw[name] !== 'function')
		throw new TypeError(`EDA footprint getter ${name} is unavailable.`);
	return raw[name]();
}

/** 只复制原生 JSON 状态；遇到无法完整表示的值就失败，不用占位符代替几何。 */
function cloneJson(value: unknown, depth = 0, budget = { nodes: 0 }): unknown {
	if (++budget.nodes > 100000 || depth > 8)
		throw new RangeError('EDA footprint primitive state exceeds the complete readback budget.');
	if (value === null || typeof value === 'string' || typeof value === 'boolean')
		return value;
	if (typeof value === 'number' && Number.isFinite(value))
		return value;
	if (Array.isArray(value))
		return value.map(item => cloneJson(item, depth + 1, budget));
	if (isPlainObjectRecord(value)) {
		const result: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			// 官方参数对象的可选字段允许 undefined；JSON 中直接省略该字段。
			if (item !== undefined)
				result[key] = cloneJson(item, depth + 1, budget);
		}
		return result;
	}
	throw new TypeError('EDA footprint primitive state contains a non-JSON value.');
}

function fieldValue(raw: unknown, field: string, type: FieldType): unknown {
	const value = getter(raw, `getState_${field[0].toUpperCase()}${field.slice(1)}`);
	if (type === 'nullable-string' && (value === undefined || value === null))
		return null;
	if (type === 'nullable-number' && value === null)
		return null;
	if (type === 'nullable-json') {
		if (value === null)
			return null;
		if (isPlainObjectRecord(value))
			return cloneJson(value);
	}
	else if ((type === 'number' || type === 'nullable-number') && typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}
	else if ((type === 'string' || type === 'nullable-string') && typeof value === 'string') {
		return value;
	}
	else if (type === 'boolean' && typeof value === 'boolean') {
		return value;
	}
	throw new TypeError(`EDA footprint ${field} is not readable.`);
}

function arrayState(raw: unknown, method: string, optional: boolean, allowUndefined = false, allowEmpty = false): unknown[] | null {
	const value = getter(raw, method);
	if (optional && (value === null || (allowUndefined && value === undefined)))
		return null;
	if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
		const actual = Array.isArray(value) ? `array length ${String(value.length)}` : value === null ? 'null' : typeof value;
		throw new TypeError(`EDA footprint ${method} geometry is not readable (received ${actual}).`);
	}
	return cloneJson(value) as unknown[];
}

/** 完整读取封装图元同步状态，供 footprint_read 和限定封装的 api_invoke 共用。 */
export function readFootprintPrimitiveState(raw: unknown, kind: FootprintPrimitiveKind): FootprintPrimitiveState {
	const primitiveId = getter(raw, 'getState_PrimitiveId');
	const primitiveType = getter(raw, 'getState_PrimitiveType');
	const primitiveLock = getter(raw, 'getState_PrimitiveLock');
	if (typeof primitiveId !== 'string' || !primitiveId.trim() || primitiveType !== NATIVE_TYPE[kind] || typeof primitiveLock !== 'boolean')
		throw new TypeError(`EDA footprint ${kind} identity/type/lock is not readable.`);
	const result: FootprintPrimitiveState = { primitiveId, primitiveType, primitiveLock };
	if (kind === 'pad')
		result.hole = arrayState(raw, 'getState_Hole', true);
	for (const [field, type] of Object.entries(FIELDS[kind]))
		result[field] = fieldValue(raw, field, type);
	if (kind === 'pad') {
		result.pad = arrayState(raw, 'getState_Pad', true, true);
		const holeRotation = getter(raw, 'getState_HoleRotation');
		// 无孔 SMD 的原生旋转可能是 NaN：该字段不适用，完整 DTO 明确表示为 null。
		if (result.hole === null && (holeRotation === null || holeRotation === undefined || (typeof holeRotation === 'number' && Number.isNaN(holeRotation)))) {
			result.holeRotation = null;
		}
		else if (typeof holeRotation === 'number' && Number.isFinite(holeRotation)) {
			result.holeRotation = holeRotation;
		}
		else {
			const actualType = holeRotation === null ? 'null' : typeof holeRotation;
			const actualValue = typeof holeRotation === 'number'
				? ` ${String(holeRotation)}`
				: typeof holeRotation === 'string'
					? ` ${JSON.stringify(holeRotation.slice(0, 64))}`
					: '';
			throw new TypeError(`EDA footprint holeRotation is not readable (received ${actualType}${actualValue}).`);
		}
		result.specialPad = arrayState(raw, 'getState_SpecialPad', true, true, true);
		if (result.pad === null && (result.specialPad === null || (Array.isArray(result.specialPad) && result.specialPad.length === 0)))
			throw new TypeError('EDA footprint pad shape is unavailable.');
	}
	if (kind === 'polyline') {
		const polygon = getter(raw, 'getState_Polygon');
		const source = arrayState(polygon, 'getSource', false)!;
		if (source.some(item => typeof item !== 'number' && !['L', 'ARC', 'CARC', 'C', 'R', 'CIRCLE'].includes(item as string)))
			throw new TypeError('EDA footprint polygon source is not an official source array.');
		result.polygonSource = source;
	}
	if (kind === 'pad' && ![0, 1, 2].includes(result.padType as number))
		throw new TypeError('EDA footprint padType is not a supported official enum.');
	if (kind === 'via' && ![0, 1, 2].includes(result.viaType as number))
		throw new TypeError('EDA footprint viaType is not a supported official enum.');
	if (kind === 'arc' && ![1, 2].includes(result.interactiveMode as number))
		throw new TypeError('EDA footprint interactiveMode is not a supported official enum.');
	if ((kind === 'string' || kind === 'attribute') && (!Number.isInteger(result.alignMode) || Number(result.alignMode) < 1 || Number(result.alignMode) > 9))
		throw new TypeError('EDA footprint alignMode is not a supported official enum.');
	if (kind === 'attribute' && !(result.parentPrimitiveId as string).trim())
		throw new TypeError('EDA footprint attribute parent ID is unavailable.');
	return preserveBoundedJson(result);
}
