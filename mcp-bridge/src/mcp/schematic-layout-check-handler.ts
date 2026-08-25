/* eslint-disable style/max-statements-per-line -- compact EDA state sampling keeps related reads together. */

import { getEdaRuntime, getSyncState, isPlainObjectRecord, toSerializableAsync } from '../utils.ts';

interface Rect { left: number; right: number; top: number; bottom: number }
type PrimitiveKind = 'symbol' | 'pin' | 'attribute' | 'wire';
interface LayoutPrimitive { id: string; kind: PrimitiveKind; text?: string; designator?: string; x: number; y: number; rect: Rect; rotation: number; parentId?: string; pageKey: string; pageKnown: boolean; endpoints?: Array<{ x: number; y: number }> }

const DEFAULT_FONT_SIZE = 50;
const DEFAULT_SYMBOL_WIDTH = 400;
const DEFAULT_SYMBOL_HEIGHT = 300;
const MAX_PRIMITIVES = 1200;
const MAX_COLLISIONS = 5000;

function num(value: unknown, fallback = 0): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function text(value: unknown): string {
	return typeof value === 'string' ? value.trim() : String(value ?? '').trim();
}

function rectAround(x: number, y: number, width: number, height: number, rotation = 0): Rect {
	const turns = Math.abs(Math.round(rotation / 90)) % 2;
	const w = turns === 1 ? height : width;
	const h = turns === 1 ? width : height;
	return { left: x - w / 2, right: x + w / 2, top: y + h / 2, bottom: y - h / 2 };
}

function overlap(a: Rect, b: Rect): boolean {
	return a.left < b.right && a.right > b.left && a.bottom < b.top && a.top > b.bottom;
}

function intersectionArea(a: Rect, b: Rect): number {
	if (!overlap(a, b))
		return 0;
	return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.top, b.top) - Math.max(a.bottom, b.bottom));
}

function severity(kindA: PrimitiveKind, kindB: PrimitiveKind, area: number): 'error' | 'warning' | 'info' {
	if (kindA === 'pin' || kindB === 'pin')
		return 'error';
	if (kindA === 'symbol' && kindB === 'symbol')
		return area > 0 ? 'error' : 'warning';
	if (kindA === 'wire' || kindB === 'wire')
		return 'warning';
	return 'warning';
}

function primitiveId(value: unknown, fallback: string): string {
	return text(getSyncState(value, 'getState_PrimitiveId', fallback)) || fallback;
}

function rawState(value: unknown, method: string): unknown {
	try {
		const getter = (value as Record<string, unknown>)?.[method];
		return typeof getter === 'function' ? (getter as () => unknown).call(value) : undefined;
	}
	catch {
		return undefined;
	}
}

function pageKey(value: unknown, fallback: string): string {
	for (const method of ['getState_SchematicPageUuid', 'getState_PageUuid']) {
		const candidate = text(getSyncState(value, method, ''));
		if (candidate.length > 0)
			return candidate;
	}
	return fallback;
}

function attributeText(attribute: unknown): string {
	const key = text(getSyncState(attribute, 'getState_Key', ''));
	const value = text(getSyncState(attribute, 'getState_Value', ''));
	return key && value ? `${key}: ${value}` : (value || key);
}

function attributeVisible(attribute: unknown): boolean {
	const keyVisible: unknown = getSyncState<unknown>(attribute, 'getState_KeyVisible', true);
	const valueVisible: unknown = getSyncState<unknown>(attribute, 'getState_ValueVisible', true);
	return keyVisible !== false || valueVisible !== false;
}

function normalizePageBounds(input: Record<string, unknown>): Rect | undefined {
	const raw = input.pageBounds;
	if (!isPlainObjectRecord(raw))
		return undefined;
	const left = num(raw.left, Number.NaN); const right = num(raw.right, Number.NaN); const top = num(raw.top, Number.NaN); const bottom = num(raw.bottom, Number.NaN);
	return [left, right, top, bottom].every(Number.isFinite) && left <= right && bottom <= top ? { left, right, top, bottom } : undefined;
}

