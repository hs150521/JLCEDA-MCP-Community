const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ moduleResolution: 'node' });
require('ts-node/register/transpile-only');

const { handleComponentSelectTask } = require('../src/mcp/component-select-handler.ts');
const { handleDesignCompareTask } = require('../src/mcp/design-compare-handler.ts');
const { handleManufactureExportTask } = require('../src/mcp/manufacture-export-handler.ts');
const { handleManufactureTemplatesQueryTask } = require('../src/mcp/manufacture-template-handler.ts');
const { handleNetlistCompareTask } = require('../src/mcp/netlist-compare-handler.ts');
const { handlePcbConstraintsQueryTask } = require('../src/mcp/pcb-constraints-handler.ts');
const { handlePcbDrcCheckTask } = require('../src/mcp/pcb-drc-handler.ts');
const { handlePcbLayerQueryTask } = require('../src/mcp/pcb-layer-handler.ts');
const { handlePcbRealtimeDrcTask } = require('../src/mcp/pcb-realtime-drc-handler.ts');
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
		lib_Device: {
			async search() { return []; },
			async searchByProperties(properties) {
				assert.equal(properties.supplierId, 'C1523');
				return [{ uuid: 'device-1', name: 'R0402', supplierId: 'C1523' }];
			},
		},
		lib_LibrariesList: { async getSystemLibraryUuid() { return 'system-library-1'; } },
		pcb_Drc: {
			async check() { return [{ code: 'clearance', count: 2 }]; },
			async getAllDifferentialPairs() { return [{ name: 'USB_P', positiveNet: 'D+', negativeNet: 'D-' }]; },
			async getRealTimeDrcStatus() { return false; },
			async startRealTimeDrc() { return true; },
			async stopRealTimeDrc() { return true; },
		},
		pcb_Layer: {
			async getAllLayers() { return [{ id: 1, name: 'TOP', type: 'SIGNAL' }]; },
			async getCurrentLayer() { return { id: 1, name: 'TOP' }; },
			async getTheNumberOfCopperLayers() { return 2; },
			async getCurrentPhysicalStackingConfigurationName() { return '2 Layer'; },
			async getCurrentPhysicalStackingConfiguration() { return { name: '2 Layer', layerCount: 2 }; },
			async getAllPhysicalStackingConfigurations() { return [{ name: '2 Layer', layerCount: 2 }]; },
			async getPhysicalStackingConfiguration(name) { return { name, layerCount: 2 }; },
		},
		sch_Drc: { async check() { return []; } },
		sys_Tool: {
			async netlistComparison(a, b) {
				if (a === 'net-1') {
					assert.deepEqual(b, { projectUuid: 'project-1', documentUuid: 'net-2' });
				}
				else {
					assert.equal(a, 'pcb-1');
					assert.deepEqual(b, { projectUuid: 'project-1', documentUuid: 'pcb-2' });
				}
				return [{ type: 'Net', object: 'N1' }];
			},
			async schematicComparison(a, b) {
				assert.equal(a, 'sch-1');
				assert.equal(b, 'sch-2');
				return { changed: 2 };
			},
			async pcbComparison(a, b, options) {
				assert.equal(a, 'pcb-1');
				assert.deepEqual(b, { projectUuid: 'project-1', pcbUuid: 'pcb-2' });
				assert.equal(options.deviation, 1);
				return { success: true, data: { changed: 3 } };
			},
		},
		pcb_ManufactureData: {
			async getBomFile(fileName, fileType, template) {
				assert.equal(fileName, undefined);
				assert.equal(fileType, undefined);
				assert.equal(template, 'jlcpcb');
				return new Blob(['ref,value\nR1,1k\n'], { type: 'text/csv' });
			},
			async getBomTemplates() { return ['jlcpcb', 'assembly']; },
			async getAutoRouteJsonFileForJRouter() { return new Blob(['{"routes":[]}'], { type: 'application/json' }); },
		},
		sch_ManufactureData: {
			async getBomTemplates() { return ['schematic-default']; },
		},
	};

	const project = await handleProjectInfoTask({ includePages: true });
	assert.equal(project.project.name, '2026');
	assert.equal(project.schematicPages.length, 1);
	const pcbDrc = await handlePcbDrcCheckTask({});
	assert.equal(pcbDrc.errorCount, 2);
	const layers = await handlePcbLayerQueryTask({ kind: 'layers' });
	assert.equal(layers.copperLayerCount, 2);
	const stacking = await handlePcbLayerQueryTask({ kind: 'physical_stacking', configurationName: '2 Layer' });
	assert.equal(stacking.selected.name, '2 Layer');
	const realtimeDrc = await handlePcbRealtimeDrcTask({ action: 'status' });
	assert.equal(realtimeDrc.enabled, false);
	const realtimeDrcStart = await handlePcbRealtimeDrcTask({ action: 'start' });
	assert.equal(realtimeDrcStart.changed, true);
	const schDrc = await handleSchematicDrcCheckTask({});
	assert.equal(schDrc.ok, true);
	const constraints = await handlePcbConstraintsQueryTask({ kind: 'differential_pairs' });
	assert.equal(constraints.count, 1);
	const exactComponent = await handleComponentSelectTask({ properties: { supplierId: 'C1523' }, limit: 2 });
	assert.equal(exactComponent.searchMode, 'properties');
	assert.equal(exactComponent.selection.candidates[0].libraryUuid, 'system-library-1');
	const comparison = await handleNetlistCompareTask({ sourceA: 'pcb-1', sourceB: { projectUuid: 'project-1', documentUuid: 'pcb-2' } });
	assert.equal(comparison.differenceCount, 1);
	const schematicComparison = await handleDesignCompareTask({ domain: 'schematic', sourceA: 'sch-1', sourceB: 'sch-2' });
	assert.equal(schematicComparison.result.changed, 2);
	const designNetlistComparison = await handleDesignCompareTask({ domain: 'netlist', sourceA: 'net-1', sourceB: { projectUuid: 'project-1', documentUuid: 'net-2' } });
	assert.equal(designNetlistComparison.differenceCount, 1);
	const pcbComparison = await handleDesignCompareTask({ domain: 'pcb', sourceA: 'pcb-1', sourceB: { projectUuid: 'project-1', pcbUuid: 'pcb-2' }, options: { deviation: 1 } });
	assert.equal(pcbComparison.result.data.changed, 3);
	await assert.rejects(
		handleDesignCompareTask({ domain: 'schematic', sourceA: 'sch-1', sourceB: 'sch-2', options: { deviation: 1 } }),
		/options is only supported for the pcb domain/,
	);
	const templates = await handleManufactureTemplatesQueryTask({ domain: 'pcb' });
	assert.deepEqual(templates.templates, ['jlcpcb', 'assembly']);
	const exportResult = await handleManufactureExportTask({ domain: 'pcb', kind: 'bom', template: 'jlcpcb', includeData: true });
	assert.equal(exportResult.ok, true);
	assert.equal(exportResult.file.type, 'text/csv');
	assert.ok(typeof exportResult.file.dataBase64 === 'string');
	const schematicTemplates = await handleManufactureTemplatesQueryTask({ domain: 'schematic' });
	assert.deepEqual(schematicTemplates.templates, ['schematic-default']);
	const jrouterExport = await handleManufactureExportTask({ domain: 'pcb', kind: 'auto_route_jrouter' });
	assert.equal(jrouterExport.ok, true);
	assert.equal(routingCalls, 0);
	console.log('2.1 tool handler tests passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
