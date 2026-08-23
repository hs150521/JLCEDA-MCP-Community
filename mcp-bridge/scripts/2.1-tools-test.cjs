const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ moduleResolution: 'node' });
require('ts-node/register/transpile-only');

const { handleComponentSelectTask } = require('../src/mcp/component-select-handler.ts');
const { handleDesignCompareTask } = require('../src/mcp/design-compare-handler.ts');
const { handleLibrarySearchTask } = require('../src/mcp/library-search-handler.ts');
const { handleManufactureExportTask } = require('../src/mcp/manufacture-export-handler.ts');
const { handleManufactureTemplatesQueryTask } = require('../src/mcp/manufacture-template-handler.ts');
const { handleSchematicNetQueryTask } = require('../src/mcp/net-query-handler.ts');
const { handleNetlistCompareTask } = require('../src/mcp/netlist-compare-handler.ts');
const { handlePcbConstraintsQueryTask } = require('../src/mcp/pcb-constraints-handler.ts');
const { handlePcbDocumentTask } = require('../src/mcp/pcb-document-handler.ts');
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
		sch_Net: {
			async getCurrentProjectAllNets() { return [{ net: 'VCC' }, { net: 'USB_D+' }]; },
			async getAllNetsName() { return ['VCC', 'USB_D+']; },
			async getNet(name) {
				assert.equal(name, 'USB_D+');
				return { net: name, length: 12 };
			},
		},
		dmt_Pcb: { async getCurrentPcbInfo() { return { uuid: 'pcb-1' }; } },
		pcb_Document: {
			async getCalculatingRatlineStatus() { return 'active'; },
			async getCanvasUpdateCalculationStatus() { return 'idle'; },
			async getCurrentFilterConfiguration() { return { tracks: true }; },
			async save() { return true; },
			async importChanges(uuid) {
				assert.equal(uuid, 'sch-1');
				return true;
			},
			async importAutoRouteJsonFile(file) {
				assert.equal(file.name, 'route.json');
				assert.equal(file.size, 2);
				return true;
			},
			async importAutoRouteSesFile(file) {
				assert.equal(file.name, 'route.ses');
				assert.equal(file.size, 2);
				return true;
			},
			async importAutoLayoutJsonFile(file) {
				assert.equal(file.name, 'layout.json');
				assert.equal(file.size, 2);
				return true;
			},
		},
		dmt_SelectControl: { async getCurrentDocumentInfo() { return { documentType: 1, uuid: 'page-1' }; } },
		lib_Device: {
			async search() { return []; },
			async searchByProperties(properties) {
				assert.equal(properties.supplierId, 'C1523');
				return [{ uuid: 'device-1', name: 'R0402', supplierId: 'C1523' }];
			},
			async getByLcscIds(ids, libraryUuid, allowMultiMatch) {
				assert.deepEqual(ids, ['C1523', 'C17168']);
				assert.equal(libraryUuid, undefined);
				assert.equal(allowMultiMatch, true);
				return [{ uuid: 'device-1', name: 'R0402', supplierId: 'C1523' }, { uuid: 'device-2', name: 'C17168', supplierId: 'C17168' }];
			},
		},
		lib_SimulationModel: {
			async search(keyword, libraryUuid, classification, modelType, limit, page) {
				assert.equal(keyword, 'LM358');
				assert.equal(libraryUuid, undefined);
				assert.equal(modelType, 'Ngspice');
				assert.equal(limit, 5);
				assert.equal(page, 1);
				return [{ uuid: 'model-1', name: 'LM358', type: 'Ngspice' }];
			},
		},
		lib_LibrariesList: { async getSystemLibraryUuid() { return 'system-library-1'; } },
		lib_Symbol: {
			async searchByProperties(properties) {
				assert.deepEqual(properties, { name: 'LM358' });
				return [{ uuid: 'symbol-1', libraryUuid: 'system-library-1', name: 'LM358' }];
			},
		},
		lib_Footprint: {
			async search(keyword) {
				assert.equal(keyword, 'SOIC-8');
				return [{ uuid: 'footprint-1', libraryUuid: 'system-library-1', name: 'SOIC-8' }];
			},
		},
		pcb_Drc: {
			async check() { return [{ code: 'clearance', count: 2 }]; },
			async getCurrentRuleConfiguration() { return { name: 'current', clearance: 0.2 }; },
			async getRuleConfiguration(name) {
				assert.equal(name, 'strict');
				return { name, clearance: 0.1 };
			},
			async getAllRuleConfigurations(includeSystem) {
				assert.equal(includeSystem, true);
				return [{ name: 'strict' }];
			},
			async getNetRules() { return [{ net: 'USB_D+', width: 0.2 }]; },
			async getNetByNetRules() { return { 'USB_D+|USB_D-': { clearance: 0.15 } }; },
			async getRegionRules() { return [{ region: 'power', clearance: 0.3 }]; },
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
			async getAssemblyVariantsConfigs() { return [{ text: 'Prototype', value: 'prototype' }]; },
			async getBomFile(fileName, fileType, template, filterOptions, statistics, property, columns, assemblyVariantsConfig) {
				assert.equal(template, 'schematic-default');
				assert.deepEqual(assemblyVariantsConfig, { text: 'Prototype', value: 'prototype' });
				return new Blob(['ref,value\nR1,1k\n'], { type: 'text/csv' });
			},
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
	const pcbDocumentStatus = await handlePcbDocumentTask({ action: 'status' });
	assert.equal(pcbDocumentStatus.canvasUpdate, 'idle');
	assert.equal((await handlePcbDocumentTask({ action: 'save' })).saved, true);
	assert.equal((await handlePcbDocumentTask({ action: 'import_changes', uuid: 'sch-1' })).imported, true);
	assert.equal((await handlePcbDocumentTask({ action: 'import_auto_route_json', fileName: 'route.json', dataBase64: 'e30=' })).bytes, 2);
	assert.equal((await handlePcbDocumentTask({ action: 'import_auto_route_ses', fileName: 'route.ses', dataBase64: 'e30=' })).imported, true);
	assert.equal((await handlePcbDocumentTask({ action: 'import_auto_layout_json', fileName: 'layout.json', dataBase64: 'e30=' })).imported, true);
	const schDrc = await handleSchematicDrcCheckTask({});
	assert.equal(schDrc.ok, true);
	const constraints = await handlePcbConstraintsQueryTask({ kind: 'differential_pairs' });
	assert.equal(constraints.count, 1);
	const netRules = await handlePcbConstraintsQueryTask({ kind: 'net_rules' });
	assert.equal(netRules.count, 1);
	const schematicNetNames = await handleSchematicNetQueryTask({ mode: 'names', query: 'usb' });
	assert.deepEqual(schematicNetNames.names, ['USB_D+']);
	const schematicNetExact = await handleSchematicNetQueryTask({ mode: 'exact', query: 'USB_D+' });
	assert.equal(schematicNetExact.net.length, 12);
	const namedRule = await handlePcbConstraintsQueryTask({ kind: 'rule_configuration', configurationName: 'strict' });
	assert.equal(namedRule.result.name, 'strict');
	const ruleConfigurations = await handlePcbConstraintsQueryTask({ kind: 'rule_configurations', includeSystem: true });
	assert.equal(ruleConfigurations.count, 1);
	const exactComponent = await handleComponentSelectTask({ properties: { supplierId: 'C1523' }, limit: 2 });
	assert.equal(exactComponent.searchMode, 'properties');
	assert.equal(exactComponent.selection.candidates[0].libraryUuid, 'system-library-1');
	const symbolSearch = await handleLibrarySearchTask({ kind: 'symbol', properties: { name: 'LM358' } });
	assert.equal(symbolSearch.items[0].uuid, 'symbol-1');
	const footprintSearch = await handleLibrarySearchTask({ kind: 'footprint', keyword: 'SOIC-8' });
	assert.equal(footprintSearch.items[0].name, 'SOIC-8');
	const lcscSearch = await handleLibrarySearchTask({ kind: 'device', lcscIds: ['C1523', 'C17168'], allowMultiMatch: true });
	assert.equal(lcscSearch.searchMode, 'lcsc_ids');
	assert.equal(lcscSearch.items.length, 2);
	const simulationSearch = await handleLibrarySearchTask({ kind: 'simulation_model', keyword: 'LM358', simulationModelType: 'Ngspice', limit: 5 });
	assert.equal(simulationSearch.items[0].uuid, 'model-1');
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
	assert.deepEqual(schematicTemplates.assemblyVariants, [{ text: 'Prototype', value: 'prototype' }]);
	const schematicBom = await handleManufactureExportTask({ domain: 'schematic', kind: 'bom', template: 'schematic-default', assemblyVariantsConfig: { text: 'Prototype', value: 'prototype' } });
	assert.equal(schematicBom.ok, true);
	const jrouterExport = await handleManufactureExportTask({ domain: 'pcb', kind: 'auto_route_jrouter' });
	assert.equal(jrouterExport.ok, true);
	assert.equal(routingCalls, 0);
	console.log('2.1 tool handler tests passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