function lineGeometry(line: unknown): { rect: Rect; endpoints: Array<{ x: number; y: number }> } | undefined {
	if (!Array.isArray(line) || line.length < 4)
		return undefined;
	const points: number[][] = Array.isArray(line[0]) ? line as number[][] : [];
	const flat = points.length ? points.flat() : line as number[];
	const xs: number[] = []; const ys: number[] = [];
	for (let i = 0; i + 1 < flat.length; i += 2) { if (Number.isFinite(flat[i]) && Number.isFinite(flat[i + 1])) { xs.push(flat[i]); ys.push(flat[i + 1]); } }
	if (!xs.length)
		return undefined;
	const endpoints = points.length > 0 && points.every(point => point.length >= 4)
		? [{ x: points[0][0], y: points[0][1] }, { x: points[points.length - 1][points[points.length - 1].length - 2], y: points[points.length - 1][points[points.length - 1].length - 1] }]
		: points.length >= 2
			? [{ x: points[0][0], y: points[0][1] }, { x: points[points.length - 1][0], y: points[points.length - 1][1] }]
			: [{ x: flat[0], y: flat[1] }, { x: flat[flat.length - 2], y: flat[flat.length - 1] }];
	return { rect: { left: Math.min(...xs) - 4, right: Math.max(...xs) + 4, bottom: Math.min(...ys) - 4, top: Math.max(...ys) + 4 }, endpoints };
}

function rectCopy(rect: Rect): Rect {
	return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
}

function endpointTouchesRect(endpoints: Array<{ x: number; y: number }> | undefined, rect: Rect): boolean {
	return endpoints?.some(endpoint => endpoint.x >= rect.left - 8 && endpoint.x <= rect.right + 8 && endpoint.y >= rect.bottom - 8 && endpoint.y <= rect.top + 8) === true;
}

