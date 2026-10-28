const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');

const { handleLibraryClassificationTask } = require('../src/mcp/library-classification-handler.ts');

async function main() {
	let legacyCalls = 0;
	let modernCalls = 0;
	const modernTree = [
		{ name: '模拟', children: [{ name: '放大器', children: [{ name: '低噪声' }] }] },
		{ name: '数字', children: [{ name: '放大器' }] },
	];
	globalThis.eda = {
		lib_Classification: {
			async getClassificationTree(...args) {
				assert.equal(this, globalThis.eda.lib_Classification);
				assert.deepEqual(args, ['library-1', '3']);
				modernCalls++;
				return modernTree;
			},
			async getAllClassificationTree() {
				legacyCalls++;
				return [{ name: '旧分类', uuid: 'old' }];
			},
		},
	};
	const query = { kind: 'device', libraryUuid: 'library-1' };
	const result = await handleLibraryClassificationTask(query);
	assert.equal(modernCalls, 1);
	assert.equal(legacyCalls, 0, 'prefer the v4 name-based API even when the legacy stub exists');
	assert.equal(result.total, 5);
	assert.equal(result.returned, 5);
	assert.equal(result.truncated, false);
	assert.equal(result.classificationApi, 'getClassificationTree');
	assert.equal(Object.hasOwn(result, 'fallbackReason'), false);
	assert.deepEqual(result.tree[0].children[0].children[0].namePath, ['模拟', '放大器', '低噪声']);
	assert.deepEqual(result.tree[1].children[0].namePath, ['数字', '放大器']);
	assert.equal(Object.hasOwn(result.tree[0], 'uuid'), false, 'modern identities must not invent UUIDs');
	assert.equal(Object.hasOwn(modernTree[0], 'namePath'), false, 'reading must not modify the native result');
	const depthLimited = await handleLibraryClassificationTask({ ...query, maxDepth: 1 });
	assert.equal(depthLimited.returned, 2);
	assert.equal(depthLimited.truncated, true);
	assert.equal(depthLimited.tree[0].children, undefined);
	const nodeLimited = await handleLibraryClassificationTask({ ...query, maxNodes: 2 });
	assert.equal(nodeLimited.returned, 2);
	assert.equal(nodeLimited.truncated, true);
	assert.deepEqual(nodeLimited.tree[0].children[0].namePath, ['模拟', '放大器']);

	globalThis.eda.lib_Classification.getClassificationTree = async () => {
		throw new Error('permission denied');
	};
	await assert.rejects(handleLibraryClassificationTask(query), /permission denied/);
	assert.equal(legacyCalls, 0, 'permission or runtime errors must not silently switch API semantics');
	globalThis.eda.lib_Classification.getClassificationTree = async () => [{ name: 'broken', uuid: 42 }];
	await assert.rejects(handleLibraryClassificationTask(query), /invalid classification node/);
	globalThis.eda.lib_Classification.getClassificationTree = async () => undefined;
	await assert.rejects(handleLibraryClassificationTask(query), /getClassificationTree returned an invalid result/);
	assert.equal(legacyCalls, 0, 'invalid modern results must not fall back');

	globalThis.eda.lib_Classification.getClassificationTree = async function (...args) {
		assert.equal(this, globalThis.eda.lib_Classification);
		assert.deepEqual(args, ['library-1', '4']);
		return [];
	};
	globalThis.eda.lib_Classification.getAllClassificationTree = async function (...args) {
		assert.equal(this, globalThis.eda.lib_Classification);
		assert.deepEqual(args, ['library-1', '4']);
		return Array.from({ length: 8654 }, (_, index) => ({ name: index === 0 ? 'All' : `Footprint-${index}`, uuid: `legacy-${index}` }));
	};
	const emptyModernFallback = await handleLibraryClassificationTask({ ...query, kind: 'footprint', maxNodes: 2 });
	assert.equal(emptyModernFallback.classificationApi, 'getAllClassificationTree');
	assert.equal(emptyModernFallback.fallbackReason, 'modern_tree_empty');
	assert.equal(emptyModernFallback.total, 8654);
	assert.equal(emptyModernFallback.returned, 2);
	assert.equal(emptyModernFallback.truncated, true);
	assert.deepEqual(emptyModernFallback.tree[1], { name: 'Footprint-1', namePath: ['Footprint-1'], uuid: 'legacy-1' });
	globalThis.eda.lib_Classification.getAllClassificationTree = async () => [];
	const bothEmpty = await handleLibraryClassificationTask({ ...query, kind: 'footprint' });
	assert.equal(bothEmpty.classificationApi, 'getClassificationTree');
	assert.equal(Object.hasOwn(bothEmpty, 'fallbackReason'), false);
	assert.deepEqual(bothEmpty.tree, []);
	assert.equal(bothEmpty.total, 0);
	assert.equal(bothEmpty.truncated, false);
	globalThis.eda.lib_Classification.getAllClassificationTree = async () => undefined;
	await assert.rejects(handleLibraryClassificationTask({ ...query, kind: 'footprint' }), /getAllClassificationTree returned an invalid result/);
	globalThis.eda.lib_Classification.getAllClassificationTree = async () => {
		throw new Error('legacy permission denied');
	};
	await assert.rejects(handleLibraryClassificationTask({ ...query, kind: 'footprint' }), /legacy permission denied/);
	delete globalThis.eda.lib_Classification.getAllClassificationTree;
	const modernEmptyOnly = await handleLibraryClassificationTask({ ...query, kind: 'footprint' });
	assert.equal(modernEmptyOnly.classificationApi, 'getClassificationTree');
	assert.equal(Object.hasOwn(modernEmptyOnly, 'fallbackReason'), false);
	assert.deepEqual(modernEmptyOnly.tree, []);

	delete globalThis.eda.lib_Classification.getClassificationTree;
	globalThis.eda.lib_Classification.getAllClassificationTree = async function (...args) {
		assert.equal(this, globalThis.eda.lib_Classification);
		assert.deepEqual(args, ['library-1', '4']);
		legacyCalls++;
		return [{ name: '连接器', uuid: 'legacy-root', children: [{ name: '排针', uuid: 'legacy-child' }] }];
	};
	const legacy = await handleLibraryClassificationTask({ ...query, kind: 'footprint' });
	assert.equal(legacyCalls, 1);
	assert.equal(legacy.classificationApi, 'getAllClassificationTree');
	assert.equal(legacy.fallbackReason, 'modern_api_unavailable');
	assert.equal(legacy.tree[0].uuid, 'legacy-root');
	assert.equal(legacy.tree[0].children[0].uuid, 'legacy-child');
	assert.deepEqual(legacy.tree[0].children[0].namePath, ['连接器', '排针']);
	delete globalThis.eda.lib_Classification.getAllClassificationTree;
	await assert.rejects(handleLibraryClassificationTask(query), /APIs are unavailable/);
	console.log('v4 library classification compatibility tests passed.');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
