const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');
const { handlePcbDrcCheckTask } = require('../src/mcp/pcb-drc-handler.ts');
const { toSerializableAsync, toSafeErrorDetails, toSafeErrorMessage } = require('../src/utils.ts');

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
