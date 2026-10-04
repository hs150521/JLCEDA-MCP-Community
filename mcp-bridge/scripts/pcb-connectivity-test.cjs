const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');

const { handlePcbConnectivityTask } = require('../src/mcp/pcb-connectivity-handler.ts');
const { toSerializableAsync } = require('../src/utils.ts');

function linePrimitive(id, net, layer, startX, startY, endX, endY, lineWidth) {
	return {
		getState_PrimitiveId: () => id,
		getState_Net: () => net,
		getState_Layer: () => layer,
		getState_StartX: () => startX,
		getState_StartY: () => startY,
		getState_EndX: () => endX,
		getState_EndY: () => endY,
		getState_LineWidth: () => lineWidth,
	};
}

function viaPrimitive(id, net, x, y, holeDiameter, diameter) {
	return {
		getState_PrimitiveId: () => id,
		getState_Net: () => net,
		getState_X: () => x,
		getState_Y: () => y,
		getState_HoleDiameter: () => holeDiameter,
		getState_Diameter: () => diameter,
	};
}

async function main() {
	const nets = [{ net: 'GND' }];
	const layers = [
		{ id: 1, type: 'SIGNAL', layerStatus: 1, locked: false },
		{ id: 2, type: 'SIGNAL', layerStatus: 1, locked: true },
		{ id: 3, type: 'SILKSCREEN', layerStatus: 1, locked: false },
		{ id: 15, type: 'PLANE', layerStatus: 1, locked: false },
	];
	const lines = new Map();
	const vias = new Map();
	let lineCreates = 0;
	let viaCreates = 0;
	let lineCreateMode = 'normal';
	let viaReadbackMode = 'normal';
	let lineScans = 0;
	globalThis.eda = {
		pcb_Net: { async getAllNets() { return nets; } },
		pcb_Layer: { async getAllLayers() { return layers; } },
		pcb_PrimitiveLine: {
			async getAllPrimitiveId() { throw new Error('full-board line ID scan must not be used'); },
			async create(net, layer, startX, startY, endX, endY, lineWidth) {
				if (lineCreateMode === 'validation')
					throw new TypeError('Invalid line width');
				lineCreates++;
				const primitive = linePrimitive(`line-${lineCreates}`, net, layer, startX, startY, endX, endY, lineWidth);
				lines.set(primitive.getState_PrimitiveId(), primitive);
				if (lineCreateMode === 'undefined')
					return undefined;
				if (lineCreateMode === 'reject')
					throw new Error('RPC Call create Timed Out');
				if (lineCreateMode === 'disconnect')
					throw new Error('Connection closed during create');
				return primitive;
			},
			async get(id) { return lines.get(id); },
			async getAll(net, layer) {
				lineScans += 1;
				assert.equal(net, 'GND', 'normalization scan is scoped to the requested net');
				assert.equal(layer, 1);
				return [...lines.values()].filter(item => item.getState_Net() === net && item.getState_Layer() === layer);
			},
		},
		pcb_PrimitiveVia: {
			async getAllPrimitiveId() { throw new Error('full-board via ID scan must not be used'); },
			async create(net, x, y, holeDiameter, diameter) {
				viaCreates++;
				const primitive = viaPrimitive(`via-${viaCreates}`, net, x, y, holeDiameter, diameter);
				vias.set(primitive.getState_PrimitiveId(), primitive);
				return primitive;
			},
			async get(id) {
				if (viaReadbackMode === 'throws')
					throw new Error('readback failed');
				return vias.get(id);
			},
		},
	};

	const line = { action: 'line_create', net: 'GND', layer: 1, startX: 100, startY: 200, endX: 300, endY: 200, lineWidth: 10 };
	const via = { action: 'via_create', net: 'GND', x: 300, y: 200, holeDiameter: 20, diameter: 40 };
	const createdLine = await handlePcbConnectivityTask(line);
	assert.equal(createdLine.ok, true);
	assert.equal(createdLine.primitiveId, 'line-1');
	assert.equal(createdLine.verified, true);
	const createdVia = await handlePcbConnectivityTask(via);
	assert.equal(createdVia.ok, true);
	assert.equal(createdVia.primitiveId, 'via-1');
	assert.equal(createdVia.verified, true);
	assert.equal(lineScans, 0, 'normal successful create keeps its targeted readback');

	await assert.rejects(handlePcbConnectivityTask({ ...line, net: 'UNKNOWN' }), /does not exist/);
	await assert.rejects(handlePcbConnectivityTask({ ...line, layer: 2 }), /unlocked copper/);
	await assert.rejects(handlePcbConnectivityTask({ ...line, layer: 3 }), /unlocked copper/);
	await assert.rejects(handlePcbConnectivityTask({ ...line, endX: line.startX, endY: line.startY }), /different start and end/);
	await assert.rejects(handlePcbConnectivityTask({ ...via, diameter: 10 }), /larger than holeDiameter/);
	assert.equal(lineCreates, 1, 'invalid inputs must not reach native create');
	assert.equal(viaCreates, 1);

	const newNetLine = await handlePcbConnectivityTask({ ...line, net: 'NEW_NET', allowNewNet: true });
	assert.equal(newNetLine.ok, true);
	assert.equal(newNetLine.net, 'NEW_NET');
	const planeLine = await handlePcbConnectivityTask({ ...line, layer: 15 });
	assert.equal(planeLine.ok, true);
	assert.equal(planeLine.layer, 15);

	const lineApi = globalThis.eda.pcb_PrimitiveLine;
	const originalLineCreate = lineApi.create;
	const normalizedRequest = { ...line, startX: 1000, endX: 1200 };
	lineApi.create = async () => {
		lines.set('split-a', linePrimitive('split-a', 'GND', 1, 1000, 200, 1100, 200, 10));
		lines.set('split-b', linePrimitive('split-b', 'GND', 1, 1200, 200, 1100, 200, 10));
		return { getState_PrimitiveId: () => 'native-replaced' };
	};
	const split = await toSerializableAsync(await handlePcbConnectivityTask(normalizedRequest));
	assert.equal(split.ok, true);
	assert.equal(split.verified, true);
	assert.equal(split.returnedPrimitiveId, 'native-replaced');
	assert.deepEqual(split.primitiveIds, ['split-a', 'split-b']);
	assert.equal(split.after.lines.length, 2);
	assert.equal(split.normalization.kind, 'split_or_merged_line');
	lines.delete('split-a');
	lines.delete('split-b');
	lineApi.create = async () => {
		lines.set('merged', linePrimitive('merged', 'GND', 1, 1250, 200, 950, 200, 10));
		return { getState_PrimitiveId: () => 'native-merged' };
	};
	const merged = await handlePcbConnectivityTask(normalizedRequest);
	assert.equal(merged.ok, true);
	assert.deepEqual(merged.primitiveIds, ['merged']);
	lines.delete('merged');
	lineApi.create = async () => {
		lines.set('gap-a', linePrimitive('gap-a', 'GND', 1, 1000, 200, 1090, 200, 10));
		lines.set('gap-b', linePrimitive('gap-b', 'GND', 1, 1100, 200, 1200, 200, 10));
		lines.set('wrong-width', linePrimitive('wrong-width', 'GND', 1, 1000, 200, 1200, 200, 20));
		lines.set('wrong-net', linePrimitive('wrong-net', 'VCC', 1, 1000, 200, 1200, 200, 10));
		lines.set('wrong-layer', linePrimitive('wrong-layer', 'GND', 2, 1000, 200, 1200, 200, 10));
		return { getState_PrimitiveId: () => 'native-gap' };
	};
	const gap = await handlePcbConnectivityTask(normalizedRequest);
	assert.equal(gap.ok, false);
	assert.equal(gap.commitUnknown, true, 'a gap or mismatching net/layer/width must retain the readback gate');
	assert.equal(gap.nativeCallSettled, true);
	lineApi.create = originalLineCreate;
	const viaApi = globalThis.eda.pcb_PrimitiveVia;
	const originalViaCreate = viaApi.create;
	viaApi.create = async (net, x, y, hole, diameter) => {
		const raw = viaPrimitive('quantized-via', net, x, y, Math.floor(hole * 10) / 10, Math.round(diameter * 10) / 10);
		vias.set('quantized-via', raw);
		return raw;
	};
	const quantized = await toSerializableAsync(await handlePcbConnectivityTask({ ...via, holeDiameter: 19.685, diameter: 47.244 }));
	assert.equal(quantized.ok, true);
	assert.equal(quantized.holeDiameter, 19.6);
	assert.equal(quantized.diameter, 47.2);
	assert.equal(quantized.after.holeDiameter, 19.6);
	assert.equal(quantized.normalization.holeDiameter.requested, 19.685);
	assert.equal(quantized.normalization.holeDiameter.mode, 'truncate_0_1_mil');
	const rounded = await handlePcbConnectivityTask({ ...via, holeDiameter: 19.685, diameter: 47.268 });
	assert.equal(rounded.ok, true);
	assert.equal(rounded.diameter, 47.3);
	assert.equal(rounded.normalization.diameter.mode, 'round_0_1_mil');
	viaApi.create = async (net, x, y) => {
		const raw = viaPrimitive('wrong-via', net, x, y, 19.64, 48);
		vias.set('wrong-via', raw);
		return raw;
	};
	const wrongVia = await handlePcbConnectivityTask({ ...via, holeDiameter: 19.685, diameter: 47.244 });
	assert.equal(wrongVia.ok, false);
	assert.equal(wrongVia.commitUnknown, true);
	assert.equal(wrongVia.after.holeDiameter, 19.64, 'observed dimensions are available to reconcile a real mismatch');
	viaApi.create = originalViaCreate;

	lineCreateMode = 'undefined';
	const noReturnedId = await handlePcbConnectivityTask(line);
	assert.equal(noReturnedId.ok, false);
	assert.equal(noReturnedId.commitUnknown, true);
	assert.equal(noReturnedId.nativeCallSettled, true);
	assert.equal(noReturnedId.newPrimitiveIds, undefined);

	lineCreateMode = 'reject';
	const nativeTimeout = await handlePcbConnectivityTask(line);
	assert.equal(nativeTimeout.ok, false);
	assert.equal(nativeTimeout.commitUnknown, true);
	assert.equal(nativeTimeout.nativeCallSettled, false);
	assert.match(nativeTimeout.error, /Timed Out/);
	lineCreateMode = 'disconnect';
	const disconnected = await handlePcbConnectivityTask(line);
	assert.equal(disconnected.commitUnknown, true);
	assert.equal(disconnected.nativeCallSettled, false);
	lineCreateMode = 'validation';
	const beforeValidation = lineCreates;
	const nativeValidation = await handlePcbConnectivityTask(line);
	assert.equal(nativeValidation.ok, false);
	assert.equal(nativeValidation.reason, 'native_create_rejected');
	assert.equal(nativeValidation.commitUnknown, undefined);
	assert.equal(nativeValidation.readbackRequired, undefined);
	assert.equal(lineCreates, beforeValidation);

	viaReadbackMode = 'throws';
	const missingReadback = await handlePcbConnectivityTask(via);
	assert.equal(missingReadback.ok, false);
	assert.equal(missingReadback.commitUnknown, true);
	assert.equal(missingReadback.nativeCallSettled, true);
	assert.equal(missingReadback.newPrimitiveIds, undefined);

	delete globalThis.eda;
	console.log('PCB connectivity handler checks passed');
}

main().catch((error) => {
	delete globalThis.eda;
	console.error(error);
	process.exitCode = 1;
});
