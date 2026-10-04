const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');

const { handlePcbBoardOutlineManageTask } = require('../src/mcp/pcb-board-outline-manage-handler.ts');
const { comparePcbPolygonSource } = require('../src/mcp/pcb-polygon-equivalence.ts');
const { requiresHostRestartForResult } = require('../src/runtime/task-timeout.ts');
const { toSerializableAsync } = require('../src/utils.ts');

const path = '/bridge/jlceda/pcb/board-outline-manage';
const source = [0, 0, 'L', 100, 0, 100, 100];
const items = { line: new Map(), arc: new Map(), polyline: new Map() };
const queryLayers = [];
let page = 'pcb-1';
let serial = 1;
let writes = 0;
let layerLocked = false;

function state(kind, primitiveId, patch = {}) {
	const common = { primitiveId, net: '', layer: 11, lineWidth: 0.2, primitiveLock: false };
	if (kind === 'polyline')
		return { ...common, polygonSource: source, ...patch };
	const segment = { ...common, startX: 0, startY: 0, endX: 100, endY: 0 };
	return kind === 'arc' ? { ...segment, arcAngle: 90, interactiveMode: 1, ...patch } : { ...segment, ...patch };
}

function primitive(value) {
	const getters = {};
	for (const [field, item] of Object.entries(value))
		getters[`getState_${field.charAt(0).toUpperCase()}${field.slice(1)}`] = () => item;
	getters.getState_Polygon = () => ({ getSource: () => value.polygonSource });
	return getters;
}

function api(kind) {
	return {
		async getAll(_net, layer) {
			queryLayers.push(layer);
			return [...items[kind].values()].filter(item => layer === undefined || item.layer === layer).map(primitive);
		},
		async get(id) { return items[kind].has(id) ? primitive(items[kind].get(id)) : undefined; },
		async create(...args) {
			writes += 1;
			const id = `${kind}-${serial++}`;
			const [net, layer] = args;
			let patch;
			if (kind === 'polyline') {
				const [, , polygon, lineWidth, primitiveLock] = args;
				patch = { net, layer, polygonSource: polygon.getSource(), lineWidth: lineWidth ?? 0.2, primitiveLock: primitiveLock ?? false };
			}
			else {
				const [, , startX, startY, endX, endY, next] = args;
				patch = { net, layer, startX, startY, endX, endY };
				if (kind === 'arc') {
					const [, , , , , , arcAngle, lineWidth, interactiveMode, primitiveLock] = args;
					Object.assign(patch, { arcAngle, lineWidth: lineWidth ?? 0.2, interactiveMode: interactiveMode ?? 1, primitiveLock: primitiveLock ?? false });
				}
				else {
					Object.assign(patch, { lineWidth: next ?? 0.2, primitiveLock: args[7] ?? false });
				}
			}
			const value = state(kind, id, patch);
			items[kind].set(id, value);
			return primitive(value);
		},
		async modify(id, patch) {
			writes += 1;
			const next = { ...patch };
			if (next.polygon) {
				next.polygonSource = next.polygon.getSource();
				delete next.polygon;
			}
			Object.assign(items[kind].get(id), next);
			return primitive(items[kind].get(id));
		},
		async delete(id) {
			writes += 1;
			return items[kind].delete(id);
		},
	};
}

