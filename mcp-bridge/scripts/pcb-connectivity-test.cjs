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
	const lineScanScopes = [];
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
				lineScanScopes.push([net, layer]);
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
	assert.equal(lineScans, 1, '记录写前快照，成功的单 ID 回读无需再次扫描');
	assert.deepEqual(lineScanScopes, [['GND', 1]], '只读取请求网络和层，不扫描全板');

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
	assert.deepEqual(split.normalization.changedPrimitiveIds, ['split-a', 'split-b']);
	lines.delete('split-a');
	lines.delete('split-b');
	const originalLineGet = lineApi.get;
	lineApi.get = async id => id === 'native-replaced' ? { getState_PrimitiveId: () => id } : originalLineGet(id);
	const placeholderSplit = await toSerializableAsync(await handlePcbConnectivityTask(normalizedRequest));
	assert.equal(placeholderSplit.ok, true, '原生拆分返回仅 ID 的删除占位对象仍可由本次新线路核验');
	assert.deepEqual(placeholderSplit.primitiveIds, ['split-a', 'split-b']);
	assert.deepEqual(placeholderSplit.normalization.changedPrimitiveIds, ['split-a', 'split-b']);
	lineApi.get = originalLineGet;
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

	// 已有线路完整覆盖请求段时，不能掩盖 create 返回的错误新图元。
	lines.set('old-cover', linePrimitive('old-cover', 'GND', 1, 950, 200, 1250, 200, 10));
	for (const [net, layer, startY, endY, width] of [
		['VCC', 1, 200, 200, 10],
		['GND', 2, 200, 200, 10],
		['GND', 1, 200, 200, 20],
		['GND', 1, 210, 210, 10],
	]) {
		lineApi.create = async () => {
			const wrong = linePrimitive('wrong-new', net, layer, 1000, startY, 1200, endY, width);
			lines.set('wrong-new', wrong);
			return wrong;
		};
		const wrong = await toSerializableAsync(await handlePcbConnectivityTask(normalizedRequest));
		assert.equal(wrong.ok, false, '旧铜线不能作为错误返回图元的成功证据');
		assert.equal(wrong.verified, undefined);
		assert.equal(wrong.commitUnknown, true);
		assert.equal(wrong.returnedPrimitiveId, 'wrong-new');
		assert.deepEqual([wrong.after.net, wrong.after.layer, wrong.after.startY, wrong.after.lineWidth], [net, layer, startY, width]);
		lines.delete('wrong-new');
	}
	lineApi.create = async () => ({ getState_PrimitiveId: () => 'native-no-change' });
	const unchanged = await handlePcbConnectivityTask(normalizedRequest);
	assert.equal(unchanged.ok, false, '仅存在写前覆盖且没有本次线路变化时不得 verified');
	assert.equal(unchanged.commitUnknown, true);
	lines.delete('old-cover');

	// EDA 合并到原有 ID，必须按几何变化而不只按新 ID 判断。
	lines.set('reused-merge', linePrimitive('reused-merge', 'GND', 1, 950, 200, 1050, 200, 10));
	lineApi.create = async () => {
		const merged = linePrimitive('reused-merge', 'GND', 1, 1250, 200, 950, 200, 10);
		lines.set('reused-merge', merged);
		return merged;
	};
	const reused = await handlePcbConnectivityTask(normalizedRequest);
	assert.equal(reused.ok, true);
	assert.deepEqual(reused.primitiveIds, ['reused-merge']);
	assert.deepEqual(reused.normalization.changedPrimitiveIds, ['reused-merge']);
	lines.delete('reused-merge');

	// 新建的半段可以和未变化的旧半段共同覆盖请求段。
	lines.set('old-half', linePrimitive('old-half', 'GND', 1, 1000, 200, 1100, 200, 10));
	lineApi.create = async () => {
		const added = linePrimitive('new-half', 'GND', 1, 1100, 200, 1200, 200, 10);
		lines.set('new-half', added);
		return added;
	};
	const extension = await handlePcbConnectivityTask(normalizedRequest);
	assert.equal(extension.ok, true);
	assert.deepEqual(extension.primitiveIds, ['old-half', 'new-half']);
	assert.deepEqual(extension.normalization.changedPrimitiveIds, ['new-half']);
	lines.delete('old-half');
	lines.delete('new-half');
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
	// EDA Pro 3.2.181 的实机固定样本，避免在 mock 中重算待测公式。
	const viaSamples = [
		[19.685, 47.244, 19.6, 47.2],
		[15.748, 31.496, 15.8, 31.4],
		[19.73, 31.55, 19.8, 31.6],
		[15.7, 31.5, 15.8, 31.6],
	];
	for (const [hole, diameter, actualHole, actualDiameter] of viaSamples) {
		viaApi.create = async (net, x, y, requestedHole, requestedDiameter) => {
			assert.deepEqual([requestedHole, requestedDiameter], [hole, diameter]);
			const raw = viaPrimitive('quantized-via', net, x, y, actualHole, actualDiameter);
			vias.set('quantized-via', raw);
			return raw;
		};
		const quantized = await toSerializableAsync(await handlePcbConnectivityTask({ ...via, holeDiameter: hole, diameter }));
		assert.equal(quantized.ok, true);
		assert.equal(quantized.verified, true);
		assert.equal(quantized.commitUnknown, undefined);
		assert.deepEqual([quantized.holeDiameter, quantized.diameter], [actualHole, actualDiameter]);
		assert.deepEqual([quantized.after.holeDiameter, quantized.after.diameter], [actualHole, actualDiameter]);
		assert.deepEqual(quantized.normalization, {
			kind: 'via_dimension_quantization',
			holeDiameter: { requested: hole, actual: actualHole, mode: 'round_0_2_mil' },
			diameter: { requested: diameter, actual: actualDiameter, mode: 'round_0_2_mil' },
		});
	}
	for (const [hole, diameter, actualHole, actualDiameter] of [
		[19.685, 47.244, 19.7, 47.2],
		[15.748, 31.496, 15.8, 31.5],
		[19.73, 31.55, 19.78, 31.6],
		[15.7, 31.5, 15.6, 31.6],
		[15.8, 31.4, 15.9, 31.4],
		[19.685, 47.268, 19.6, 47.3],
	]) {
		viaApi.create = async (net, x, y) => {
			const raw = viaPrimitive('wrong-via', net, x, y, actualHole, actualDiameter);
			vias.set('wrong-via', raw);
			return raw;
		};
		const wrongVia = await handlePcbConnectivityTask({ ...via, holeDiameter: hole, diameter });
		assert.equal(wrongVia.ok, false, '相邻尺寸或非格点值不能作为原生量化结果接受');
		assert.equal(wrongVia.commitUnknown, true);
		assert.equal(wrongVia.nativeCallSettled, true);
		assert.deepEqual([wrongVia.after.holeDiameter, wrongVia.after.diameter], [actualHole, actualDiameter]);
	}
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
