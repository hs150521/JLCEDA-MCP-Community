const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');
const { handleManufactureExportTask: exportFile } = require('../src/mcp/manufacture-export-handler.ts');

async function main() {
	const calls = [];
	let resultFile = new File([Uint8Array.of(1, 2, 3)], 'diagram.png', { type: 'image/png' });
	const api = {
		async getPngFile(...args) {
			assert.equal(this, api);
			calls.push({ method: 'getPngFile', args });
			return resultFile;
		},
		async getSvgFile(...args) {
			assert.equal(this, api);
			calls.push({ method: 'getSvgFile', args });
			return resultFile;
		},
		async getExportDocumentFile(...args) {
			calls.push({ method: 'getExportDocumentFile', args });
			return resultFile;
		},
	};
	globalThis.eda = { sch_ManufactureData: api };
	let result = await exportFile({ domain: 'schematic', kind: 'png', includeData: true });
	assert.deepEqual(calls.pop(), { method: 'getPngFile', args: [undefined, undefined] });
	assert.equal(result.ok, true);
	assert.deepEqual(result.file, { kind: 'file', name: 'diagram.png', type: 'image/png', size: 3, dataBase64: 'AQID', encoding: 'base64' });

	for (const resolution of [{ width: 1 }, { height: 4096 }, { width: 2048, height: 1024 }]) {
		result = await exportFile({ domain: 'schematic', kind: 'png', fileName: ' diagram ', resolution });
		assert.equal(result.ok, true);
		assert.deepEqual(calls.pop(), { method: 'getPngFile', args: ['diagram', resolution] });
		assert.equal(result.file.dataBase64, undefined);
	}

	for (const resolution of [null, [], {}, '2048', { width: 0 }, { width: -1 }, { width: 4097 }, { width: 1.5 }, { width: Infinity }, { height: Number.NaN }, { width: '2048' }, { width: undefined }, { width: 100, depth: 100 }]) {
		await assert.rejects(exportFile({ domain: 'schematic', kind: 'png', resolution }), /resolution/);
		assert.equal(calls.length, 0, 'invalid dimensions fail before invoking the native export');
	}
	for (const payload of [
		{ domain: 'schematic', kind: 'svg', resolution: { width: 100 } },
		{ domain: 'schematic', kind: 'png', fileType: 'PNG' },
		{ domain: 'schematic', kind: 'svg', documentScope: 'Current Schematic Page' },
		{ domain: 'pcb', kind: 'png' },
		{ domain: 'pcb', kind: 'svg' },
	]) {
		await assert.rejects(exportFile(payload), /not supported|Unsupported/);
		assert.equal(calls.length, 0, 'unsupported fields and domains do not call the native API');
	}

	resultFile = new File(['<svg/>'], 'diagram.svg', { type: 'image/svg+xml' });
	result = await exportFile({ domain: 'schematic', kind: 'svg', fileName: 'diagram', includeData: true });
	assert.deepEqual(calls.pop(), { method: 'getSvgFile', args: ['diagram'] });
	assert.equal(result.ok, true);
	assert.equal(result.file.type, 'image/svg+xml');
	assert.equal(Buffer.from(result.file.dataBase64, 'base64').toString(), '<svg/>');

	resultFile = new File(['zip'], 'schematic.zip', { type: 'application/zip' });
	for (const kind of ['png', 'svg']) {
		result = await exportFile({ domain: 'schematic', kind });
		assert.equal(result.ok, true);
		assert.equal(result.file.name, 'schematic.zip', 'multi-page native ZIP results preserve their actual name and MIME type');
		assert.equal(result.file.type, 'application/zip');
		calls.pop();
	}
	result = await exportFile({ domain: 'schematic', kind: 'document', fileName: 'legacy', fileType: 'SVG', documentScope: 'Current Schematic Page' });
	assert.equal(result.ok, true);
	assert.deepEqual(calls.pop(), { method: 'getExportDocumentFile', args: ['legacy', 'SVG', undefined, 'Current Schematic Page'] }, 'legacy document export remains compatible');

	resultFile = undefined;
	result = await exportFile({ domain: 'schematic', kind: 'png' });
	assert.equal(result.ok, false, 'cancellation or missing native output is not a successful export');
	calls.pop();
	for (const version of ['3.2.182', '4.0.99', '4.1.22']) {
		globalThis.eda.sys_Environment = { getEditorCurrentVersion: () => version };
		for (const kind of ['png', 'svg']) {
			result = await exportFile({ domain: 'schematic', kind });
			assert.equal(result.errorCode, 'EDA_VERSION_UNSUPPORTED');
			assert.equal(result.nativeCallAttempted, false);
			assert.equal(calls.length, 0, 'unsupported release versions are rejected before native RPC');
		}
	}
	for (const version of ['3.2.183', '4.1.23', '4.2.0']) {
		globalThis.eda.sys_Environment = { getEditorCurrentVersion: () => version };
		await exportFile({ domain: 'schematic', kind: 'png' });
		assert.equal(calls.pop().method, 'getPngFile');
	}
	delete globalThis.eda.sys_Environment;
	globalThis.eda.sch_ManufactureData = {};
	for (const kind of ['png', 'svg'])
		await assert.rejects(exportFile({ domain: 'schematic', kind }), /API is unavailable in this client version/);
	assert.equal(calls.length, 0);
	console.log('EDA v4 schematic PNG/SVG export regressions passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
