const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');

const apiDocument = require('../resources/jlceda-pro-api-doc.json');
const { editorVersionSupports } = require('../src/mcp/api-version.ts');
const { handleDesignArchiveExportTask } = require('../src/mcp/design-archive-export-handler.ts');
const { handleDesignCompareTask } = require('../src/mcp/design-compare-handler.ts');
const { handleApiInvokeTask } = require('../src/mcp/invoke-handler.ts');

const archiveBytes = Buffer.from('schematic archive: 原理图\u0000\u00FF', 'utf8');

function setup(version) {
	const fixture = { calls: [], comparisonResult: { success: true, data: { changed: 2 } }, archive: new File([archiveBytes], 'schematic.epro2', { type: 'application/octet-stream' }) };
	globalThis.eda = {
		sys_Environment: { getEditorCurrentVersion() { return version; } },
		sys_FileSystem: {
			async getExtensionFile(uri) {
				assert.equal(uri, '/resources/jlceda-pro-api-doc.json');
				return {
					async text() { return JSON.stringify(apiDocument); },
				};
			},
		},
		dmt_Project: {
			async waitForReady(...args) {
				assert.equal(this, globalThis.eda.dmt_Project);
				fixture.calls.push({ method: 'waitForReady', args });
				return true;
			},
		},
		sys_Tool: {
			async schematicComparison(...args) {
				fixture.calls.push({ method: 'schematicComparison', args });
				return fixture.comparisonResult;
			},
			async pcbComparison(...args) {
				fixture.calls.push({ method: 'pcbComparison', args });
				return fixture.comparisonResult;
			},
		},
		sys_FileManager: {
			async getSchematicFile(...args) {
				fixture.calls.push({ method: 'getSchematicFile', args });
				return fixture.archive;
			},
		},
	};
	return fixture;
}

function assertUnsupported(result, fixture, apiFullName) {
	assert.equal(result.ok, false);
	assert.equal(result.errorCode, 'EDA_VERSION_UNSUPPORTED');
	assert.equal(result.apiFullName, apiFullName);
	assert.equal(result.commitStatus, 'not_started');
	assert.equal(result.nativeCallAttempted, false);
	assert.equal(fixture.calls.length, 0, '不支持的版本必须在原生调用前拒绝');
}

