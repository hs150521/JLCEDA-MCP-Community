const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');

const { handlePcbRoutingEditTask } = require('../src/mcp/pcb-routing-edit-handler.ts');
const { requiresHostRestartForResult } = require('../src/runtime/task-timeout.ts');
const { toSerializableAsync } = require('../src/utils.ts');

const path = '/bridge/jlceda/pcb/routing-edit';
const polygonSource = [100, 200, 'L', 300, 200, 300, 400];
const states = {
	line: new Map(),
	arc: new Map(),
	polyline: new Map(),
	via: new Map(),
};
let pageUuid = 'pcb-1';
let serial = 1;
let nativeWriteCount = 0;

function makeState(kind, primitiveId, patch = {}) {
	const base = { primitiveId, net: 'GND', primitiveLock: false };
	if (kind === 'via')
		return { ...base, x: 100, y: 200, holeDiameter: 0.3, diameter: 0.6, viaType: 0, designRuleBlindViaName: null, ...patch };
	const lineBase = { ...base, layer: 1, lineWidth: 0.2 };
	if (kind === 'polyline')
		return { ...lineBase, polygonSource, ...patch };
	const segmentBase = { ...lineBase, startX: 100, startY: 200, endX: 300, endY: 400 };
	return kind === 'arc'
		? { ...segmentBase, arcAngle: 90, interactiveMode: 1, ...patch }
		: { ...segmentBase, ...patch };
}

function primitive(state) {
	const getters = {};
	for (const [field, value] of Object.entries(state)) {
		const getterName = `getState_${field.charAt(0).toUpperCase()}${field.slice(1)}`;
		getters[getterName] = () => value;
	}
	getters.getState_Polygon = () => ({ getSource: () => state.polygonSource });
	return getters;
}

function routingApi(kind) {
	return {
		async getAll() { return [...states[kind].values()].map(primitive); },
		async get(id) { return states[kind].has(id) ? primitive(states[kind].get(id)) : undefined; },
		async create(...args) {
			nativeWriteCount += 1;
			const primitiveId = `${kind}-new-${serial++}`;
			let state;
			if (kind === 'arc') {
				const [net, layer, startX, startY, endX, endY, arcAngle, lineWidth, interactiveMode, primitiveLock] = args;
				state = makeState(kind, primitiveId, { net, layer, startX, startY, endX, endY, arcAngle, lineWidth: lineWidth ?? 0.2, interactiveMode: interactiveMode ?? 1, primitiveLock: primitiveLock ?? false });
			}
			else {
				const [net, layer, polygon, lineWidth, primitiveLock] = args;
				state = makeState(kind, primitiveId, { net, layer, polygonSource: polygon.getSource(), lineWidth: lineWidth ?? 0.2, primitiveLock: primitiveLock ?? false });
			}
			states[kind].set(primitiveId, state);
			return primitive(state);
		},
		async modify(id, patch) {
			nativeWriteCount += 1;
			const next = { ...patch };
			if (next.polygon) {
				next.polygonSource = next.polygon.getSource();
				delete next.polygon;
			}
			Object.assign(states[kind].get(id), next);
			return primitive(states[kind].get(id));
		},
		async delete(id) {
			nativeWriteCount += 1;
			return states[kind].delete(id);
		},
	};
}

