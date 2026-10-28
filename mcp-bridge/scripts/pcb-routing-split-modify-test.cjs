const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');
const { handlePcbRoutingEditTask } = require('../src/mcp/pcb-routing-edit-handler.ts');
const { requiresHostRestartForResult } = require('../src/runtime/task-timeout.ts');
const { toSerializableAsync } = require('../src/utils.ts');

function line(id, x1, y1, x2, y2, patch = {}) {
	return { primitiveId: id, net: 'GND', layer: 1, lineWidth: 0.2, primitiveLock: false, startX: x1, startY: y1, endX: x2, endY: y2, ...patch };
}
function primitive(state) {
	return Object.fromEntries(Object.entries(state).map(([key, value]) => [`getState_${key[0].toUpperCase()}${key.slice(1)}`, () => value]));
}
function original() {
	return [line('target', 0, -5, 30, 0), line('cross-a', 10, -10, 10, 10), line('cross-b', 20, -10, 20, 10)];
}
function split() {
	return [line('a', 0, 0, 10, 0), line('b', 20, 0, 10, 0), line('c', 20, 0, 30, 0), line('d', 10, -10, 10, 0), line('e', 10, 0, 10, 10), line('f', 20, -10, 20, 0), line('g', 20, 0, 20, 10)];
}
async function run(after, { before = original(), timeout = false, changePage = false, property = { startY: 0 } } = {}) {
	let states = before;
	let writes = 0;
	let page = 'pcb';
	globalThis.eda = {
		dmt_Pcb: { async getCurrentPcbInfo() { return { uuid: page }; } },
		pcb_Layer: { async getAllLayers() { return [{ id: 1, type: 'SIGNAL', layerStatus: 1 }]; } },
		pcb_Net: { async getAllNets() { return [{ net: 'GND' }]; } },
		pcb_PrimitiveLine: {
			async get(id) {
				const state = states.find(item => item.primitiveId === id);
				return state ? primitive(state) : undefined;
			},
			async getAll() { return states.map(primitive); },
			async modify() {
				writes++;
				states = after;
				if (changePage)
					page = 'other';
				if (timeout)
					throw new Error('RPC Call Timed Out');
				return undefined;
			},
		},
	};
	const result = await toSerializableAsync(await handlePcbRoutingEditTask({ action: 'modify', kind: 'line', primitiveId: 'target', property }));
	return { result, writes };
}
async function main() {
	const { result, writes } = await run(split());
	assert.equal(result.ok, true, 'three old lines replaced by seven equivalent segments must verify');
	assert.equal(result.verified, true);
	assert.equal(result.commitUnknown, undefined);
	assert.equal(writes, 1);
	assert.deepEqual([...result.primitiveIds].sort(), ['a', 'b', 'c']);
	assert.equal(result.normalization.kind, 'split_or_merged_line');
	for (const [name, mutate] of [
		['target gap', rows => rows.filter(row => row.primitiveId !== 'b')],
		['other old line gap', rows => rows.filter(row => row.primitiveId !== 'g')],
		['wrong layer', rows => rows.map(row => row.primitiveId === 'b' ? { ...row, layer: 2 } : row)],
		['wrong net', rows => rows.map(row => row.primitiveId === 'b' ? { ...row, net: 'VCC' } : row)],
		['wrong width', rows => rows.map(row => row.primitiveId === 'b' ? { ...row, lineWidth: 0.3 } : row)],
		['wrong lock', rows => rows.map(row => row.primitiveId === 'b' ? { ...row, primitiveLock: true } : row)],
		['unexpected branch', rows => [...rows, line('branch', 15, 0, 15, 15)]],
		['extension', rows => rows.map(row => row.primitiveId === 'c' ? { ...row, endX: 31 } : row)],
		['old target remains', rows => [...rows, original()[0]]],
		['off-axis', rows => rows.map(row => row.primitiveId === 'b' ? { ...row, startY: 0.0001 } : row)],
	]) {
		const { result: rejected, writes: count } = await run(mutate(split()));
		assert.equal(rejected.ok, false, name);
		assert.equal(rejected.commitUnknown, true, name);
		assert.equal(rejected.nativeCallSettled, true, name);
		assert.equal(rejected.readbackRequired, true, name);
		assert.equal(count, 1, name);
		assert.ok(rejected.affectedLines.before.length <= 32, name);
		assert.ok(rejected.affectedLines.after.length <= 32, name);
	}
	const retained = split();
	retained[0].primitiveId = 'target';
	assert.equal((await run(retained)).result.ok, true, 'old ID can survive as one split segment');
	const unchangedId = [line('target', 0, -5, 30, 0)];
	assert.equal((await run([line('target', 0, 0, 30, 0)], { before: unchangedId })).result.ok, true);
	const noOpBefore = [line('target', 0, 0, 20, 0), line('neighbour', 0, 10, 20, 10)];
	const noOp = await run(noOpBefore, { before: noOpBefore, property: { endX: 20 } });
	assert.deepEqual([noOp.result.ok, noOp.result.verified, noOp.result.commitUnknown, noOp.writes], [true, true, undefined, 1], 'an idempotent line write must verify unchanged copper');
	for (const [name, after] of [
		['idempotent write lost unrelated copper', noOpBefore.slice(0, 1)],
		['idempotent write added unrelated copper', [...noOpBefore, line('extra', 0, 20, 20, 20)]],
	]) {
		const rejected = await run(after, { before: noOpBefore, property: { endX: 20 } });
		assert.equal(rejected.result.commitUnknown, true, name);
		assert.equal(rejected.writes, 1, name);
	}
	const absorbedBefore = [line('target', 0, 0, 20, 0), line('tail', 20, 0, 40, 0)];
	const absorbed = await run([absorbedBefore[1]], { before: absorbedBefore, property: { startX: 20, endX: 30 } });
	assert.equal(absorbed.result.ok, true, 'a modified line absorbed into unchanged existing copper must verify');
	assert.deepEqual(absorbed.result.primitiveIds, ['tail']);
	assert.deepEqual(absorbed.result.normalization.mergedPrimitiveIds, ['tail']);
	assert.equal(absorbed.writes, 1);
	const ignored = await run(absorbedBefore, { before: absorbedBefore, property: { startX: 20, endX: 30 } });
	assert.equal(ignored.result.commitUnknown, true, 'unchanged existing coverage must not hide an ignored write leaving the old target');
	const absorbedWithExtra = await run([absorbedBefore[1], line('extra', 30, 0, 30, 10)], { before: absorbedBefore, property: { startX: 20, endX: 30 } });
	assert.equal(absorbedWithExtra.result.commitUnknown, true, 'an absorbed line must still reject unexpected copper');
	const prefixBefore = [line('target', 0, 0, 10, 0), line('down', 10, -5, 10, 0), line('up', 10, 0, 10, 5)];
	const prefixAfter = [...prefixBefore, line('extension', 10, 0, 20, 0)];
	const prefix = await run(prefixAfter, { before: prefixBefore, property: { endX: 20 } });
	assert.equal(prefix.result.ok, true, 'a native split may keep the old target unchanged as the first segment of an extended line');
	assert.deepEqual(prefix.result.primitiveIds, ['target', 'extension']);
	assert.equal(prefix.writes, 1);
	for (const [name, before, after, property] of [
		['ignored extension', prefixBefore, prefixBefore, { endX: 20 }],
		['pre-existing coverage hides ignored write', prefixAfter, prefixAfter, { endX: 20 }],
		['retained prefix leaves a gap', prefixBefore, [...prefixBefore, line('extension', 10, 0, 19, 0)], { endX: 20 }],
		['retained prefix extends outside requested target', prefixBefore, prefixAfter, { startX: 1, endX: 20 }],
		['retained prefix adds unrelated copper', prefixBefore, [...prefixAfter, line('extra', 15, 0, 15, 10)], { endX: 20 }],
	]) {
		const rejected = await run(after, { before, property });
		assert.equal(rejected.result.commitUnknown, true, name);
		assert.equal(rejected.writes, 1, name);
	}
	const timedOut = (await run(split(), { timeout: true })).result;
	assert.equal(timedOut.nativeCallSettled, false);
	assert.equal(requiresHostRestartForResult('/bridge/jlceda/pcb/routing-edit', {}, timedOut), true);
	assert.equal((await run(split(), { changePage: true })).result.commitUnknown, true);
	// #94 的实际场景：旧线与两条支路不相交，只有修改后的线才产生新的交点。
	const extensionBefore = [
		line('target', 0, 0, 10, 0),
		line('cross-a', 15, -5, 15, 5),
		line('cross-b', 20, -5, 20, 5),
	];
	const extensionAfter = [
		line('t1', 0, 0, 15, 0),
		line('t2', 15, 0, 20, 0),
		line('a1', 15, -5, 15, 0),
		line('a2', 15, 0, 15, 5),
		line('b1', 20, -5, 20, 0),
		line('b2', 20, 0, 20, 5),
	];
	const extension = await run(extensionAfter, { before: extensionBefore, property: { endX: 20 } });
	assert.equal(extension.result.ok, true, 'a modification that creates new intersections must verify');
	assert.deepEqual([...extension.result.primitiveIds].sort(), ['t1', 't2']);
	assert.deepEqual([...extension.result.normalization.replacedPrimitiveIds].sort(), ['cross-a', 'cross-b']);
	assert.equal(extension.result.commitUnknown, undefined);
	for (const [name, mutate] of [
		['new neighbour gap', rows => rows.filter(row => row.primitiveId !== 'a2')],
		['new neighbour extension', rows => rows.map(row => row.primitiveId === 'b2' ? { ...row, endY: 6 } : row)],
		['new copper outside', rows => [...rows, line('extra', 25, 0, 25, 10)]],
	]) {
		const rejected = (await run(mutate(extensionAfter), { before: extensionBefore, property: { endX: 20 } })).result;
		assert.equal(rejected.ok, false, name);
		assert.equal(rejected.commitUnknown, true, name);
	}
	// 原生把改后的线段与共线相邻段合并成一个 primitive。
	const mergeBefore = [line('target', 0, 0, 20, 0), line('tail', 20, 0, 40, 0)];
	const merge = await run([line('merged', 0, 0, 40, 0)], { before: mergeBefore, property: { endX: 30 } });
	assert.equal(merge.result.ok, true, 'a native merge with existing collinear copper must verify');
	assert.deepEqual(merge.result.normalization.mergedPrimitiveIds, ['merged']);
	const mergeExtended = await run([line('merged', 0, 0, 45, 0)], { before: mergeBefore, property: { endX: 30 } });
	assert.equal(mergeExtended.result.ok, false, 'a merge that adds copper beyond the previous extent must not verify');
	// 高密度板：整页快照上限不得把普通线路改动整体挡死。
	const denseBefore = Array.from({ length: 2500 }, (_, index) => line(`n-${index}`, 0, index, 10, index));
	denseBefore[0].primitiveId = 'target';
	const denseAfter = denseBefore.map(row => row.primitiveId === 'target' ? { ...row, endX: 12 } : row);
	assert.equal((await run(denseAfter, { before: denseBefore, property: { endX: 12 } })).result.ok, true, 'a dense board must still verify a plain line modification');
	console.log('PCB routing split modify tests passed');
}
main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