async function main() {
	const dualMinimums = ['3.2.205', '4.1.62'];
	for (const [version, expected] of [
		['3.2.204', false],
		['3.2.205', true],
		['3.2.999', true],
		['3.3.0', true],
		['4.0.999', false],
		['4.1.61', false],
		['v4.1.62', true],
		['4.1.78', true],
		['4.2.0', true],
		['5.0.0', true],
		['2.99.999', false],
		['unknown', undefined],
	]) {
		assert.equal(editorVersionSupports(version, dualMinimums), expected, version);
	}
	assert.equal(editorVersionSupports('3.99.999', ['4.1.79']), false, 'v4 专用能力不能因 v3 的次版本较大而通过');
	assert.equal(editorVersionSupports('4.1.79-beta.1', ['4.1.79']), true);
	assert.equal(editorVersionSupports('4.1.78', []), undefined);
	assert.equal(editorVersionSupports('4.1.78', ['unknown']), undefined);

	const waitForReady = apiDocument.projections.callableApis.find(item => item.fullName === 'eda.dmt_Project.waitForReady');
	assert.deepEqual(waitForReady.minimumEditorVersions, ['4.1.79'], '版本防线应读取实际打包的离线 API 元数据');
	for (const version of ['3.2.999', '4.1.78']) {
		const fixture = setup(version);
		const result = await handleApiInvokeTask({ apiFullName: 'eda.dmt_Project.waitForReady', args: ['project-1', 500] });
		assertUnsupported(result, fixture, 'eda.dmt_Project.waitForReady');
		assert.deepEqual(result.minimumEditorVersions, ['4.1.79']);
	}
	for (const version of ['4.1.79', '4.2.0']) {
		const fixture = setup(version);
		const result = await handleApiInvokeTask({ apiFullName: 'eda.dmt_Project.waitForReady', args: ['project-1', 500] });
		assert.equal(result.result, true);
		assert.deepEqual(fixture.calls, [{ method: 'waitForReady', args: ['project-1', 500] }]);
	}

	for (const domain of ['schematic', 'pcb']) {
		for (const version of ['3.2.204', '4.1.61']) {
			const fixture = setup(version);
			const result = await handleDesignCompareTask({ domain, sourceA: 'document-a', sourceB: 'document-b' });
			assertUnsupported(result, fixture, `eda.sys_Tool.${domain}Comparison`);
		}
		for (const version of ['3.2.205', '4.1.62']) {
			const fixture = setup(version);
			const result = await handleDesignCompareTask({ domain, sourceA: ' document-a ', sourceB: 'document-b' });
			assert.equal(result.ok, true);
			assert.deepEqual(result.result, fixture.comparisonResult);
			assert.deepEqual(fixture.calls, [{ method: `${domain}Comparison`, args: ['document-a', 'document-b'] }]);
		}
	}
	let fixture = setup('4.1.78');
	for (const payload of [
		{ domain: 'schematic', sourceA: { projectUuid: 'project-1', schematicUuid: 'sch-a' }, sourceB: 'sch-b' },
		{ domain: 'schematic', sourceA: 'sch-a', sourceB: { projectUuid: 'project-1', schematicUuid: 'sch-b' } },
		{ domain: 'schematic', sourceA: 'sch-a', sourceB: 'sch-b', options: {} },
	]) {
		await assert.rejects(handleDesignCompareTask(payload), /UUID|options/);
	}
	assert.equal(fixture.calls.length, 0);
	for (const nativeResult of [{ success: false, error: { code: 'INCOMPATIBLE' } }, { changed: 2 }, { success: 'true' }, null]) {
		fixture.comparisonResult = nativeResult;
		const result = await handleDesignCompareTask({ domain: 'schematic', sourceA: 'sch-a', sourceB: 'sch-b' });
		assert.equal(result.ok, false, '比较成功必须来自原生 success:true');
		assert.deepEqual(result.result, nativeResult);
	}

	fixture = setup('4.1.78');
	const options = { valUnit: 'mm', deviation: 0.1, comparisonSize: 12 };
	const pcbSource = { projectUuid: ' project-1 ', pcbUuid: ' pcb-b ' };
	const pcb = await handleDesignCompareTask({ domain: 'pcb', sourceA: 'pcb-a', sourceB: pcbSource, options });
	assert.equal(pcb.ok, true);
	assert.deepEqual(fixture.calls, [{ method: 'pcbComparison', args: ['pcb-a', { projectUuid: 'project-1', pcbUuid: 'pcb-b' }, options] }]);
	for (const invalid of [null, [], { valUnit: 'in' }, { valUnit: ['mm'] }, { deviation: 0 }, { deviation: -1 }, { deviation: '1' }, { deviation: Infinity }, { comparisonSize: 0 }, { comparisonSize: Number.NaN }, { comparisonSize: -1 }, { unknown: true }]) {
		fixture = setup('4.1.78');
		await assert.rejects(handleDesignCompareTask({ domain: 'pcb', sourceA: 'pcb-a', sourceB: 'pcb-b', options: invalid }), /options|option/);
		assert.equal(fixture.calls.length, 0, `非法选项不得调用原生比较：${JSON.stringify(invalid)}`);
	}

	for (const version of ['3.2.182', '4.1.22']) {
		fixture = setup(version);
		assertUnsupported(await handleDesignArchiveExportTask({ action: 'schematic' }), fixture, 'eda.sys_FileManager.getSchematicFile');
	}
	for (const version of ['3.2.183', '4.1.23']) {
		fixture = setup(version);
		const result = await handleDesignArchiveExportTask({ action: 'schematic', fileName: ' schematic ', fileType: 'epro2', includeData: true });
		assert.equal(result.ok, true);
		assert.equal(result.action, 'schematic');
		assert.deepEqual(fixture.calls, [{ method: 'getSchematicFile', args: ['schematic', undefined, 'epro2'] }]);
		assert.equal(result.archive.encoding, 'base64');
		assert.equal(result.archive.size, archiveBytes.length);
		assert.deepEqual(Buffer.from(result.archive.dataBase64, 'base64'), archiveBytes);
	}
	fixture = setup('4.1.78');
	const metadataOnly = await handleDesignArchiveExportTask({ action: 'schematic' });
	assert.equal(metadataOnly.archive.dataBase64, undefined);
	assert.deepEqual(fixture.calls[0].args, [undefined, undefined, undefined]);
	fixture = setup('4.1.78');
	await assert.rejects(handleDesignArchiveExportTask({ action: 'schematic', fileType: 'zip' }), /fileType/);
	assert.equal(fixture.calls.length, 0);
	fixture.archive = undefined;
	const unavailable = await handleDesignArchiveExportTask({ action: 'schematic' });
	assert.deepEqual([unavailable.ok, unavailable.archive], [false, null]);

	console.log('EDA v4 compatibility and version guard tests passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
