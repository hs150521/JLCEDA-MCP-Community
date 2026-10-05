const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');

const { handleSchematicWireManageTask } = require('../src/mcp/schematic-wire-manage-handler.ts');
const { requiresHostRestartForResult } = require('../src/runtime/task-timeout.ts');
const { toSerializableAsync } = require('../src/utils.ts');

function wirePrimitive(wire) {
	return {
		getState_PrimitiveId: () => wire.primitiveId,
		getState_Line: () => wire.line,
		getState_Net: () => wire.net,
		getState_Color: () => wire.color,
		getState_LineWidth: () => wire.lineWidth,
		getState_LineType: () => wire.lineType,
	};
}

async function main() {
	let pageUuid = 'schematic-page-1';
	const wires = new Map([
		['w1', { primitiveId: 'w1', line: [0, 0, 100, 0], net: 'A', color: null, lineWidth: null, lineType: null }],
		['w2', { primitiveId: 'w2', line: [200, 0, 300, 0], net: 'B', color: null, lineWidth: null, lineType: null }],
	]);
	let nativeCalls = 0;
	let drcCalls = 0;
	globalThis.eda = {
		dmt_Schematic: { async getCurrentSchematicPageInfo() { return { uuid: pageUuid }; } },
		dmt_SelectControl: { async getCurrentDocumentInfo() { return { uuid: pageUuid }; } },
		sch_PrimitiveComponent: {
			async getAll() { return []; },
			async getAllPrimitiveId() { return []; },
		},
		sch_PrimitiveAttribute: { async getAll() { return []; } },
		sch_PrimitiveWire: {
			async getAll() { return [...wires.values()].map(wirePrimitive); },
			async getAllPrimitiveId() { return [...wires.keys()]; },
			async modify(id, property) {
				nativeCalls += 1;
				Object.assign(wires.get(id), property);
			},
			async delete(id) {
				nativeCalls += 1;
				return wires.delete(id);
			},
		},
		sch_Drc: {
			async check() {
				drcCalls += 1;
				return true;
			},
		},
	};
	const path = '/bridge/jlceda/schematic/wire-manage';
	const full = await handleSchematicWireManageTask({ action: 'read' });
	assert.deepEqual([full.ok, full.complete, full.pageUuid, full.wireCount], [true, true, pageUuid, 2]);
	assert.equal(JSON.parse(full.wiresSnapshot).length, 2);
	const selected = await handleSchematicWireManageTask({ action: 'read', primitiveId: 'w1' });
	assert.equal(selected.wire.net, 'A');
	assert.equal(selected.wire.primitiveId, 'w1');
	assert.equal(selected.wiresSnapshot, undefined, 'targeted reads should not return a large full-page result');
	wires.set('point-wire', { primitiveId: 'point-wire', line: [80, 105, 80, 105], net: '', color: null, lineWidth: null, lineType: null });
	const pointRead = await handleSchematicWireManageTask({ action: 'read', primitiveId: 'point-wire' });
	assert.equal(pointRead.ok, true, 'native zero-length wires remain readable');
	assert.equal(pointRead.wireCount, 3);
	assert.deepEqual(pointRead.wire.line, [80, 105, 80, 105]);
	await assert.rejects(handleSchematicWireManageTask({ action: 'modify', primitiveId: 'point-wire', property: { line: [80, 105, 80, 105] } }), /too short/);
	wires.delete('point-wire');
	for (let index = 0; index < 125; index += 1)
		wires.set(`extra-${index}`, { primitiveId: `extra-${index}`, line: [1000 + index, 0, 1000 + index, 10], net: '', color: null, lineWidth: null, lineType: null });
	const largeRead = await handleSchematicWireManageTask({ action: 'read' });
	assert.equal(JSON.parse(largeRead.wiresSnapshot).length, 127, 'the full-page JSON snapshot is not truncated at 120 wires');
	for (let index = 0; index < 125; index += 1)
		wires.delete(`extra-${index}`);
	const longLine = Array.from({ length: 120 }, (_, index) => [index + 1000, 0, index + 1001, 0]).flat();
	wires.set('long-wire', { primitiveId: 'long-wire', line: longLine, net: '', color: null, lineWidth: null, lineType: null });
	const targetedLongRead = await toSerializableAsync(await handleSchematicWireManageTask({ action: 'read', primitiveId: 'long-wire' }));
	assert.equal(targetedLongRead.wire.line.length, longLine.length, 'targeted line must survive Bridge serialization');
	const longStyleWrite = await toSerializableAsync(await handleSchematicWireManageTask({ action: 'modify', primitiveId: 'long-wire', property: { color: '#000000' } }));
	assert.equal(longStyleWrite.before.line.length, longLine.length);
	assert.equal(longStyleWrite.after.line.length, longLine.length);
	wires.delete('long-wire');
	const style = await handleSchematicWireManageTask({ action: 'modify', primitiveId: 'w1', property: { color: '#AA0000', lineWidth: 5, lineType: 1 } });
	assert.equal(style.ok, true);
	assert.equal(style.after.color, '#AA0000');
	assert.equal(style.after.lineWidth, 5);
	assert.equal(style.after.lineType, 1);
	const geometry = await handleSchematicWireManageTask({ action: 'modify', primitiveId: 'w1', property: { line: [0, 0, 50, 0] } });
	assert.equal(geometry.ok, true);
	assert.deepEqual(geometry.after.line, [0, 0, 50, 0]);
	const unnormalizedModify = globalThis.eda.sch_PrimitiveWire.modify;
	globalThis.eda.sch_PrimitiveWire.modify = async (id, property) => {
		await unnormalizedModify(id, property);
		if (property.line)
			wires.get(id).line = [0, 0, 25, 0, 25, 0, 50, 0];
	};
	const normalizedReadback = await handleSchematicWireManageTask({ action: 'modify', primitiveId: 'w1', property: { line: [0, 0, 50, 0] } });
	assert.equal(normalizedReadback.ok, true, 'native line segment splitting preserves requested geometry');
	globalThis.eda.sch_PrimitiveWire.modify = unnormalizedModify;
	const foreign = await handleSchematicWireManageTask({ action: 'modify', primitiveId: 'w1', property: { line: [0, 0, 200, 0] }, allowedWireIds: ['w2'] });
	assert.equal(foreign.ok, false);
	assert.equal(foreign.reason, 'wire_contact_conflict');
	const serializedForeign = await toSerializableAsync(foreign);
	assert.ok(JSON.parse(serializedForeign.previewSnapshot).touches.some(touch => touch.primitiveId === 'w2'), 'preview diagnostics survive Bridge serialization');
	assert.deepEqual(wires.get('w1').line, [0, 0, 25, 0, 25, 0, 50, 0]);
	const renamed = await handleSchematicWireManageTask({ action: 'modify', primitiveId: 'w1', property: { net: 'C' } });
	assert.equal(renamed.ok, true);
	assert.equal(renamed.after.net, 'C');
	wires.get('w2').line = [50, 0, 100, 0];
	wires.get('w2').net = 'C';
	const connectedRename = await handleSchematicWireManageTask({ action: 'modify', primitiveId: 'w1', property: { net: 'D' }, allowedWireIds: ['w2'] });
	assert.equal(connectedRename.reason, 'connected_wire_net_change');
	const serializedRename = await toSerializableAsync(connectedRename);
	assert.ok(JSON.parse(serializedRename.previewsSnapshot).some(preview => preview.touches.some(touch => touch.primitiveId === 'w2')));
	assert.equal(wires.get('w1').net, 'C');
	wires.get('w2').line = [200, 0, 300, 0];
	wires.get('w1').line = [0, 0, 25, 0, 25, 0, 50, 0];
	const splitRename = await handleSchematicWireManageTask({ action: 'modify', primitiveId: 'w1', property: { net: 'D' } });
	assert.equal(splitRename.ok, true, 'native split segments can be renamed without a geometry rewrite');
	const originalModify = globalThis.eda.sch_PrimitiveWire.modify;
	globalThis.eda.sch_PrimitiveWire.modify = async (id, property) => {
		await originalModify(id, property);
		wires.get('w2').color = '#123456';
	};
	const unexpected = await handleSchematicWireManageTask({ action: 'modify', primitiveId: 'w1', property: { color: '#00FF00' }, allowedWireIds: ['w2'] });
	assert.equal(unexpected.reason, 'unexpected_wire_changes');
	assert.equal(unexpected.commitUnknown, true);
	assert.deepEqual(unexpected.unexpectedOtherWireIds, ['w2']);
	globalThis.eda.sch_PrimitiveWire.modify = originalModify;
	await assert.rejects(handleSchematicWireManageTask({ action: 'modify', primitiveId: 'w1', property: { line: [0, 0, 10, 10] } }), /horizontal or vertical/);
	await assert.rejects(handleSchematicWireManageTask({ action: 'modify', primitiveId: 'w1', property: {} }), /non-empty/);
	assert.equal(nativeCalls, 7);
	const deleted = await handleSchematicWireManageTask({ action: 'delete', primitiveId: 'w1' });
	assert.deepEqual([deleted.ok, deleted.deleted, deleted.verified, deleted.wireCountAfter], [true, true, true, 1]);
	const missing = await handleSchematicWireManageTask({ action: 'delete', primitiveId: 'w1' });
	assert.equal(missing.reason, 'wire_not_found');
	globalThis.eda.sch_PrimitiveWire.modify = async () => {
		throw new Error('RPC Call modify Timed Out');
	};
	const timedOut = await handleSchematicWireManageTask({ action: 'modify', primitiveId: 'w2', property: { color: '#0000AA' } });
	assert.deepEqual([timedOut.commitUnknown, timedOut.nativeCallSettled, requiresHostRestartForResult(path, { action: 'modify' }, timedOut)], [true, false, true]);
	globalThis.eda.sch_PrimitiveWire.modify = async (id, property) => {
		await originalModify(id, property);
		pageUuid = 'schematic-page-2';
	};
	const changedPage = await handleSchematicWireManageTask({ action: 'modify', primitiveId: 'w2', property: { color: '#00AA00' } });
	assert.equal(changedPage.commitUnknown, true);
	assert.equal(changedPage.nativeCallSettled, true);
	pageUuid = 'schematic-page-1';
	globalThis.eda.sch_PrimitiveWire.modify = originalModify;
	const wireApi = globalThis.eda.sch_PrimitiveWire;
	const originalGetAll = wireApi.getAll;
	const originalGetAllPrimitiveId = wireApi.getAllPrimitiveId;
	const originalDelete = wireApi.delete;
	const copiedWires = new Map([['w2', { ...wires.get('w2') }]]);
	wireApi.getAll = async () => [...copiedWires.values()].map(wirePrimitive);
	wireApi.getAllPrimitiveId = async () => [...copiedWires.keys()];
	wireApi.delete = async (id) => {
		nativeCalls += 1;
		copiedWires.delete(id);
		return false;
	};
	pageUuid = 'schematic-page-copy';
	const copiedDelete = await handleSchematicWireManageTask({ action: 'delete', primitiveId: 'w2' });
	assert.deepEqual([copiedDelete.ok, copiedDelete.verified, copiedDelete.deleted], [true, true, true]);
	assert.equal(wires.has('w2'), true, 'source page keeps the same wire ID');
	assert.equal(copiedWires.has('w2'), false);
	copiedWires.set('w3', { primitiveId: 'w3', line: [400, 0, 500, 0], net: '', color: null, lineWidth: null, lineType: null });
	wireApi.delete = async () => false;
	const rejectedDelete = await handleSchematicWireManageTask({ action: 'delete', primitiveId: 'w3' });
	assert.deepEqual([rejectedDelete.ok, rejectedDelete.reason], [false, 'native_delete_rejected']);
	assert.equal(copiedWires.has('w3'), true);
	wireApi.getAll = originalGetAll;
	wireApi.getAllPrimitiveId = originalGetAllPrimitiveId;
	wireApi.delete = originalDelete;
	pageUuid = 'schematic-page-3';
	globalThis.eda.dmt_SelectControl.getCurrentDocumentInfo = async () => ({ uuid: 'schematic-page-1' });
	const stale = await handleSchematicWireManageTask({ action: 'read' });
	assert.equal(stale.ok, false);
	assert.equal(stale.errorCode, 'PAGE_NOT_READY', 'the active document must match the current schematic page');
	globalThis.eda.dmt_SelectControl.getCurrentDocumentInfo = async () => ({ uuid: pageUuid });
	wires.clear();
	wires.set('previously-unread-wire', { primitiveId: 'previously-unread-wire', line: [500, 0, 600, 0], net: '', color: null, lineWidth: null, lineType: null });
	wireApi.getAllPrimitiveId = async () => [];
	const staleIds = await handleSchematicWireManageTask({ action: 'read' });
	assert.equal(staleIds.errorCode, 'PAGE_NOT_READY', 'current-page wire objects and ID list must match');
	assert.equal(drcCalls, 0, 'wire management reads should avoid a full DRC scan');
	console.log('Schematic wire management tests passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
