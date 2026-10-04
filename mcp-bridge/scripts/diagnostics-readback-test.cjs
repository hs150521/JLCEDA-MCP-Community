const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');
const { handlePcbDrcCheckTask } = require('../src/mcp/pcb-drc-handler.ts');
const { toSerializableAsync, toSafeErrorDetails, toSafeErrorMessage } = require('../src/utils.ts');
const nativeDrcTree = require('./fixtures/pcb-drc-native-tree.json');

function detailLeaves(tree) {
	return tree.flatMap(node => Array.isArray(node.list) ? detailLeaves(node.list) : [node]);
}

async function main() {
	const nativeError = { code: 'UPDATE_REJECTED', reason: 'invalid source', field: 'format', source: 'private-footprint-source' };
	assert.equal(toSafeErrorMessage(nativeError), 'UPDATE_REJECTED: invalid source');
	assert.deepEqual(toSafeErrorDetails(nativeError), { message: 'invalid source', code: 'UPDATE_REJECTED', reason: 'invalid source', field: 'format' });
	assert.equal(JSON.stringify(toSafeErrorDetails(nativeError)).includes('private-footprint-source'), false);
	assert.match(toSafeErrorMessage({ data: 'private payload' }), /object error without a message/);
	assert.equal(toSafeErrorDetails({ reason: 'x'.repeat(5000) }).message.length, 2048);

	const sharedPrimitive = { primitiveId: 'pad-1', net: 'N1', position: { x: 12, y: 34 } };
	globalThis.eda = { pcb_Drc: { async check() {
		return [{ name: 'Clearance Error', count: 2, list: [
			{ rule: 'clearance', primitives: [sharedPrimitive, { primitiveId: 'pad-2' }], location: { x: 12, y: 34 } },
			{ rule: 'clearance', primitives: [sharedPrimitive], location: { x: 50, y: 60 } },
		] }, { name: 'Connection Error', count: 221, list: [{ primitiveId: 'pad-3', net: 'N2' }] }];
	} } };
	const result = JSON.parse(JSON.stringify(await toSerializableAsync(await handlePcbDrcCheckTask({ limit: 2 }))));
	assert.equal(result.errorCount, 223);
	assert.equal(result.returnedDetails, 2);
	assert.equal(result.totalAvailableDetails, 3);
	assert.equal(result.nextOffset, 2);
	assert.equal(result.nativeTruncated, true);
	assert.equal(result.truncated, true);
	assert.equal(result.errors[0].list[0].primitives[0].primitiveId, 'pad-1');
	assert.equal(result.errors[0].list[1].primitives[0].position.y, 34);
	assert.equal(JSON.stringify(result).includes('[MaxDepthExceeded]'), false);
	assert.equal(JSON.stringify(result).includes('[Circular]'), false, 'shared references are not cycles');
	const next = await handlePcbDrcCheckTask({ offset: 2, limit: 2 });
	assert.equal(next.errors[0].name, 'Connection Error');
	assert.equal(next.errors[0].list[0].primitiveId, 'pad-3');
	assert.equal(next.nextOffset, undefined);

	// 真实 PCB 的缓存分类树：一类 Clearance Error 下两类子项，共 28 条错误。
	// fixture 已确定性匿名化图元 ID、器件位号和坐标，保留树结构及字段关联。
	// 缓存中 line 端点已被旧版投影截断，下面另用同一条错误验证数值端点的深度。
	const nativeLeaves = detailLeaves(nativeDrcTree);
	assert.equal(nativeLeaves.length, 28);
	globalThis.eda.pcb_Drc.check = async () => nativeDrcTree;
	const nativeReceived = [];
	for (let offset = 0; offset < nativeLeaves.length; offset += 2) {
		const page = JSON.parse(JSON.stringify(await toSerializableAsync(await handlePcbDrcCheckTask({ offset, limit: 2 }))));
		assert.equal(page.errorCount, 28);
		assert.equal(page.totalAvailableDetails, 28);
		assert.equal(page.returnedDetails, 2);
		assert.equal(page.nextOffset, offset + 2 < 28 ? offset + 2 : undefined);
		assert.equal(page.nativeTruncated, false, '分类 count 必须与后代错误数比较');
		assert.equal(page.serializationTruncated, false);
		assert.equal(page.errors[0].name, 'Clearance Error');
		assert.equal(page.errors[0].returned, 2);
		const leaves = detailLeaves(page.errors);
		assert.deepEqual(leaves, nativeLeaves.slice(offset, offset + 2));
		nativeReceived.push(...leaves.map(leaf => leaf.globalIndex));
	}
	assert.deepEqual(nativeReceived, nativeLeaves.map(leaf => leaf.globalIndex));

	const geometryTree = structuredClone(nativeDrcTree);
	const geometryLeaf = geometryTree[0].list[1].list[0];
	const line = { _start: { x: 306.875, y: 309.75 }, _end: { x: 307.21, y: 309.706 } };
	geometryLeaf.explanation.errData.line = line;
	geometryLeaf.explanation.errData.net = 'GND';
	geometryLeaf.parentId = geometryTree[0].list[1];
	globalThis.eda.pcb_Drc.check = async () => geometryTree;
	const geometryPage = JSON.parse(JSON.stringify(await toSerializableAsync(await handlePcbDrcCheckTask({ limit: 2 }))));
	const geometryResult = detailLeaves(geometryPage.errors)[1];
	assert.deepEqual(geometryResult.explanation.errData.line, line);
	assert.equal(geometryResult.explanation.errData.net, 'GND');
	assert.deepEqual(geometryResult.objs, geometryLeaf.objs);
	assert.deepEqual(geometryResult.pos, geometryLeaf.pos);
	assert.equal(geometryResult.ruleName, 'otherClearance');
	assert.equal(geometryResult.explanation.str, geometryLeaf.explanation.str);
	assert.equal(geometryResult.parentId.name, 'Device to Device');
	assert.equal(geometryResult.parentId.count, 27);
	assert.equal(geometryResult.parentId.list, undefined);
	assert.equal(geometryPage.totalAvailableDetails, 28);
	assert.equal(geometryPage.nextOffset, 2);
	assert.equal(geometryPage.nativeTruncated, false);
	assert.equal(geometryPage.serializationTruncated, true);
	assert.equal(JSON.stringify(geometryPage).includes('[DetailLimitExceeded]'), false);

	const incompleteTree = structuredClone(nativeDrcTree);
	incompleteTree[0].list[1].list.pop();
	globalThis.eda.pcb_Drc.check = async () => incompleteTree;
	const incompletePage = await handlePcbDrcCheckTask({ limit: 2 });
	assert.equal(incompletePage.totalAvailableDetails, 27);
	assert.equal(incompletePage.nativeTruncated, true);

	globalThis.eda.pcb_Drc.check = async () => [{ code: 'clearance', count: 2 }];
	const summaryPage = await handlePcbDrcCheckTask({});
	assert.equal(summaryPage.errorCount, 2);
	assert.equal(summaryPage.totalAvailableDetails, 1);
	assert.equal(summaryPage.nativeTruncated, true, '兼容没有 list 的原生摘要分类');

	globalThis.eda.pcb_Drc.check = async () => [{ count: 1, list: [{ primitiveId: 'pad-reference', parentId: { id: 'category-reference' } }] }];
	const referencePage = await handlePcbDrcCheckTask({});
	assert.deepEqual(referencePage.errors[0].list[0].parentId, { id: 'category-reference' });
	assert.equal(referencePage.serializationTruncated, false, '完整保留 parentId 描述时无需报告截断');

	let deeplyGrouped = { primitiveId: 'deep-pad' };
	for (let depth = 0; depth < 2000; depth += 1)
		deeplyGrouped = { count: 1, list: [deeplyGrouped] };
	globalThis.eda.pcb_Drc.check = async () => [deeplyGrouped];
	const deepPage = await handlePcbDrcCheckTask({});
	assert.equal(deepPage.serializationTruncated, true);
	assert.equal(deepPage.nativeTruncated, false, '分类深度限制应报告序列化截断');
	assert.equal(deepPage.returnedDetails, 0);
	assert.equal(deepPage.nextOffset, undefined);

	const denseItems = Array.from({ length: 130 }, (_, index) => ({
		primitiveId: `error-${index}`,
		primitives: [0, 1].map(primitiveIndex => Object.fromEntries(Array.from({ length: 25 }, (_, fieldIndex) => [`property${fieldIndex}`, index + primitiveIndex + fieldIndex]))),
	}));
	globalThis.eda.pcb_Drc.check = async () => [{ name: 'Clearance Error', count: denseItems.length, list: denseItems }];
	let detailOffset = 0;
	const receivedIds = [];
	do {
		const page = JSON.parse(JSON.stringify(await toSerializableAsync(await handlePcbDrcCheckTask({ offset: detailOffset, limit: 120 }))));
		assert.equal(page.totalAvailableDetails, denseItems.length);
		assert.equal(page.errors[0].name, 'Clearance Error');
		assert.equal(page.errors[0].list.length, page.returnedDetails);
		assert.ok(page.returnedDetails > 0);
		for (const detail of page.errors[0].list) {
			assert.equal(typeof detail, 'object', 'pagination must not count budget placeholders as transmitted details');
			assert.equal(Object.keys(detail.primitives[1]).length, 25);
			receivedIds.push(detail.primitiveId);
		}
		if (page.nextOffset !== undefined)
			assert.equal(page.nextOffset, detailOffset + page.returnedDetails);
		detailOffset = page.nextOffset;
	} while (detailOffset !== undefined);
	assert.deepEqual(receivedIds, denseItems.map(item => item.primitiveId), 'all native detail identities survive pagination without skipped items');

	const cycle = { primitiveId: 'cyclic-pad' };
	cycle.parent = cycle;
	globalThis.eda.pcb_Drc.check = async () => [{ count: 1, list: [cycle] }];
	const bounded = JSON.parse(JSON.stringify(await toSerializableAsync(await handlePcbDrcCheckTask({}))));
	assert.equal(bounded.errors[0].list[0].primitiveId, 'cyclic-pad');
	assert.equal(bounded.serializationTruncated, true);
	assert.equal(bounded.truncated, true);
	await assert.rejects(handlePcbDrcCheckTask({ limit: 501 }), /limit/);
	console.log('Native error diagnostics and DRC transport readback tests passed');
}
main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
