const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ moduleResolution: 'node' });
require('ts-node/register/transpile-only');

const { handleComponentSelectTask } = require('../src/mcp/component-select-handler.ts');
const { handleEdaContextTask } = require('../src/mcp/context-handler.ts');
const { handleDesignCompareTask } = require('../src/mcp/design-compare-handler.ts');
const { handleLibrarySearchTask } = require('../src/mcp/library-search-handler.ts');
const { handleManufactureExportTask } = require('../src/mcp/manufacture-export-handler.ts');
const { handleManufactureTemplatesQueryTask } = require('../src/mcp/manufacture-template-handler.ts');
const { handlePcbNetQueryTask } = require('../src/mcp/net-query-handler.ts');
const { handleNetlistCompareTask } = require('../src/mcp/netlist-compare-handler.ts');
const { handlePcbConstraintsQueryTask } = require('../src/mcp/pcb-constraints-handler.ts');
const { handlePcbDocumentTask } = require('../src/mcp/pcb-document-handler.ts');
const { handlePcbDrcCheckTask } = require('../src/mcp/pcb-drc-handler.ts');
const { handlePcbLayerQueryTask } = require('../src/mcp/pcb-layer-handler.ts');
const { handlePcbRealtimeDrcTask } = require('../src/mcp/pcb-realtime-drc-handler.ts');
const { handleProjectInfoTask } = require('../src/mcp/project-info-handler.ts');
const { handleSchematicDocumentTask } = require('../src/mcp/schematic-document-handler.ts');
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
		pcb_Net: {
			async getNet(name) {
				assert.equal(name, 'USB_D+');
				return { name, color: '#00ff00' };
			},
			async getNetLength(name) {
				assert.equal(name, 'USB_D+');
				return 42.5;
			},
			async getNetColor(name) {
				assert.equal(name, 'USB_D+');
				return '#00ff00';
			},
			async getAllPrimitivesByNet(name, primitiveTypes) {
				assert.equal(name, 'USB_D+');
				assert.deepEqual(primitiveTypes, ['POLYLINE', 'VIA']);
				return [{ uuid: 'track-1', type: 'TRACK' }];
			},
		},
		pcb_Document: {
			async getCalculatingRatlineStatus() { return 'active'; },
			async startCalculatingRatline() { return true; },
			async stopCalculatingRatline() { return true; },
			async clearRouting(type) {
				assert.equal(type, 'connection');
				return true;
			},
			async getCanvasUpdateCalculationStatus() { return 'idle'; },
			async getCurrentFilterConfiguration() { return { tracks: true }; },
			async getCanvasOrigin() { return { offsetX: 10, offsetY: 20 }; },
			async convertCanvasOriginToDataOrigin(x, y) { return { x: x - 10, y: y - 20 }; },
			async convertDataOriginToCanvasOrigin(x, y) { return { x: x + 10, y: y + 20 }; },
			async getPrimitiveAtPoint(x, y) {
				return { uuid: 'pad-1', x, y };
			},
			async getPrimitivesInRegion(left, right, top, bottom, leftToRight) {
				assert.deepEqual([left, right, top, bottom, leftToRight], [0, 100, 0, 100, true]);
				return [{ uuid: 'pad-1', type: 'PAD' }, { uuid: 'track-1', type: 'TRACK' }];
			},
			async navigateToCoordinates(x, y) {
				assert.deepEqual([x, y], [25, 35]);
				return true;
			},
			async navigateToRegion(left, right, top, bottom) {
				assert.deepEqual([left, right, top, bottom], [0, 100, 0, 100]);
				return true;
			},
			async zoomToBoardOutline() { return true; },
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
		pcb_SelectControl: {
			async getAllSelectedPrimitives_PrimitiveId() { return ['pad-1', 'track-1']; },
			async getAllSelectedPrimitives() { return [{ uuid: 'pad-1', type: 'PAD' }, { uuid: 'track-1', type: 'TRACK' }]; },
			async getCurrentMousePosition() { return { x: 25, y: 35 }; },
			async doSelectPrimitives(ids) {
				assert.deepEqual(ids, ['pad-1']);
				return true;
			},
			async clearSelected() { return true; },
		},
		pcb_Primitive: {
			async getPrimitiveTypeByPrimitiveId(id) {
				assert.equal(id, 'pad-1');
				return 'PAD';
			},
			async getPrimitiveByPrimitiveId(id) {
				assert.equal(id, 'pad-1');
				return { uuid: id, type: 'PAD' };
			},
			async getPrimitivesByPrimitiveId(ids) {
				assert.deepEqual(ids, ['pad-1']);
				return [{ uuid: ids[0], type: 'PAD' }];
			},
			async getPrimitivesBBox(ids) {
				assert.deepEqual(ids, ['pad-1']);
				return { minX: 1, minY: 2, maxX: 3, maxY: 4 };
			},
		},
		dmt_SelectControl: { async getCurrentDocumentInfo() { return { documentType: 1, uuid: 'page-1' }; } },
		lib_Device: {
			async get(uuid, libraryUuid) {
				assert.equal(uuid, 'device-1');
				assert.equal(libraryUuid, 'system-library-1');
				return { uuid, libraryUuid, name: 'R0402' };
			},
			async search() { return []; },
			async searchByProperties(properties) {
				assert.equal(properties.supplierId, 'C1523');
				return [{ uuid: 'device-1', name: 'R0402', supplierId: 'C1523' }];
			},
			async getByLcscIds(ids, libraryUuid, allowMultiMatch) {
				assert.ok(Array.isArray(ids));
				assert.equal(libraryUuid, undefined);
				assert.equal(allowMultiMatch, true);
				if (ids.includes('C99999')) {
					return Array.from({ length: 130 }, (_, index) => ({ uuid: `device-${index}`, name: `R${index}` }));
				}
				return ids.includes('C17168')
					? [{ uuid: 'device-1', name: 'R0402', supplierId: 'C1523' }, { uuid: 'device-2', name: 'C17168', supplierId: 'C17168' }]
					: [{ uuid: 'device-1', name: 'R0402', supplierId: 'C1523' }, { uuid: 'device-duplicate', name: 'R0402-alt', supplierId: 'C1523' }];
			},
		},
		lib_LibrariesList: { async getSystemLibraryUuid() { return 'system-library-1'; } },
		lib_Symbol: {
			async get(uuid, libraryUuid) {
				assert.equal(uuid, 'symbol-1');
				assert.equal(libraryUuid, 'system-library-1');
				return { uuid, libraryUuid, name: 'LM358' };
			},
			async search(keyword) {
				assert.equal(keyword, 'LM358');
				return [{ uuid: 'symbol-1', libraryUuid: 'system-library-1', name: 'LM358' }];
			},
		},
		lib_Footprint: {
			async get(uuid, libraryUuid) {
				assert.equal(uuid, 'footprint-1');
				assert.equal(libraryUuid, 'system-library-1');
				return { uuid, libraryUuid, name: 'SOIC-8' };
			},
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
			async getPadPairGroupMinWireLength(name) {
				assert.equal(name, 'USB_PADS');
				return [{ minLength: 12.5 }];
			},
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
		sch_Document: {
			async getCurrentFilterConfiguration() { return { wires: true }; },
			async navigateToCoordinates(x, y) {
				assert.deepEqual([x, y], [25, 35]);
				return true;
			},
			async navigateToRegion(left, right, top, bottom) {
				assert.deepEqual([left, right, top, bottom], [0, 100, 0, 100]);
				return true;
			},
			getPrimitiveAtPoint(x, y) { return { uuid: 'sch-pin-1', x, y }; },
			getPrimitivesInRegion(left, right, top, bottom) {
				assert.deepEqual([left, right, top, bottom], [0, 100, 0, 100]);
				return [{ uuid: 'sch-pin-1', type: 'PIN' }];
			},
			async save() { return true; },
			async importChanges() { return true; },
		},
		sch_SelectControl: {
			async getAllSelectedPrimitives_PrimitiveId() { return ['sch-pin-1']; },
			async getAllSelectedPrimitives() { return [{ uuid: 'sch-pin-1', type: 'PIN' }]; },
			async getCurrentMousePosition() { return { x: 25, y: 35 }; },
			async doSelectPrimitives(ids) {
				assert.deepEqual(ids, ['sch-pin-1']);
				return true;
			},
			clearSelected() { return true; },
		},
		sch_Primitive: {
			async getPrimitiveTypeByPrimitiveId(id) {
				assert.equal(id, 'sch-pin-1');
				return 'PIN';
			},
			async getPrimitiveByPrimitiveId(id) {
				assert.equal(id, 'sch-pin-1');
				return { uuid: id, type: 'PIN' };
			},
			async getPrimitivesByPrimitiveId(ids) {
				assert.deepEqual(ids, ['sch-pin-1']);
				return [{ uuid: ids[0], type: 'PIN' }];
			},
			async getPrimitivesBBox(ids) {
				assert.deepEqual(ids, ['sch-pin-1']);
				return { minX: 1, minY: 2, maxX: 3, maxY: 4 };
			},
		},
		sys_Environment: {
			isJLCEDAProEdition() { return true; },
			isEasyEDAProEdition() { return false; },
			isOnlineMode() { return true; },
			isHalfOfflineMode() { return false; },
			isOfflineMode() { return false; },
			getEditorCurrentVersion() { return '3.2.181'; },
			getEditorCompliedDate() { return '2026-08-01'; },
		},
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
			async pcbComparison(a, b) {
				assert.equal(a, 'pcb-1');
				assert.deepEqual(b, { projectUuid: 'project-1', pcbUuid: 'pcb-2' });
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
			async getFlyingProbeTestFile() { return new Blob(['probe,data\nP1,ok\n'], { type: 'text/csv' }); },
			async getAutoLayoutJsonFile() { return new File(['{"components":[]}'], 'layout.json', { type: 'application/json' }); },
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
	const context = await handleEdaContextTask({});
	assert.equal(context.environment.editorVersion, '3.2.181');
	assert.equal(context.environment.isJLCEDAProEdition, true);
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
	assert.deepEqual((await handlePcbDocumentTask({ action: 'canvas_origin' })).origin, { offsetX: 10, offsetY: 20 });
	assert.deepEqual((await handlePcbDocumentTask({ action: 'filter_configuration' })).filterConfiguration, { tracks: true });
	const selection = await handlePcbDocumentTask({ action: 'selection', includeObjects: true });
	assert.equal(selection.selectedCount, 2);
	assert.equal(selection.selectedPrimitives.length, 2);
	assert.deepEqual((await handlePcbDocumentTask({ action: 'mouse_position' })).position, { x: 25, y: 35 });
	assert.equal((await handlePcbDocumentTask({ action: 'select_primitives', ids: ['pad-1'] })).selected, true);
	assert.equal((await handlePcbDocumentTask({ action: 'clear_selection' })).cleared, true);
	assert.equal((await handlePcbDocumentTask({ action: 'primitive_type_by_id', id: 'pad-1' })).primitiveType, 'PAD');
	assert.equal((await handlePcbDocumentTask({ action: 'primitive_by_id', id: 'pad-1' })).primitive.uuid, 'pad-1');
	assert.equal((await handlePcbDocumentTask({ action: 'primitives_by_id', ids: ['pad-1'] })).primitives.length, 1);
	assert.deepEqual((await handlePcbDocumentTask({ action: 'primitives_bbox', ids: ['pad-1'] })).bounds, { minX: 1, minY: 2, maxX: 3, maxY: 4 });
	assert.equal((await handlePcbDocumentTask({ action: 'primitive_at_point', x: 25, y: 35 })).primitive.uuid, 'pad-1');
	const region = await handlePcbDocumentTask({ action: 'primitives_in_region', left: 0, right: 100, top: 0, bottom: 100 });
	assert.equal(region.total, 2);
	assert.deepEqual((await handlePcbDocumentTask({ action: 'convert_canvas_to_data', x: 25, y: 35 })).point, { x: 15, y: 15 });
	assert.deepEqual((await handlePcbDocumentTask({ action: 'convert_data_to_canvas', x: 15, y: 15 })).point, { x: 25, y: 35 });
	assert.equal((await handlePcbDocumentTask({ action: 'navigate_to_coordinates', x: 25, y: 35 })).navigated, true);
	assert.equal((await handlePcbDocumentTask({ action: 'navigate_to_region', left: 0, right: 100, top: 0, bottom: 100 })).navigated, true);
	assert.equal((await handlePcbDocumentTask({ action: 'zoom_to_board_outline' })).zoomed, true);
	assert.equal((await handlePcbDocumentTask({ action: 'save' })).saved, true);
	assert.equal((await handlePcbDocumentTask({ action: 'start_ratline' })).changed, true);
	assert.equal((await handlePcbDocumentTask({ action: 'stop_ratline' })).changed, true);
	assert.equal((await handlePcbDocumentTask({ action: 'clear_routing', routingType: 'connection' })).cleared, true);
	assert.equal((await handlePcbDocumentTask({ action: 'import_changes', uuid: 'sch-1' })).imported, true);
	assert.equal((await handlePcbDocumentTask({ action: 'import_auto_route_json', fileName: 'route.json', dataBase64: 'e30=' })).bytes, 2);
	assert.equal((await handlePcbDocumentTask({ action: 'import_auto_route_ses', fileName: 'route.ses', dataBase64: 'e30=' })).imported, true);
	assert.equal((await handlePcbDocumentTask({ action: 'import_auto_layout_json', fileName: 'layout.json', dataBase64: 'e30=' })).imported, true);
	const pcbNetAnalysis = await handlePcbNetQueryTask({ mode: 'exact', query: 'USB_D+', analysis: { length: true, color: true, primitiveTypes: ['POLYLINE', 'VIA'] } });
	assert.equal(pcbNetAnalysis.length, 42.5);
	assert.equal(pcbNetAnalysis.color, '#00ff00');
	assert.equal(pcbNetAnalysis.primitiveCount, 1);
	const schDrc = await handleSchematicDrcCheckTask({});
	assert.equal(schDrc.ok, true);
	assert.deepEqual((await handleSchematicDocumentTask({ action: 'status' })).filterConfiguration, { wires: true });
	const schSelection = await handleSchematicDocumentTask({ action: 'selection', includeObjects: true });
	assert.equal(schSelection.selectedCount, 1);
	assert.equal(schSelection.selectedPrimitives.length, 1);
	assert.deepEqual((await handleSchematicDocumentTask({ action: 'mouse_position' })).position, { x: 25, y: 35 });
	assert.equal((await handleSchematicDocumentTask({ action: 'primitive_at_point', x: 25, y: 35 })).primitive.uuid, 'sch-pin-1');
	assert.equal((await handleSchematicDocumentTask({ action: 'primitives_in_region', left: 0, right: 100, top: 0, bottom: 100 })).total, 1);
	assert.equal((await handleSchematicDocumentTask({ action: 'navigate_to_coordinates', x: 25, y: 35 })).navigated, true);
	assert.equal((await handleSchematicDocumentTask({ action: 'navigate_to_region', left: 0, right: 100, top: 0, bottom: 100 })).navigated, true);
	assert.equal((await handleSchematicDocumentTask({ action: 'select_primitives', ids: ['sch-pin-1'] })).selected, true);
	assert.equal((await handleSchematicDocumentTask({ action: 'clear_selection' })).cleared, true);
	assert.equal((await handleSchematicDocumentTask({ action: 'primitive_type_by_id', id: 'sch-pin-1' })).primitiveType, 'PIN');
	assert.equal((await handleSchematicDocumentTask({ action: 'primitive_by_id', id: 'sch-pin-1' })).primitive.uuid, 'sch-pin-1');
	assert.equal((await handleSchematicDocumentTask({ action: 'primitives_by_id', ids: ['sch-pin-1'] })).primitives.length, 1);
	assert.deepEqual((await handleSchematicDocumentTask({ action: 'primitives_bbox', ids: ['sch-pin-1'] })).bounds, { minX: 1, minY: 2, maxX: 3, maxY: 4 });
	assert.equal((await handleSchematicDocumentTask({ action: 'save' })).saved, true);
	assert.equal((await handleSchematicDocumentTask({ action: 'import_changes' })).imported, true);
	const constraints = await handlePcbConstraintsQueryTask({ kind: 'differential_pairs' });
	assert.equal(constraints.count, 1);
	const netRules = await handlePcbConstraintsQueryTask({ kind: 'net_rules' });
	assert.equal(netRules.count, 1);
	const padPairMinimum = await handlePcbConstraintsQueryTask({ kind: 'pad_pair_min_wire_length', padPairGroupName: 'USB_PADS' });
	assert.equal(padPairMinimum.count, 1);
	const namedRule = await handlePcbConstraintsQueryTask({ kind: 'rule_configuration', configurationName: 'strict' });
	assert.equal(namedRule.result.name, 'strict');
	const ruleConfigurations = await handlePcbConstraintsQueryTask({ kind: 'rule_configurations', includeSystem: true });
	assert.equal(ruleConfigurations.count, 1);
	const exactComponent = await handleComponentSelectTask({ properties: { supplierId: 'C1523' }, limit: 2 });
	assert.equal(exactComponent.searchMode, 'properties');
	assert.equal(exactComponent.selection.candidates[0].libraryUuid, 'system-library-1');
	const symbolSearch = await handleLibrarySearchTask({ kind: 'symbol', keyword: 'LM358' });
	assert.equal(symbolSearch.items[0].uuid, 'symbol-1');
	const deviceGet = await handleLibrarySearchTask({ kind: 'device', uuid: 'device-1', libraryUuid: 'system-library-1' });
	assert.equal(deviceGet.item.name, 'R0402');
	const symbolGet = await handleLibrarySearchTask({ kind: 'symbol', uuid: 'symbol-1', libraryUuid: 'system-library-1' });
	assert.equal(symbolGet.item.name, 'LM358');
	const footprintGet = await handleLibrarySearchTask({ kind: 'footprint', uuid: 'footprint-1', libraryUuid: 'system-library-1' });
	assert.equal(footprintGet.item.name, 'SOIC-8');
	const footprintSearch = await handleLibrarySearchTask({ kind: 'footprint', keyword: 'SOIC-8' });
	assert.equal(footprintSearch.items[0].name, 'SOIC-8');
	const lcscSearch = await handleLibrarySearchTask({ kind: 'device', lcscIds: ['C1523', 'C17168'], allowMultiMatch: true });
	assert.equal(lcscSearch.searchMode, 'lcsc_ids');
	assert.equal(lcscSearch.items.length, 2);
	const singleLcscSearch = await handleLibrarySearchTask({ kind: 'device', lcscIds: ['C1523'], allowMultiMatch: true });
	assert.equal(singleLcscSearch.items.length, 2);
	const manyLcscSearch = await handleLibrarySearchTask({ kind: 'device', lcscIds: ['C99999'], allowMultiMatch: true, limit: 20 });
	assert.equal(manyLcscSearch.total, 130);
	assert.equal(manyLcscSearch.returned, 20);
	assert.equal(manyLcscSearch.truncated, true);
	const comparison = await handleNetlistCompareTask({ sourceA: 'pcb-1', sourceB: { projectUuid: 'project-1', documentUuid: 'pcb-2' } });
	assert.equal(comparison.differenceCount, 1);
	const schematicComparison = await handleDesignCompareTask({ domain: 'schematic', sourceA: 'sch-1', sourceB: 'sch-2' });
	assert.equal(schematicComparison.result.changed, 2);
	const designNetlistComparison = await handleDesignCompareTask({ domain: 'netlist', sourceA: 'net-1', sourceB: { projectUuid: 'project-1', documentUuid: 'net-2' } });
	assert.equal(designNetlistComparison.differenceCount, 1);
	const pcbComparison = await handleDesignCompareTask({ domain: 'pcb', sourceA: 'pcb-1', sourceB: { projectUuid: 'project-1', pcbUuid: 'pcb-2' } });
	assert.equal(pcbComparison.result.data.changed, 3);
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
	const flyingProbeExport = await handleManufactureExportTask({ domain: 'pcb', kind: 'flying_probe_test' });
	assert.equal(flyingProbeExport.ok, true);
	const autoLayoutExport = await handleManufactureExportTask({ domain: 'pcb', kind: 'auto_layout_json' });
	assert.equal(autoLayoutExport.file.preview, '{"components":[]}');
	assert.equal(routingCalls, 0);
	console.log('2.1 tool handler tests passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