export async function handleSchematicLayoutCheckTask(payload: unknown): Promise<unknown> {
	if (payload !== undefined && payload !== null && !isPlainObjectRecord(payload))
		throw new TypeError('schematic_layout_check payload must be an object.');
	const input = isPlainObjectRecord(payload) ? payload : {};
	const includeAllPages = input.allPages === true;
	const mode = input.mode === undefined ? 'check' : input.mode;
	if (mode !== 'check' && mode !== 'fix')
		throw new TypeError('mode must be check or fix.');
	if (mode === 'fix' && input.confirm !== true)
		throw new Error('mode=fix requires confirm=true.');
	const threshold = input.denseThreshold === undefined ? 5 : input.denseThreshold;
	if (typeof threshold !== 'number' || !Number.isInteger(threshold) || threshold < 2 || threshold > 50)
		throw new RangeError('denseThreshold must be an integer between 2 and 50.');

	const eda = getEdaRuntime();
	if (!eda)
		throw new Error('EDA runtime is unavailable.');
	const componentApi = eda.sch_PrimitiveComponent as Record<string, unknown> | undefined;
	const attributeApi = eda.sch_PrimitiveAttribute as Record<string, unknown> | undefined;
	const wireApi = eda.sch_PrimitiveWire as Record<string, unknown> | undefined;
	if (!isPlainObjectRecord(componentApi) || typeof componentApi.getAll !== 'function')
		throw new Error('EDA sch_PrimitiveComponent.getAll API is unavailable.');
	const currentPage = isPlainObjectRecord(eda.dmt_Schematic) && typeof eda.dmt_Schematic.getCurrentSchematicPageInfo === 'function'
		? await (eda.dmt_Schematic.getCurrentSchematicPageInfo as () => Promise<unknown>)()
		: undefined;
	const currentPageKey = text(isPlainObjectRecord(currentPage) ? currentPage.uuid : '') || 'current-page';
	let pageGroupingAvailable = !includeAllPages;

	const rawComponents = await (componentApi.getAll as (type?: unknown, all?: boolean) => Promise<unknown[]>).call(componentApi, undefined, includeAllPages);
	const allComponents = Array.isArray(rawComponents) ? rawComponents : [];
	const components = allComponents.slice(0, MAX_PRIMITIVES);
	const primitives: LayoutPrimitive[] = [];
	let primitivesTruncated = allComponents.length > MAX_PRIMITIVES;
	const pinsCapability = typeof componentApi.getAllPinsByPrimitiveId === 'function';
	for (let index = 0; index < components.length; index += 1) {
		if (primitives.length >= MAX_PRIMITIVES) {
			primitivesTruncated = true;
			break;
		}
		const component = components[index]; const id = primitiveId(component, `component-${index}`);
		const explicitComponentPageKey = pageKey(component, '');
		if (includeAllPages && explicitComponentPageKey.length > 0)
			pageGroupingAvailable = true;
		const componentPageKnown = !includeAllPages || explicitComponentPageKey.length > 0;
		const componentPageKey = explicitComponentPageKey || (includeAllPages ? 'unknown-all-pages' : currentPageKey);
		const x = num(getSyncState(component, 'getState_X', 0)); const y = num(getSyncState(component, 'getState_Y', 0));
		const rotation = num(getSyncState(component, 'getState_Rotation', 0)); const designator = text(getSyncState(component, 'getState_Designator', ''));
		let width = DEFAULT_SYMBOL_WIDTH; let height = DEFAULT_SYMBOL_HEIGHT;
		let pins: unknown[] = [];
		if (pinsCapability) {
			const rawPins = await (componentApi.getAllPinsByPrimitiveId as (id: string) => Promise<unknown[]>).call(componentApi, id);
			pins = Array.isArray(rawPins) ? rawPins : [];
			if (pins.length) {
				const xs = pins.map(pin => num(getSyncState(pin, 'getState_X', x))); const ys = pins.map(pin => num(getSyncState(pin, 'getState_Y', y)));
				width = Math.max(width, Math.max(...xs) - Math.min(...xs) + 120); height = Math.max(height, Math.max(...ys) - Math.min(...ys) + 120);
			}
		}
		primitives.push({ id, kind: 'symbol', designator, x, y, rotation, rect: rectAround(x, y, width, height, rotation), pageKey: componentPageKey, pageKnown: componentPageKnown });
		for (let pinIndex = 0; pinIndex < pins.length; pinIndex += 1) {
			if (primitives.length >= MAX_PRIMITIVES) {
				primitivesTruncated = true;
				break;
			}
			const pin = pins[pinIndex]; const px = num(getSyncState(pin, 'getState_X', x)); const py = num(getSyncState(pin, 'getState_Y', y));
			const explicitPinPageKey = pageKey(pin, '');
			primitives.push({ id: `${id}:pin:${text(getSyncState(pin, 'getState_PinNumber', pinIndex + 1))}`, kind: 'pin', x: px, y: py, rotation: num(getSyncState(pin, 'getState_Rotation', rotation)), rect: rectAround(px, py, 45, 45), parentId: id, pageKey: explicitPinPageKey || componentPageKey, pageKnown: componentPageKnown && (!includeAllPages || explicitPinPageKey.length > 0 || componentPageKnown) });
		}
	}

	let attributeCapability = false; let rawAttributes: unknown[] = []; let allAttributes: unknown[] = []; let attributesMissingGeometry = 0;
	if (isPlainObjectRecord(attributeApi) && typeof attributeApi.getAll === 'function') {
		attributeCapability = true;
		const result = await (attributeApi.getAll as () => Promise<unknown[]>).call(attributeApi);
		allAttributes = Array.isArray(result) ? result : [];
		rawAttributes = allAttributes.slice(0, MAX_PRIMITIVES);
		primitivesTruncated ||= allAttributes.length > MAX_PRIMITIVES;
		for (let index = 0; index < rawAttributes.length; index += 1) {
			if (primitives.length >= MAX_PRIMITIVES) {
				primitivesTruncated = true;
				break;
			}
			const attribute = rawAttributes[index]; if (!attributeVisible(attribute))
				continue;
			const id = primitiveId(attribute, `attribute-${index}`); const value = attributeText(attribute); if (!value)
				continue;
			const xRaw = rawState(attribute, 'getState_X'); const yRaw = rawState(attribute, 'getState_Y');
			if (typeof xRaw !== 'number' || !Number.isFinite(xRaw) || typeof yRaw !== 'number' || !Number.isFinite(yRaw)) {
				attributesMissingGeometry += 1;
				continue;
			}
			const x = xRaw as number; const y = yRaw as number; const rotation = num(getSyncState(attribute, 'getState_Rotation', 0)); const fontSize = Math.max(1, num(getSyncState(attribute, 'getState_FontSize', DEFAULT_FONT_SIZE), DEFAULT_FONT_SIZE));
			const parentId = text(getSyncState(attribute, 'getState_ParentPrimitiveId', ''));
			primitives.push({ id, kind: 'attribute', text: value, x, y, rotation, parentId, rect: rectAround(x, y, Math.max(fontSize * 0.6, value.length * fontSize * 0.6), fontSize * 1.3, rotation), pageKey: pageKey(attribute, currentPageKey), pageKnown: true });
		}
	}

	let wireCapability = false; let wires: unknown[] = [];
	if (isPlainObjectRecord(wireApi) && typeof wireApi.getAll === 'function') {
		wireCapability = true; const allWires = await (wireApi.getAll as () => Promise<unknown[]>).call(wireApi); wires = Array.isArray(allWires) ? allWires : [];
		primitivesTruncated ||= wires.length > MAX_PRIMITIVES;
		if (Array.isArray(wires)) {
			for (const [index, wire] of wires.slice(0, MAX_PRIMITIVES).entries()) {
				if (primitives.length >= MAX_PRIMITIVES) {
					primitivesTruncated = true;
					break;
				}
				const geometry = lineGeometry(getSyncState(wire, 'getState_Line', null)); if (geometry)
					primitives.push({ id: primitiveId(wire, `wire-${index}`), kind: 'wire', x: (geometry.rect.left + geometry.rect.right) / 2, y: (geometry.rect.bottom + geometry.rect.top) / 2, rotation: 0, rect: geometry.rect, endpoints: geometry.endpoints, pageKey: currentPageKey, pageKnown: true });
			}
		}
	}

	const collisions: Record<string, unknown>[] = [];
	let collisionTotal = 0;
	for (let i = 0; i < primitives.length; i += 1) {
		for (let j = i + 1; j < primitives.length; j += 1) {
			const a = primitives[i]; const b = primitives[j]; if (!a.pageKnown || !b.pageKnown || a.pageKey !== b.pageKey)
				continue;
			if ((a.parentId && a.parentId === b.id) || (b.parentId && b.parentId === a.id))
				continue;
			if ((a.kind === 'wire' && b.kind === 'pin' && endpointTouchesRect(a.endpoints, b.rect)) || (b.kind === 'wire' && a.kind === 'pin' && endpointTouchesRect(b.endpoints, a.rect)))
				continue;
			const area = intersectionArea(a.rect, b.rect); if (!area)
				continue;
			const type = a.kind === 'attribute' && b.kind === 'attribute' ? 'text-text' : a.kind === 'attribute' || b.kind === 'attribute' ? (a.kind === 'pin' || b.kind === 'pin' ? 'text-pin' : a.kind === 'wire' || b.kind === 'wire' ? 'label-wire' : 'text-symbol') : a.kind === 'symbol' && b.kind === 'symbol' ? 'symbol-symbol' : 'primitive-overlap';
			collisionTotal += 1;
			if (collisions.length < MAX_COLLISIONS)
				collisions.push({ pageKey: a.pageKey, primitiveIds: [a.id, b.id], collisionType: type, severity: severity(a.kind, b.kind, area), area, primitives: [{ id: a.id, kind: a.kind, x: a.x, y: a.y, rect: rectCopy(a.rect), text: a.text, designator: a.designator }, { id: b.id, kind: b.kind, x: b.x, y: b.y, rect: rectCopy(b.rect), text: b.text, designator: b.designator }] });
		}
	}

	const denseRegions: Record<string, unknown>[] = []; const cells = new Map<string, LayoutPrimitive[]>(); const cellSize = 1000;
	for (const primitive of primitives) {
		if (!primitive.pageKnown)
			continue;
		const key = `${primitive.pageKey}:${Math.floor(primitive.x / cellSize)},${Math.floor(primitive.y / cellSize)}`; const list = cells.get(key) ?? []; list.push(primitive); cells.set(key, list);
	}
	for (const [key, list] of cells) {
		if (list.length >= threshold)
			denseRegions.push({ cell: key, count: list.length, primitiveIds: list.slice(0, 100).map(item => item.id) });
	}

	const pageBounds = normalizePageBounds(input);
	const outOfBounds = pageBounds ? primitives.filter(item => item.pageKey === currentPageKey && (item.rect.left < pageBounds.left || item.rect.right > pageBounds.right || item.rect.bottom < pageBounds.bottom || item.rect.top > pageBounds.top)).map(item => ({ primitiveId: item.id, kind: item.kind, pageKey: item.pageKey, rect: rectCopy(item.rect) })) : [];
	const fixByAttribute = new Map<string, Record<string, unknown>>();
	for (const item of collisions.filter(item => item.collisionType === 'text-text' || item.collisionType === 'text-symbol').slice(0, 100)) {
		const ids = item.primitiveIds as string[];
		const target = primitives.find(p => ids.includes(p.id) && p.kind === 'attribute');
		if (target && !fixByAttribute.has(target.id))
			fixByAttribute.set(target.id, { primitiveId: target.id, action: 'move_attribute', suggestedX: target.x + 120, suggestedY: target.y + 120, reason: item.collisionType });
	}
	const suggestedFixes = Array.from(fixByAttribute.values());
	const appliedFixes: unknown[] = [];
	const skippedFixes: Array<Record<string, unknown>> = [];
	if (mode === 'fix' && isPlainObjectRecord(attributeApi) && typeof attributeApi.modify === 'function') {
		for (const fix of suggestedFixes) {
			const item = fix as Record<string, unknown>;
			const target = primitives.find(primitive => primitive.id === item.primitiveId && primitive.kind === 'attribute');
			if (!target) {
				skippedFixes.push({ ...item, reason: 'attribute_geometry_unavailable' });
				continue;
			}
			const dx = Number(item.suggestedX) - target.x;
			const dy = Number(item.suggestedY) - target.y;
			const proposedRect: Rect = { left: target.rect.left + dx, right: target.rect.right + dx, top: target.rect.top + dy, bottom: target.rect.bottom + dy };
			const outsidePage = pageBounds && (proposedRect.left < pageBounds.left || proposedRect.right > pageBounds.right || proposedRect.bottom < pageBounds.bottom || proposedRect.top > pageBounds.top);
			const createsCollision = primitives.some((other) => {
				if (other.id === target.id || (target.parentId && other.id === target.parentId) || (other.parentId && other.parentId === target.id) || !other.pageKnown || !target.pageKnown || other.pageKey !== target.pageKey)
					return false;
				if ((other.kind === 'wire' && target.kind === 'pin' && endpointTouchesRect(other.endpoints, proposedRect)) || (target.kind === 'wire' && other.kind === 'pin' && endpointTouchesRect(target.endpoints, other.rect)))
					return false;
				return intersectionArea(proposedRect, other.rect) > 0;
			});
			if (outsidePage || createsCollision) {
				skippedFixes.push({ ...item, reason: outsidePage ? 'outside_page_bounds' : 'destination_collision' });
				continue;
			}
			try {
				const updated = await (attributeApi.modify as (id: string, property: Record<string, number>) => Promise<unknown>).call(attributeApi, String(item.primitiveId), { x: Number(item.suggestedX), y: Number(item.suggestedY) });
				if (updated !== undefined && updated !== null)
					appliedFixes.push(item);
				else
					skippedFixes.push({ ...item, reason: 'attribute_modify_unavailable' });
			}
			catch {
				skippedFixes.push({ ...item, reason: 'attribute_modify_failed' });
			}
		}
	}

	return await toSerializableAsync({ ok: true, mode, confirmed: mode === 'fix', page: currentPage, capabilities: { components: true, pins: pinsCapability, attributes: attributeCapability, attributesGeometry: attributeCapability && attributesMissingGeometry === 0, wires: wireCapability, pageBounds: Boolean(pageBounds), pageBoundsSource: pageBounds ? 'request.pageBounds' : 'unavailable_in_current_api', pageGrouping: pageGroupingAvailable ? 'structured' : 'unknown-single-group' }, counts: { components: allComponents.length, componentsAnalyzed: components.length, attributes: allAttributes.length, attributesAnalyzed: rawAttributes.length, attributesMissingGeometry, wires: wires.length, primitives: primitives.length, primitiveLimit: MAX_PRIMITIVES, truncated: primitivesTruncated, collisionTotal, collisionLimit: MAX_COLLISIONS, collisionsTruncated: collisionTotal > MAX_COLLISIONS, collisions: collisions.length, outOfBounds: outOfBounds.length, denseRegions: denseRegions.length }, collisions, outOfBounds, denseRegions, suggestedFixes, appliedFixes, skippedFixes });
}
