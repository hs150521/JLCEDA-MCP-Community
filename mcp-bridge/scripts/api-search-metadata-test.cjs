const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');

const { getApiMetadata, handleApiSearchTask } = require('../src/mcp/api-search-handler.ts');

const documentText = fs.readFileSync(path.join(__dirname, '../resources/jlceda-pro-api-doc.json'), 'utf8');
const document = JSON.parse(documentText);
let reads = 0;
globalThis.eda = {
	sys_FileSystem: {
		async getExtensionFile(uri) {
			assert.equal(uri, '/resources/jlceda-pro-api-doc.json');
			reads++;
			return { text: async () => documentText };
		},
	},
};

async function main() {
	assert.deepEqual(document.typePackage, { name: '@jlceda/pro-api-types', version: '0.4.27' });
	assert.ok(document.projections.callableApis.every(item => item.kind !== 'constructor'));
	for (const privateMethod of ['searchBySupplierPart', 'fetchSupplierPartDevices', 'mapSupplierPartDevice']) {
		assert.equal(await getApiMetadata(`eda.lib_Device.${privateMethod}`), undefined);
	}
	assert.equal(await getApiMetadata('eda.sys_Window.removeEventsForExtension'), undefined);
	const ready = await getApiMetadata('  EDA.DMT_PROJECT.WAITFORREADY  ');
	assert.deepEqual(ready.minimumEditorVersions, ['4.1.79']);
	assert.equal(ready.stability, 'beta');
	assert.match(ready.remarks, /timeoutMs/);
	const png = await getApiMetadata('eda.sch_ManufactureData.getPngFile');
	assert.deepEqual(png.minimumEditorVersions, ['3.2.183', '4.1.23']);
	const ratline = await getApiMetadata('eda.pcb_Document.startCalculatingRatline');
	assert.equal(ratline.deprecated, true);
	assert.equal(ratline.deprecationMessage, 'since EDA v4.2');
	assert.equal(ratline.minimumEditorVersions, undefined, 'deprecation is not the introduction version');
	const result = await handleApiSearchTask({ query: 'waitForReady', scope: 'callable', owner: 'dmt_Project' });
	assert.deepEqual(result.typePackage, document.typePackage);
	const item = result.items.find(entry => entry.fullName === 'eda.dmt_Project.waitForReady');
	assert.deepEqual(item.minimumEditorVersions, ['4.1.79']);
	assert.equal(item.stability, 'beta');
	assert.equal(item.remarks, ready.remarks);
	assert.equal(reads, 1, 'metadata and search share one offline-document cache');
	console.log('API metadata and public catalog tests passed.');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