async function main() {
	const curve = [0, 0, 'L', 10, 0, 'ARC', 90, 10, 10, 'C', 6, 12, 0, 6, 0, 0];
	const reversedCurve = [0, 0, 'C', 0, 6, 6, 12, 10, 10, 'ARC', -90, 10, 0, 'L', 0, 0];
	assert.equal(comparePcbPolygonSource(reversedCurve, curve).equivalent, true, 'reverse winding also reverses arc angle and cubic controls');
	assert.equal(comparePcbPolygonSource(reversedCurve, curve).reversed, true);
	assert.equal(comparePcbPolygonSource([10, 0, 'ARC', 90, 10, 10, 'C', 6, 12, 0, 6, 0, 0, 'L', 10, 0], curve).equivalent, true, 'mixed contours may change their start edge');
	const wrongArc = [...reversedCurve];
	wrongArc[10] = 90;
	assert.equal(comparePcbPolygonSource(wrongArc, curve).equivalent, false, 'reversed endpoints with an unchanged arc angle describe another arc');
	const wrongControls = [...reversedCurve];
	wrongControls.splice(3, 4, 6, 12, 0, 6);
	assert.equal(comparePcbPolygonSource(wrongControls, curve).equivalent, false, 'reversing only curve endpoints changes the Bezier path');
	assert.equal(comparePcbPolygonSource([0, 0, 'L', 10, 0, 10, 10, 0, 0], curve).equivalent, false, 'matching vertices do not allow replacing curves with straight edges');
	assert.equal(comparePcbPolygonSource([0, 0, 'CARC', 90, 10, 10, 'L', 0, 0], [0, 0, 'ARC', 90, 10, 10, 'L', 0, 0]).equivalent, false, 'retain native arc command semantics');
	assert.equal(comparePcbPolygonSource([0, 0, 'L', 10, 0, 10, 10, 0, 0], [0, 0, 'L', 10, 0, 10, 10]).equivalent, true, 'native Polygon closes the last edge automatically');
	assert.equal(comparePcbPolygonSource([0, 0, 'L', 10, 0, 10, 10, 0, 0], [0, 0, 'L', 10, 0, 10, 10], 'polyline').equivalent, false, 'a polyline closing edge changes an open path');
	assert.equal(comparePcbPolygonSource(['R', 0, 0, 10, 10, 0.00005, 0], ['R', 0, 0, 10, 10, 0, 0]).equivalent, false, 'coordinate precision must not weaken angular verification');
	assert.equal(comparePcbPolygonSource(['CIRCLE', 1.2346, 5.6789, 10], ['CIRCLE', 1.23456, 5.67891, 10]).equivalent, true);
	assert.equal(comparePcbPolygonSource(['CIRCLE', 0, 0, 10.02], ['CIRCLE', 0, 0, 10]).equivalent, false);
	assert.equal(comparePcbPolygonSource([0, 0, 'L', 10.0001, 0, 10, 10, 0, 0], [0, 0, 'L', 10, 0, 10, 10, 0, 0]).equivalent, false, 'a full precision unit of displacement is outside the rounding tolerance');
	for (let index = 0; index < 130; index++)
		items.line.set(`outline-${index}`, state('line', `outline-${index}`));
	items.line.set('copper-line', state('line', 'copper-line', { layer: 1, net: 'GND' }));
	items.arc.set('silkscreen-arc', state('arc', 'silkscreen-arc', { layer: 3 }));
	globalThis.eda = {
		dmt_Pcb: { async getCurrentPcbInfo() { return { uuid: page }; } },
		pcb_PrimitiveLine: api('line'),
		pcb_PrimitiveArc: api('arc'),
		pcb_PrimitivePolyline: api('polyline'),
		pcb_Layer: { async getAllLayers() { return [{ id: 11, type: 'OTHER', layerStatus: 1, locked: layerLocked }]; } },
		pcb_MathPolygon: { createPolygon(value) { return { getSource: () => value }; } },
	};

	const all = await handlePcbBoardOutlineManageTask({ action: 'read' });
	assert.equal(all.complete, true);
	assert.equal(all.lineCount, 130);
	assert.equal(all.arcCount, 0);
	assert.deepEqual(queryLayers, [11, 11, 11]);
	assert.equal((await toSerializableAsync(all)).lines.length, 130);
	assert.equal((await handlePcbBoardOutlineManageTask({ action: 'read', kind: 'line', primitiveId: 'copper-line' })).found, false);
	assert.equal((await handlePcbBoardOutlineManageTask({ action: 'read', kind: 'line', primitiveId: 'outline-0' })).found, true);

	const line = await handlePcbBoardOutlineManageTask({ action: 'create', kind: 'line', startX: 0, startY: 0, endX: 100, endY: 0 });
	assert.equal(line.verified, true);
	assert.equal(line.primitive.layer, 11);
	assert.equal(line.primitive.net, '');
	const arc = await handlePcbBoardOutlineManageTask({ action: 'create', kind: 'arc', startX: 0, startY: 0, endX: 100, endY: 100, arcAngle: 90, interactiveMode: 2 });
	assert.equal(arc.primitive.interactiveMode, 2);
	const polyline = await handlePcbBoardOutlineManageTask({ action: 'create', kind: 'polyline', polygonSource: source });
	assert.deepEqual(polyline.primitive.polygonSource, source);
	const closedSquare = [0, 0, 'L', 3937.008, 0, 3937.008, 3937.008, 0, 3937.008, 0, 0];
	const reversedSquare = [0, 0, 'L', 0, 3937.008, 3937.008, 3937.008, 3937.008, 0, 0, 0];
	const polygonFactory = globalThis.eda.pcb_MathPolygon.createPolygon;
	globalThis.eda.pcb_MathPolygon.createPolygon = () => ({ getSource: () => [100, 0, 'L', 100, 100, 0, 0] });
	const changedOpenPath = await handlePcbBoardOutlineManageTask({ action: 'create', kind: 'polyline', polygonSource: source });
	assert.equal(changedOpenPath.ok, false, 'cycling an open L path replaces an actual edge and must fail');
	assert.equal(changedOpenPath.reason, 'create_readback_mismatch');
	assert.equal(changedOpenPath.requestedMismatches[0].field, 'polygonSource');
	const reversedOpenSource = [100, 100, 'L', 100, 0, 0, 0];
	globalThis.eda.pcb_MathPolygon.createPolygon = () => ({ getSource: () => reversedOpenSource });
	const reversedOpenPath = await handlePcbBoardOutlineManageTask({ action: 'create', kind: 'polyline', polygonSource: source });
	assert.equal(reversedOpenPath.ok, true, 'reversing the complete open path preserves both real edges');
	assert.equal(reversedOpenPath.normalization.reversed, true);
	assert.deepEqual(reversedOpenPath.primitive.polygonSource, reversedOpenSource);
	globalThis.eda.pcb_MathPolygon.createPolygon = polygonFactory;
	globalThis.eda.pcb_MathPolygon.createPolygon = () => ({ getSource: () => reversedSquare });
	const windingNormalized = await handlePcbBoardOutlineManageTask({ action: 'create', kind: 'polyline', polygonSource: closedSquare, lineWidth: 1 });
	assert.equal(windingNormalized.verified, true, 'native reversed winding is the same board outline');
	assert.equal(windingNormalized.ok, true);
	assert.deepEqual(windingNormalized.primitive.polygonSource, reversedSquare);
	assert.equal(windingNormalized.normalization.reversed, true);
	assert.equal(requiresHostRestartForResult(path, {}, windingNormalized), false);
	const shiftedSquare = [3937.008, 3937.008, 'L', 0, 3937.008, 0, 0, 3937.008, 0, 3937.008, 3937.008];
	globalThis.eda.pcb_MathPolygon.createPolygon = () => ({ getSource: () => shiftedSquare });
	const shiftNormalized = await handlePcbBoardOutlineManageTask({ action: 'modify', kind: 'polyline', primitiveId: windingNormalized.primitiveId, property: { polygonSource: closedSquare } });
	assert.equal(shiftNormalized.verified, true, 'a shifted contour start must not quarantine the write');
	assert.equal(shiftNormalized.normalization.cyclicShift, 2);
	assert.deepEqual((await toSerializableAsync(shiftNormalized)).primitive.polygonSource, shiftedSquare);
	const crossedSquare = [0, 0, 'L', 3937.008, 3937.008, 0, 3937.008, 3937.008, 0, 0, 0];
	globalThis.eda.pcb_MathPolygon.createPolygon = () => ({ getSource: () => crossedSquare });
	const crossedOutline = await handlePcbBoardOutlineManageTask({ action: 'create', kind: 'polyline', polygonSource: closedSquare });
	assert.equal(crossedOutline.verified, false, 'same vertices joined by different edges are not equivalent');
	assert.equal(crossedOutline.reason, 'create_readback_mismatch');
	globalThis.eda.pcb_MathPolygon.createPolygon = polygonFactory;
	const modified = await handlePcbBoardOutlineManageTask({ action: 'modify', kind: 'polyline', primitiveId: polyline.primitiveId, property: { polygonSource: [0, 0, 'L', 200, 0], primitiveLock: true } });
	assert.deepEqual(modified.primitive.polygonSource, [0, 0, 'L', 200, 0]);
	assert.equal(modified.primitive.primitiveLock, true);
	const deleted = await handlePcbBoardOutlineManageTask({ action: 'delete', kind: 'arc', primitiveId: arc.primitiveId });
	assert.equal(deleted.deleted, true);
	assert.equal(deleted.verified, true);

	const beforeRejected = writes;
	await assert.rejects(() => handlePcbBoardOutlineManageTask({ action: 'modify', kind: 'line', primitiveId: 'copper-line', property: { lineWidth: 0.5 } }), /does not exist/);
	await assert.rejects(() => handlePcbBoardOutlineManageTask({ action: 'delete', kind: 'arc', primitiveId: 'silkscreen-arc' }), /does not exist/);
	await assert.rejects(() => handlePcbBoardOutlineManageTask({ action: 'modify', kind: 'line', primitiveId: line.primitiveId, property: { layer: 1 } }), /Unsupported/);
	await assert.rejects(() => handlePcbBoardOutlineManageTask({ action: 'create', kind: 'line', startX: 0, startY: 0 }), /endX is required/);
	layerLocked = true;
	await assert.rejects(() => handlePcbBoardOutlineManageTask({ action: 'delete', kind: 'line', primitiveId: line.primitiveId }), /locked/);
	layerLocked = false;
	assert.equal(writes, beforeRejected);

	const originalModify = globalThis.eda.pcb_PrimitiveLine.modify;
	globalThis.eda.pcb_PrimitiveLine.modify = async () => {
		throw new Error('RPC Call Timed Out');
	};
	const unknown = await handlePcbBoardOutlineManageTask({ action: 'modify', kind: 'line', primitiveId: line.primitiveId, property: { lineWidth: 0.4 } });
	assert.equal(unknown.commitUnknown, true);
	assert.equal(unknown.nativeCallSettled, false);
	assert.equal(requiresHostRestartForResult(path, {}, unknown), true);
	globalThis.eda.pcb_PrimitiveLine.modify = originalModify;

	const originalGet = globalThis.eda.pcb_PrimitiveLine.get;
	let reads = 0;
	globalThis.eda.pcb_PrimitiveLine.get = async (...args) => {
		reads += 1;
		if (reads === 2)
			throw new Error('readback failed');
		return originalGet(...args);
	};
	const readbackUnknown = await handlePcbBoardOutlineManageTask({ action: 'modify', kind: 'line', primitiveId: line.primitiveId, property: { lineWidth: 0.6 } });
	assert.equal(readbackUnknown.commitUnknown, true);
	assert.equal(readbackUnknown.nativeCallSettled, true);
	globalThis.eda.pcb_PrimitiveLine.get = originalGet;

	const originalArcCreate = globalThis.eda.pcb_PrimitiveArc.create;
	for (const nativeResult of [null, false]) {
		globalThis.eda.pcb_PrimitiveArc.create = async () => nativeResult;
		const noEffect = await handlePcbBoardOutlineManageTask({ action: 'create', kind: 'arc', startX: 0, startY: 0, endX: 20, endY: 20, arcAngle: 90 });
		assert.equal(noEffect.ok, false);
		assert.equal(noEffect.applied, false);
		assert.equal(noEffect.verified, false);
		assert.equal(noEffect.reason, 'native_create_no_effect');
		assert.equal(noEffect.commitUnknown, undefined);
		assert.equal(requiresHostRestartForResult(path, {}, noEffect), false);
	}
	globalThis.eda.pcb_PrimitiveArc.create = originalArcCreate;
	const originalPolylineCreate = globalThis.eda.pcb_PrimitivePolyline.create;
	globalThis.eda.pcb_PrimitivePolyline.create = async (...args) => {
		const result = await originalPolylineCreate(...args);
		const created = items.polyline.get(result.getState_PrimitiveId());
		created.net = null;
		created.polygonSource = ['R', 697.55, -3717.55, 240, 160, 90, 0];
		return result;
	};
	const wrongGeometry = await handlePcbBoardOutlineManageTask({ action: 'create', kind: 'polyline', polygonSource: ['R', 5000, 5400, 100, 100, 0, 0], lineWidth: 10 });
	assert.equal(wrongGeometry.ok, false);
	assert.equal(wrongGeometry.applied, true);
	assert.equal(wrongGeometry.verified, false);
	assert.equal(wrongGeometry.reason, 'create_readback_mismatch');
	assert.equal(wrongGeometry.before, null);
	assert.equal(wrongGeometry.after.net, null);
	assert.deepEqual(wrongGeometry.after.polygonSource, ['R', 697.55, -3717.55, 240, 160, 90, 0]);
	assert.equal(wrongGeometry.requestedMismatches[0].field, 'polygonSource');
	const serializedWrongGeometry = await toSerializableAsync(wrongGeometry);
	assert.deepEqual(serializedWrongGeometry.requestedMismatches[0].actual, ['R', 697.55, -3717.55, 240, 160, 90, 0]);
	assert.equal(wrongGeometry.commitUnknown, undefined);
	assert.equal(requiresHostRestartForResult(path, {}, wrongGeometry), false);
	globalThis.eda.pcb_PrimitivePolyline.create = originalPolylineCreate;
	const originalPolylineDelete = globalThis.eda.pcb_PrimitivePolyline.delete;
	globalThis.eda.pcb_PrimitivePolyline.delete = async () => true;
	const stillPresent = await handlePcbBoardOutlineManageTask({ action: 'delete', kind: 'polyline', primitiveId: wrongGeometry.primitiveId });
	assert.equal(stillPresent.commitUnknown, true);
	globalThis.eda.pcb_PrimitivePolyline.delete = originalPolylineDelete;
	const originalPolylineGet = globalThis.eda.pcb_PrimitivePolyline.get;
	globalThis.eda.pcb_PrimitivePolyline.get = async id => items.polyline.has(id)
		? originalPolylineGet(id)
		: { getState_PrimitiveId: () => id };
	const deletedWrongGeometry = await handlePcbBoardOutlineManageTask({ action: 'delete', kind: 'polyline', primitiveId: wrongGeometry.primitiveId });
	assert.equal(deletedWrongGeometry.verified, true);
	assert.equal(items.polyline.has(wrongGeometry.primitiveId), false);
	const deletedRead = await handlePcbBoardOutlineManageTask({ action: 'read', kind: 'polyline', primitiveId: wrongGeometry.primitiveId });
	assert.equal(deletedRead.found, false, 'an ID-only native placeholder is not a live board outline');
	await assert.rejects(() => handlePcbBoardOutlineManageTask({ action: 'delete', kind: 'polyline', primitiveId: wrongGeometry.primitiveId }), /does not exist/);
	globalThis.eda.pcb_PrimitivePolyline.get = async id => ({ getState_PrimitiveId: () => id });
	await assert.rejects(() => handlePcbBoardOutlineManageTask({ action: 'read', kind: 'polyline', primitiveId: polyline.primitiveId }), /getState_Net is unavailable/);
	globalThis.eda.pcb_PrimitivePolyline.get = originalPolylineGet;

	globalThis.eda.pcb_PrimitiveArc.create = async (...args) => {
		const result = await originalArcCreate(...args);
		page = 'pcb-2';
		return result;
	};
	const changedPage = await handlePcbBoardOutlineManageTask({ action: 'create', kind: 'arc', startX: 0, startY: 0, endX: 20, endY: 20, arcAngle: 90 });
	assert.equal(changedPage.commitUnknown, true);
	assert.match(changedPage.error, /active PCB changed/);
	console.log('PCB board outline management tests passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
