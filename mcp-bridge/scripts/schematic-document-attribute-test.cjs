const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');

const { handleSchematicDocumentTask } = require('../src/mcp/schematic-document-handler.ts');
const { toSerializableAsync } = require('../src/utils.ts');

class Attribute {
	constructor() {
		Object.assign(this, { primitiveType: 'Attribute', primitiveId: 'name-attribute', parentPrimitiveId: 'netport', key: 'Name', value: 'TEST_NET', x: 20, y: 10, alignMode: 2 });
	}

	getState_PrimitiveType() { return this.primitiveType; }
	getState_PrimitiveId() { return this.primitiveId; }
	getState_ParentPrimitiveId() { return this.parentPrimitiveId; }
	getState_Key() { return this.key; }
	getState_Value() { return this.value; }
	getState_X() { return this.x; }
	getState_Y() { return this.y; }
	getState_AlignMode() { return this.alignMode; }
}

const attributes = [new Attribute()];
const raw = new Map([
	['netport', { primitiveId: 'netport', primitiveType: 'Component', componentType: 'netport', net: 'TEST_NET' }],
	['name-attribute', { primitiveId: 'name-attribute', primitiveType: 'Text', content: 'TEST_NET', x: 20, y: 10 }],
	['standalone-text', { primitiveId: 'standalone-text', primitiveType: 'Text', content: 'TEST_NET', x: 30, y: 20 }],
]);
let attributeReads = 0;
let attributeListReads = 0;
const attributeRequests = [];
globalThis.eda = {
	sch_Document: {},
	sch_SelectControl: {},
	sch_PrimitiveAttribute: {
		async get(ids) {
			assert.ok(Array.isArray(ids), 'use the native Attribute.get array overload');
			attributeReads += 1;
			attributeRequests.push([...ids]);
			return ids.map(id => attributes.find(item => item.primitiveId === id) ?? raw.get(id)).filter(Boolean).reverse();
		},
		async getAll(parentId) {
			attributeListReads += 1;
			return parentId === 'netport' ? attributes : [];
		},
	},
	sch_Primitive: {
		async getPrimitiveTypeByPrimitiveId(id) { return raw.get(id)?.primitiveType; },
		async getPrimitiveByPrimitiveId(id) { return raw.get(id); },
		async getPrimitivesByPrimitiveId(ids) { return ids.map(id => raw.get(id)).filter(Boolean); },
	},
};

async function main() {
	const selected = process.argv[2] || 'all';
	if (selected === 'type' || selected === 'all') {
		const result = await handleSchematicDocumentTask({ action: 'primitive_type_by_id', id: 'name-attribute' });
		assert.equal(result.primitiveType, 'Attribute', 'the bound Name primitive must not be classified as independent Text');
	}
	if (selected === 'single' || selected === 'all') {
		const result = await handleSchematicDocumentTask({ action: 'primitive_by_id', id: 'name-attribute' });
		assert.equal(result.primitive.primitiveType, 'Attribute');
		assert.equal(result.primitive.key, 'Name');
		assert.equal(result.primitive.parentPrimitiveId, 'netport');
		assert.equal(result.primitive.value, 'TEST_NET');
		assert.equal(result.primitive.alignMode, 2);
	}
	if (selected === 'batch' || selected === 'all') {
		const beforeReads = attributeReads;
		const result = await toSerializableAsync(await handleSchematicDocumentTask({ action: 'primitives_by_id', ids: ['netport', 'name-attribute', 'standalone-text', 'name-attribute'] }));
		assert.equal(result.primitives[1].primitiveType, 'Attribute');
		assert.equal(result.primitives[1].key, 'Name');
		assert.equal(result.primitives[1].parentPrimitiveId, 'netport');
		assert.deepEqual(result.primitives[2], raw.get('standalone-text'), 'real Text remains independent even if its displayed content matches the NetPort Name');
		assert.deepEqual(result.primitives[3], result.primitives[1], 'repeated IDs remain serializable');
		assert.equal(result.primitives[0].componentType, 'netport');
		assert.equal(attributeReads - beforeReads, 1, 'one native attribute read resolves a whole batch');
		assert.deepEqual(attributeRequests.at(-1), ['name-attribute', 'standalone-text'], 'query only unique candidate IDs');
		assert.equal(attributeListReads, 0, 'unscoped Attribute.getAll omits parent-owned attributes and must not be used when get exists');
	}
	assert.equal((await handleSchematicDocumentTask({ action: 'primitive_type_by_id', id: 'standalone-text' })).primitiveType, 'Text');
	assert.equal((await handleSchematicDocumentTask({ action: 'primitive_by_id', id: 'missing' })).primitive, undefined);
	const attributeApi = globalThis.eda.sch_PrimitiveAttribute;
	const savedGet = attributeApi.get;
	const savedGetAll = attributeApi.getAll;
	delete attributeApi.getAll;
	assert.equal((await handleSchematicDocumentTask({ action: 'primitive_type_by_id', id: 'name-attribute' })).primitiveType, 'Attribute', 'targeted resolution does not require getAll');
	attributeApi.get = async () => attributes;
	assert.equal((await handleSchematicDocumentTask({ action: 'primitive_type_by_id', id: 'standalone-text' })).primitiveType, 'Text', 'an attribute with another ID must not replace the requested Text');
	attributeApi.get = async () => [raw.get('name-attribute')];
	assert.equal((await handleSchematicDocumentTask({ action: 'primitive_type_by_id', id: 'name-attribute' })).primitiveType, 'Text', 'the same ID wrapped as native Text does not prove Attribute type');
	delete attributeApi.get;
	attributeApi.getAll = async () => attributes;
	const fallback = await handleSchematicDocumentTask({ action: 'primitive_by_id', id: 'name-attribute' });
	assert.equal(fallback.primitive.primitiveType, 'Attribute', 'older runtimes without get retain the getAll fallback');
	assert.equal(fallback.primitive.parentPrimitiveId, 'netport');
	attributeApi.get = savedGet;
	attributeApi.getAll = savedGetAll;
	console.log('Schematic bound attribute inspection tests passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