async function main() {
	for (let index = 0; index < 130; index++)
		states.line.set(`line-${index}`, makeState('line', `line-${index}`, { startX: index }));
	states.arc.set('arc-1', makeState('arc', 'arc-1'));
	states.polyline.set('polyline-1', makeState('polyline', 'polyline-1'));
	states.via.set('via-1', makeState('via', 'via-1'));
	states.line.set('outline-line', makeState('line', 'outline-line', { layer: 11, net: null }));
	states.arc.set('silkscreen-arc', makeState('arc', 'silkscreen-arc', { layer: 3, net: null }));
	states.polyline.set('outline-polyline', makeState('polyline', 'outline-polyline', { layer: 11, net: null }));
	globalThis.eda = {
		dmt_Pcb: { async getCurrentPcbInfo() { return { uuid: pageUuid }; } },
		pcb_PrimitiveLine: routingApi('line'),
		pcb_PrimitiveArc: routingApi('arc'),
		pcb_PrimitivePolyline: routingApi('polyline'),
		pcb_PrimitiveVia: routingApi('via'),
		pcb_Net: {
			async getAllNets() { return [{ net: 'GND' }, { net: 'VCC' }]; },
			async getAllPrimitivesByNet(net) {
				return [...states.via.values()].filter(item => item.net === net).map(item => ({ globalIndex: item.primitiveId, pcbItemPrimitiveType: 'Via', ...(item.parentComponentPrimitiveId ? { parentId: item.parentComponentPrimitiveId } : {}) }));
			},
		},
		pcb_Layer: { async getAllLayers() { return [{ id: 1, type: 'SIGNAL', layerStatus: 1, locked: false }, { id: 2, type: 'SIGNAL', layerStatus: 1, locked: false }]; } },
		pcb_MathPolygon: { createPolygon(source) { return { getSource: () => source }; } },
	};

	const all = await handlePcbRoutingEditTask({ action: 'read' });
	assert.equal(all.complete, true);
	assert.equal(all.pageUuid, 'pcb-1');
	assert.equal(all.lineCount, 130);
	assert.equal(all.arcCount, 1);
	assert.equal(all.polylineCount, 1);
	assert.equal(all.viaCount, 1);
	assert.equal((await toSerializableAsync(all)).lines.length, 130, 'full read must preserve every routing primitive');
	assert.deepEqual(all.polylines[0].polygonSource, polygonSource);
	assert.equal(all.arcs[0].interactiveMode, 1);
	assert.equal(all.vias[0].viaType, 0);

	const targeted = await handlePcbRoutingEditTask({ action: 'read', kind: 'arc', primitiveId: 'arc-1' });
	assert.equal(targeted.found, true);
	assert.equal(targeted.primitive.arcAngle, 90);
	assert.equal(targeted.complete, undefined);
	const missing = await handlePcbRoutingEditTask({ action: 'read', kind: 'arc', primitiveId: 'missing' });
	assert.equal(missing.found, false);
	assert.equal(missing.primitive, null);
	assert.equal(missing.reason, 'not_found');
	const outline = await handlePcbRoutingEditTask({ action: 'read', kind: 'line', primitiveId: 'outline-line' });
	assert.equal(outline.found, false, 'board outline must not be reported as copper routing');
	assert.equal((await handlePcbRoutingEditTask({ action: 'read', kind: 'arc', primitiveId: 'silkscreen-arc' })).found, false);
	states.line.set('invalid-copper-line', makeState('line', 'invalid-copper-line', { net: null }));
	await assert.rejects(() => handlePcbRoutingEditTask({ action: 'read' }), /EDA net must be a string/);
	states.line.delete('invalid-copper-line');

	const newArc = await handlePcbRoutingEditTask({ action: 'create', kind: 'arc', net: 'GND', layer: 1, startX: 1, startY: 2, endX: 3, endY: 4, arcAngle: 135, interactiveMode: 2, lineWidth: 0.5, primitiveLock: true });
	assert.equal(newArc.ok, true);
	assert.equal(newArc.verified, true);
	assert.equal(newArc.primitive.arcAngle, 135);
	assert.equal(newArc.primitive.interactiveMode, 2);
	const newPolyline = await handlePcbRoutingEditTask({ action: 'create', kind: 'polyline', net: 'VCC', layer: 2, polygonSource, lineWidth: 0.3 });
	assert.equal(newPolyline.ok, true);
	assert.deepEqual(newPolyline.primitive.polygonSource, polygonSource);

	for (const [kind, primitiveId, property, field, expected] of [
		['line', 'line-0', { endX: 350, lineWidth: 0.4, primitiveLock: true }, 'endX', 350],
		['arc', 'arc-1', { arcAngle: 120, interactiveMode: 2 }, 'arcAngle', 120],
		['polyline', 'polyline-1', { polygonSource: [0, 0, 'L', 50, 50], layer: 2 }, 'layer', 2],
		['via', 'via-1', { diameter: 0.8, x: 150 }, 'diameter', 0.8],
	]) {
		const modified = await handlePcbRoutingEditTask({ action: 'modify', kind, primitiveId, property });
		assert.equal(modified.ok, true, `${kind} modify`);
		assert.equal(modified.primitive[field], expected);
		assert.equal(modified.verified, true);
	}
	assert.equal(states.arc.get('arc-1').interactiveMode, 2);
	assert.deepEqual(states.polyline.get('polyline-1').polygonSource, [0, 0, 'L', 50, 50]);

	states.via.set('quantized-via', makeState('via', 'quantized-via', { holeDiameter: 15.6, diameter: 31.5 }));
	const originalViaModify = globalThis.eda.pcb_PrimitiveVia.modify;
	globalThis.eda.pcb_PrimitiveVia.modify = async (id, patch) => {
		await originalViaModify(id, patch);
		if (patch.holeDiameter === 15.748 || patch.holeDiameter === 15.7)
			states.via.get(id).holeDiameter = 15.8;
		return primitive(states.via.get(id));
	};
	for (const requestedHole of [15.748, 15.7]) {
		const writesBefore = nativeWriteCount;
		const mismatch = await toSerializableAsync(await handlePcbRoutingEditTask({ action: 'modify', kind: 'via', primitiveId: 'quantized-via', property: { holeDiameter: requestedHole } }));
		assert.equal(mismatch.ok, false, 'unexplained native modify dimensions remain a failure');
		assert.equal(mismatch.reason, 'post_write_readback_failed');
		assert.equal(mismatch.commitUnknown, true);
		assert.equal(mismatch.nativeCallSettled, true);
		assert.equal(mismatch.after.holeDiameter, 15.8, 'return the actual native dimension after modification');
		assert.deepEqual(mismatch.requested, { holeDiameter: requestedHole });
		assert.deepEqual(mismatch.mismatches, [{ field: 'holeDiameter', requested: requestedHole, actual: 15.8 }]);
		assert.equal(nativeWriteCount, writesBefore + 1, 'the handler must not retry a settled native modification');
	}
	const unchangedHole = await handlePcbRoutingEditTask({ action: 'modify', kind: 'via', primitiveId: 'quantized-via', property: { holeDiameter: 15.6 } });
	assert.equal(unchangedHole.ok, true);
	assert.equal(unchangedHole.primitive.holeDiameter, 15.6);
	globalThis.eda.pcb_PrimitiveVia.modify = originalViaModify;
	states.via.delete('quantized-via');
	states.via.set('child-via', makeState('via', 'child-via', { parentComponentPrimitiveId: 'component-1' }));
	const beforeChildDelete = nativeWriteCount;
	const childDelete = await toSerializableAsync(await handlePcbRoutingEditTask({ action: 'delete', kind: 'via', primitiveId: 'child-via' }));
	assert.equal(childDelete.ok, false);
	assert.equal(childDelete.reason, 'footprint_owned_via');
	assert.equal(childDelete.parentComponentPrimitiveId, 'component-1');
	assert.equal(childDelete.applied, false);
	assert.equal(childDelete.deleted, false);
	assert.equal(childDelete.commitUnknown, undefined);
	assert.equal(states.via.has('child-via'), true);
	assert.equal(nativeWriteCount, beforeChildDelete, 'parent-owned vias are rejected before native deletion');
	states.via.delete('child-via');

	for (const [kind, primitiveId] of [['line', 'line-1'], ['arc', 'arc-1'], ['polyline', 'polyline-1'], ['via', 'via-1']]) {
		const primitiveApi = globalThis.eda[{ line: 'pcb_PrimitiveLine', arc: 'pcb_PrimitiveArc', polyline: 'pcb_PrimitivePolyline', via: 'pcb_PrimitiveVia' }[kind]];
		const originalGet = primitiveApi.get;
		if (kind === 'arc' || kind === 'polyline') {
			primitiveApi.get = async (id) => {
				if (id === primitiveId && !states[kind].has(id))
					return { getState_PrimitiveId: () => id };
				return originalGet(id);
			};
		}
		const deleted = await handlePcbRoutingEditTask({ action: 'delete', kind, primitiveId });
		assert.equal(deleted.ok, true, `${kind} delete`);
		assert.equal(deleted.deleted, true);
		if (kind === 'via') {
			assert.equal(deleted.ownership, 'unknown', 'a raw via without a parent field does not prove standalone ownership');
			assert.equal(deleted.verificationScope, 'current_page_memory');
			assert.equal(deleted.durableDeletionVerified, false);
			assert.equal(deleted.requiredPersistenceVerification, 'save_and_reopen_pcb');
		}
		assert.equal(states[kind].has(primitiveId), false);
		if (kind === 'arc' || kind === 'polyline') {
			const missingAfterDelete = await handlePcbRoutingEditTask({ action: 'read', kind, primitiveId });
			assert.equal(missingAfterDelete.ok, true);
			assert.equal(missingAfterDelete.found, false, `${kind} read after delete`);
			assert.equal(missingAfterDelete.primitive, null);
			assert.equal(missingAfterDelete.reason, 'not_found');
		}
		primitiveApi.get = originalGet;
	}
	states.via.set('unknown-ownership-via', makeState('via', 'unknown-ownership-via'));
	const originalNetPrimitives = globalThis.eda.pcb_Net.getAllPrimitivesByNet;
	delete globalThis.eda.pcb_Net.getAllPrimitivesByNet;
	const unknownOwnershipDelete = await handlePcbRoutingEditTask({ action: 'delete', kind: 'via', primitiveId: 'unknown-ownership-via' });
	assert.equal(unknownOwnershipDelete.ok, true);
	assert.equal(unknownOwnershipDelete.ownership, 'unknown');
	assert.equal(unknownOwnershipDelete.durableDeletionVerified, false, 'missing ownership API must never imply persistent removal');
	globalThis.eda.pcb_Net.getAllPrimitivesByNet = originalNetPrimitives;
	const originalArcDelete = globalThis.eda.pcb_PrimitiveArc.delete;
	globalThis.eda.pcb_PrimitiveArc.delete = async () => true;
	const arcStillPresent = await handlePcbRoutingEditTask({ action: 'delete', kind: 'arc', primitiveId: newArc.primitiveId });
	assert.deepEqual([arcStillPresent.ok, arcStillPresent.commitUnknown], [false, true], 'full ID readback must reject a primitive that still exists');
	globalThis.eda.pcb_PrimitiveArc.delete = originalArcDelete;

	const beforeRejected = nativeWriteCount;
	await assert.rejects(() => handlePcbRoutingEditTask({ action: 'create', kind: 'line', net: 'GND' }), /pcb_connectivity_action/);
	await assert.rejects(() => handlePcbRoutingEditTask({ action: 'create', kind: 'arc', net: 'MISSING', layer: 1, startX: 0, startY: 0, endX: 1, endY: 1, arcAngle: 90 }), /does not exist/);
	await assert.rejects(() => handlePcbRoutingEditTask({ action: 'modify', kind: 'via', primitiveId: newArc.primitiveId, property: { viaType: 2 } }), /Unsupported|does not exist/);
	await assert.rejects(() => handlePcbRoutingEditTask({ action: 'modify', kind: 'line', primitiveId: 'outline-line', property: { lineWidth: 0.4 } }), /does not exist/);
	await assert.rejects(() => handlePcbRoutingEditTask({ action: 'delete', kind: 'line', primitiveId: 'outline-line' }), /does not exist/);
	assert.equal(states.line.has('outline-line'), true);
	assert.equal(nativeWriteCount, beforeRejected);
	const originalGetAllLayers = globalThis.eda.pcb_Layer.getAllLayers;
	globalThis.eda.pcb_Layer.getAllLayers = async () => [{ id: 1, type: 'SIGNAL', layerStatus: 1, locked: true }];
	await assert.rejects(() => handlePcbRoutingEditTask({ action: 'modify', kind: 'line', primitiveId: 'line-2', property: { lineWidth: 0.7 } }), /enabled, unlocked copper layer/);
	await assert.rejects(() => handlePcbRoutingEditTask({ action: 'delete', kind: 'arc', primitiveId: newArc.primitiveId }), /enabled, unlocked copper layer/);
	assert.equal(nativeWriteCount, beforeRejected);
	globalThis.eda.pcb_Layer.getAllLayers = originalGetAllLayers;

	const originalModify = globalThis.eda.pcb_PrimitiveLine.modify;
	globalThis.eda.pcb_PrimitiveLine.modify = async () => {
		throw new Error('RPC Call Timed Out');
	};
	const unknown = await handlePcbRoutingEditTask({ action: 'modify', kind: 'line', primitiveId: 'line-2', property: { lineWidth: 0.7 } });
	assert.equal(unknown.commitUnknown, true);
	assert.equal(unknown.readbackRequired, true);
	assert.equal(unknown.nativeCallSettled, false);
	assert.equal(requiresHostRestartForResult(path, {}, unknown), true);
	globalThis.eda.pcb_PrimitiveLine.modify = originalModify;

	const originalGet = globalThis.eda.pcb_PrimitiveVia.get;
	let reads = 0;
	globalThis.eda.pcb_PrimitiveVia.get = async (...args) => {
		reads += 1;
		if (reads === 2)
			throw new Error('readback failed');
		return originalGet(...args);
	};
	states.via.set('via-1', makeState('via', 'via-1'));
	const readbackUnknown = await handlePcbRoutingEditTask({ action: 'modify', kind: 'via', primitiveId: 'via-1', property: { diameter: 0.9 } });
	assert.equal(readbackUnknown.commitUnknown, true);
	assert.equal(readbackUnknown.nativeCallSettled, true);
	globalThis.eda.pcb_PrimitiveVia.get = originalGet;

	const originalArcModify = globalThis.eda.pcb_PrimitiveArc.modify;
	globalThis.eda.pcb_PrimitiveArc.modify = async (...args) => {
		const result = await originalArcModify(...args);
		pageUuid = 'pcb-2';
		return result;
	};
	const changedPage = await handlePcbRoutingEditTask({ action: 'modify', kind: 'arc', primitiveId: newArc.primitiveId, property: { arcAngle: 155 } });
	assert.equal(changedPage.commitUnknown, true);
	assert.match(changedPage.error, /active PCB changed/);
	globalThis.eda.pcb_PrimitiveArc.modify = originalArcModify;
	pageUuid = 'pcb-1';
	console.log('PCB routing edit tests passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
