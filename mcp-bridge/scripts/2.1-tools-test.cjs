const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ moduleResolution: 'node' });
require('ts-node/register/transpile-only');

const { handleManufactureExportTask } = require('../src/mcp/manufacture-export-handler.ts');
const { handleNetlistCompareTask } = require('../src/mcp/netlist-compare-handler.ts');
const { handlePcbConstraintsQueryTask } = require('../src/mcp/pcb-constraints-handler.ts');
const { handlePcbDrcCheckTask } = require('../src/mcp/pcb-drc-handler.ts');
const { handleProjectInfoTask } = require('../src/mcp/project-info-handler.ts');
const { handleSchematicDrcCheckTask } = require('../src/mcp/schematic-drc-handler.ts');

async function main() {
	const routingCalls = 0;
	globalThis.eda = {
		dmt_Project: { async getCurrentProjectInfo() { return { uuid: 'project-1', name: '2026' }; } },
		dmt_Board: { async getCurrentBoardInfo() { return { uuid: 'board-1' }; } },
		dmt_Schematic: {
			async getCurrentSchematicInfo() { return { uuid: 'sch-1' }; },
			async getCurrentSchematicAllSchematicPagesInfo() { return [{ uuid: 'page-1' }]; },
		},
		dmt_Pcb: { async getCurrentPcbInfo() { return { uuid: 'pcb-1' }; } },
		dmt_SelectControl: { async getCurrentDocumentInfo() { return { documentType: 1, uuid: 'page-1' }; } },
		pcb_Drc: {
			async check() { return [{ code: 'clearance' }]; },
			async getAllDifferentialPairs() { return [{ name: 'USB_P', positiveNet: 'D+', negativeNet: 'D-' }]; },
		},
		sch_Drc: { async check() { return []; } },
		sys_Tool: {
			async netlistComparison(a, b) {
				assert.equal(a, 'pcb-1');
				assert.deepEqual(b, { projectUuid: 'project-1', documentUuid: 'pcb-2' });
				return [{ type: 'Net', object: 'N1' }];
			},
		},
		pcb_ManufactureData: {
			async getBomFile() { return new Blob(['ref,value\nR1,1k\n'], { type: 'text/csv' }); },
		},
	};

	const project = await handleProjectInfoTask({ includePages: true });
	assert.equal(project.project.name, '2026');
	assert.equal(project.schematicPages.length, 1);
	const pcbDrc = await handlePcbDrcCheckTask({});
	assert.equal(pcbDrc.errorCount, 1);
	const schDrc = await handleSchematicDrcCheckTask({});
	assert.equal(schDrc.ok, true);
	const constraints = await handlePcbConstraintsQueryTask({ kind: 'differential_pairs' });
	assert.equal(constraints.count, 1);
	const comparison = await handleNetlistCompareTask({ sourceA: 'pcb-1', sourceB: { projectUuid: 'project-1', documentUuid: 'pcb-2' } });
	assert.equal(comparison.differenceCount, 1);
	const exportResult = await handleManufactureExportTask({ domain: 'pcb', kind: 'bom', includeData: true });
	assert.equal(exportResult.ok, true);
	assert.equal(exportResult.file.type, 'text/csv');
	assert.ok(typeof exportResult.file.dataBase64 === 'string');
	assert.equal(routingCalls, 0);
	console.log('2.1 tool handler tests passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
