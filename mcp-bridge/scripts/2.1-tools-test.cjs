const assert = require('node:assert/strict');
const process = require('node:process');

process.env.TS_NODE_COMPILER_OPTIONS = JSON.stringify({ module: 'CommonJS', moduleResolution: 'node' });
require('ts-node/register/transpile-only');

const { handleApiIndexTask } = require('../src/mcp/api-index-handler.ts');
const { handleApiSearchTask } = require('../src/mcp/api-search-handler.ts');
const { handleAutoLayoutTask } = require('../src/mcp/auto-layout-handler.ts');
const { handleAutoRoutingTask } = require('../src/mcp/auto-routing-handler.ts');
const { handleCanvasSnapshotTask } = require('../src/mcp/canvas-snapshot-handler.ts');
const { handleComponentSelectTask } = require('../src/mcp/component-select-handler.ts');
const { handleEdaContextTask } = require('../src/mcp/context-handler.ts');
const { handleDesignArchiveExportTask } = require('../src/mcp/design-archive-export-handler.ts');
const { handleDesignCompareTask } = require('../src/mcp/design-compare-handler.ts');
const { handleDesignSourceExportTask } = require('../src/mcp/design-source-export-handler.ts');
const { handleApiInvokeTask } = require('../src/mcp/invoke-handler.ts');
const { handleLibraryClassificationTask } = require('../src/mcp/library-classification-handler.ts');
const { handleLibraryPreviewTask } = require('../src/mcp/library-preview-handler.ts');
const { handleLibrarySearchTask } = require('../src/mcp/library-search-handler.ts');
const { handleLibrarySourcesTask } = require('../src/mcp/library-sources-handler.ts');
const { handleManufactureExportTask } = require('../src/mcp/manufacture-export-handler.ts');
const { handleManufactureTemplatesQueryTask } = require('../src/mcp/manufacture-template-handler.ts');
const { handlePcbNetQueryTask } = require('../src/mcp/net-query-handler.ts');
const { handleNetlistCompareTask } = require('../src/mcp/netlist-compare-handler.ts');
const { handlePcbConstraintsQueryTask } = require('../src/mcp/pcb-constraints-handler.ts');
const { handlePcbConstraintsManageTask } = require('../src/mcp/pcb-constraints-manage-handler.ts');
const { handlePcbDocumentTask } = require('../src/mcp/pcb-document-handler.ts');
const { handlePcbDrcCheckTask } = require('../src/mcp/pcb-drc-handler.ts');
const { handlePcbLayerQueryTask } = require('../src/mcp/pcb-layer-handler.ts');
const { handlePcbRealtimeDrcTask } = require('../src/mcp/pcb-realtime-drc-handler.ts');
const { handleProjectInfoTask } = require('../src/mcp/project-info-handler.ts');
const { handleSchematicDocumentTask } = require('../src/mcp/schematic-document-handler.ts');
const { handleSchematicDrcCheckTask } = require('../src/mcp/schematic-drc-handler.ts');
const { handleSchematicPagesManageTask } = require('../src/mcp/schematic-pages-manage-handler.ts');
const { handleWorkspaceQueryTask } = require('../src/mcp/workspace-query-handler.ts');
const { BridgeTaskQuarantine, requiresHostRestartForResult } = require('../src/runtime/task-timeout.ts');
const { toSerializableAsync } = require('../src/utils.ts');
const { debugLog } = require('../src/utils/debug-log.ts');

async function main() {
	const routingCalls = 0;
	const netClasses = [];
	const differentialPairs = [{ name: 'USB_P', positiveNet: 'D+', negativeNet: 'D-' }];
	const equalLengthGroups = [];
	const padPairGroups = [];
	const schematicPages = [
		{ uuid: 'page-1', name: 'Power', parentSchematicUuid: 'sch-1', trusted: true },
		{ uuid: 'page-2', name: 'Control', parentSchematicUuid: 'sch-1', trusted: true },
		{ uuid: 'page-3', name: 'Other', parentSchematicUuid: 'sch-2', trusted: true },
	];
	globalThis.eda = {
		sys_FileSystem: {
			async getExtensionFile(uri) {
				assert.equal(uri, '/resources/jlceda-pro-api-doc.json');
				return {
					async text() {
						return JSON.stringify(require('../resources/jlceda-pro-api-doc.json'));
					},
				};
			},
		},
		dmt_Project: {
			async getCurrentProjectInfo() { return { uuid: 'project-1', name: '2026' }; },
			async getAllProjectsUuid(teamUuid, folderUuid, workspaceUuid) {
				assert.deepEqual([teamUuid, folderUuid, workspaceUuid], ['team-1', undefined, undefined]);
				return ['project-1', 'project-2'];
			},
			async getProjectInfo(uuid) { return { uuid, name: `Project ${uuid}` }; },
		},
		dmt_Workspace: {
			async getCurrentWorkspaceInfo() { return { uuid: 'workspace-1', name: 'Local' }; },
			async getAllWorkspacesInfo() { return [{ uuid: 'workspace-1', name: 'Local' }, { uuid: 'workspace-2', name: 'Cloud' }]; },
		},
		dmt_Team: {
			async getCurrentTeamInfo() { return { uuid: 'team-1', name: 'Personal' }; },
			async getAllTeamsInfo() { return [{ uuid: 'team-1', name: 'Personal' }]; },
			async getAllInvolvedTeamInfo() { return [{ uuid: 'team-2', name: 'Shared' }]; },
		},
		dmt_Folder: {
			async getAllFoldersUuid(teamUuid) {
				assert.equal(teamUuid, 'team-1');
				return ['folder-1'];
			},
			async getFolderInfo(teamUuid, uuid) {
				assert.equal(teamUuid, 'team-1');
				return { uuid, name: 'Robot' };
			},
		},
		dmt_Board: {
			async getCurrentBoardInfo() { return { uuid: 'board-1' }; },
			async getAllBoardsInfo() { return [{ uuid: 'board-1', name: 'Main board' }, { uuid: 'board-2', name: 'Auxiliary board' }]; },
		},
		dmt_Panel: {
			async getAllPanelsInfo() { return [{ uuid: 'panel-1', name: 'Production panel' }]; },
		},
		dmt_Schematic: {
			async getCurrentSchematicInfo() { return { uuid: 'sch-1' }; },
			async getCurrentSchematicAllSchematicPagesInfo() { return schematicPages.filter(page => page.parentSchematicUuid === 'sch-1'); },
			async getAllSchematicsInfo() { return [{ uuid: 'sch-1', name: 'Power' }, { uuid: 'sch-2', name: 'Control' }]; },
			async getAllSchematicPagesInfo() { return schematicPages; },
			async createSchematicPage(schematicUuid) {
				const uuid = `page-${schematicPages.length + 1}`;
				schematicPages.push({ uuid, name: `Page ${schematicPages.length + 1}`, parentSchematicUuid: schematicUuid, trusted: true });
				return uuid;
			},
			async copySchematicPage(sourcePageUuid, schematicUuid) {
				const source = schematicPages.find(page => page.uuid === sourcePageUuid);
				assert.ok(source);
				const uuid = `page-${schematicPages.length + 1}`;
				schematicPages.push({ ...source, uuid, name: `${source.name} Copy`, parentSchematicUuid: schematicUuid ?? source.parentSchematicUuid });
				return uuid;
			},
			async modifySchematicPageName(schematicPageUuid, newName) {
				const page = schematicPages.find(item => item.uuid === schematicPageUuid);
				if (page)
					page.name = newName;
				return Boolean(page);
			},
			async reorderSchematicPages(schematicUuid, pages) {
				const current = schematicPages.filter(page => page.parentSchematicUuid === schematicUuid);
				assert.equal(pages.length, current.length);
				assert.ok(pages.every(page => current.includes(page) && page.trusted === true));
				const others = schematicPages.filter(page => page.parentSchematicUuid !== schematicUuid);
				schematicPages.splice(0, schematicPages.length, ...pages, ...others);
				return true;
			},
		},
		dmt_Pcb: {
			async getCurrentPcbInfo() { return { uuid: 'pcb-1', parentBoardName: 'Board1_1' }; },
			async getAllPcbsInfo() { return [{ uuid: 'pcb-1', name: 'Main PCB' }, { uuid: 'pcb-2', name: 'Auxiliary PCB' }]; },
		},
		pcb_Net: {
			async getAllNets() { return [{ name: 'USB_D+' }, { name: 'GND' }]; },
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
				assert.equal(primitiveTypes, undefined, 'native primitive type filtering returns an empty array in EDA 3.2.181');
				return [
					{ globalIndex: 'track-1', pcbItemPrimitiveType: 'Track', startX: 0, endX: 10 },
					{ globalIndex: 'pad-1', pcbItemPrimitiveType: 'Pad', parentId: 'component-1' },
					{ globalIndex: 'pad-2', pcbItemPrimitiveType: 'Pad' },
					{ globalIndex: 'polyline-1', pcbItemPrimitiveType: 'Polyline' },
					{ globalIndex: 'via-1', pcbItemPrimitiveType: 'Via' },
				];
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
				if (right === 500) {
					return Array.from({ length: 130 }, (_value, index) => ({ uuid: `pcb-${index}` }));
				}
				assert.deepEqual([left, right, top, bottom, leftToRight], [0, 100, 100, 0, true]);
				return [{ uuid: 'pad-1', type: 'PAD' }, { uuid: 'track-1', type: 'TRACK' }];
			},
			async navigateToCoordinates(x, y) {
				assert.deepEqual([x, y], [25, 35]);
				return true;
			},
			async navigateToRegion(left, right, top, bottom) {
				assert.deepEqual([left, right, top, bottom], [0, 100, 100, 0]);
				return true;
			},
			async zoomToBoardOutline() { return true; },
			async save(...args) {
				assert.deepEqual(args, []);
				return true;
			},
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
			async search(keyword, libraryUuid, classification, symbolType, limit, page) {
				if (keyword !== 'paged')
					return [];
				assert.deepEqual([libraryUuid, classification, symbolType, limit, page], [undefined, undefined, undefined, 20, 2]);
				return Array.from({ length: 20 }, (_value, index) => ({ uuid: `paged-${index}`, name: `Paged ${index}` }));
			},
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
		lib_LibrariesList: {
			async getSystemLibraryUuid() { return 'system-library-1'; },
			async getPersonalLibraryUuid() { return 'personal-library-1'; },
			async getProjectLibraryUuid() { return 'project-library-1'; },
			async getFavoriteLibraryUuid() { return 'favorite-library-1'; },
			async getAllLibrariesList() { return Array.from({ length: 130 }, (_value, index) => ({ uuid: `library-${index}`, name: `Library ${index}` })); },
		},
		lib_Classification: {
			async getAllClassificationTree(libraryUuid, libraryType) {
				assert.equal(libraryUuid, 'system-library-1');
				assert.equal(libraryType, '2');
				return [{ name: 'Amplifiers', uuid: 'classification-1', children: [{ name: 'Operational', uuid: 'classification-2' }] }];
			},
		},
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
			async getRenderImage(input) {
				assert.deepEqual(input, { symbolUuid: 'symbol-1', libraryUuid: 'system-library-1', subPartName: 'A' });
				return new Blob(['symbol-preview'], { type: 'image/svg+xml' });
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
			async getRenderImage(input) {
				assert.deepEqual(input, { footprintUuid: 'footprint-1', libraryUuid: 'system-library-1' });
				return new Blob(['footprint-preview'], { type: 'image/png' });
			},
		},
		lib_3DModel: {
			async get(uuid) { return { uuid, name: 'SOT-23 3D' }; },
			async search(keyword) {
				assert.equal(keyword, 'SOT-23');
				return [{ uuid: 'model-1', name: 'SOT-23 3D' }];
			},
		},
		lib_Cbb: {
			async get(uuid) { return { uuid, name: 'Buck Module' }; },
			async search(keyword) {
				assert.equal(keyword, 'Buck');
				return [{ uuid: 'cbb-1', name: 'Buck Module' }];
			},
		},
		lib_PanelLibrary: {
			async get(uuid) { return { uuid, name: 'Panel A' }; },
			async search(keyword) {
				assert.equal(keyword, 'Panel');
				return [{ uuid: 'panel-1', name: 'Panel A' }];
			},
		},
		lib_SimulationModel: {
			async search(keyword, libraryUuid, classification, simulationModelType, limit, page) {
				assert.equal(keyword, 'resistor');
				assert.equal(libraryUuid, 'system-library-1');
				assert.equal(classification, undefined);
				assert.equal(simulationModelType, 'Ngspice');
				assert.equal(limit, 3);
				assert.equal(page, 2);
				return [{ uuid: 'simulation-1', name: 'Resistor', type: 'Ngspice' }];
			},
		},
		dmt_EditorControl: {
			async getCurrentRenderedAreaImage(tabId) {
				assert.equal(tabId, undefined);
				return new Blob(['canvas-image'], { type: 'image/png' });
			},
		},
		pcb_Drc: {
			receiver: 'pcb-drc',
			async check() {
				assert.equal(this.receiver, 'pcb-drc');
				return [{ code: 'clearance', count: 2 }];
			},
			async getCurrentRuleConfiguration() { return { name: 'current', clearance: 0.2 }; },
			async getCurrentRuleConfigurationName() { return 'current'; },
			async getDefaultRuleConfigurationName() { return 'default'; },
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
			async getAllNetClasses() { return netClasses; },
			async getAllDifferentialPairs() { return differentialPairs; },
			async getAllEqualLengthNetGroups() { return equalLengthGroups; },
			async getAllPadPairGroups() { return padPairGroups; },
			async createNetClass(name, nets, color) {
				netClasses.push({ name, nets, color });
				return true;
			},
			async deleteNetClass(name) {
				const index = netClasses.findIndex(item => item.name === name);
				if (index >= 0)
					netClasses.splice(index, 1);
				return index >= 0;
			},
			async modifyNetClassName(name, newName) {
				const item = netClasses.find(item => item.name === name);
				if (item)
					item.name = newName;
				return Boolean(item);
			},
			async addNetToNetClass(name, nets) {
				const item = netClasses.find(candidate => candidate.name === name);
				if (item)
					item.nets.push(...nets);
				return Boolean(item);
			},
			async removeNetFromNetClass(name, nets) {
				const item = netClasses.find(candidate => candidate.name === name);
				if (item)
					item.nets = item.nets.filter(net => !nets.includes(net));
				return Boolean(item);
			},
			async createDifferentialPair(name, positiveNet, negativeNet) {
				differentialPairs.push({ name, positiveNet, negativeNet });
				return true;
			},
			async deleteDifferentialPair(name) {
				const index = differentialPairs.findIndex(item => item.name === name);
				if (index >= 0)
					differentialPairs.splice(index, 1);
				return index >= 0;
			},
			async modifyDifferentialPairName(name, newName) {
				const item = differentialPairs.find(item => item.name === name);
				if (item)
					item.name = newName;
				return Boolean(item);
			},
			async modifyDifferentialPairPositiveNet(name, positiveNet) {
				const item = differentialPairs.find(item => item.name === name);
				if (item)
					item.positiveNet = positiveNet;
				return Boolean(item);
			},
			async modifyDifferentialPairNegativeNet(name, negativeNet) {
				const item = differentialPairs.find(item => item.name === name);
				if (item)
					item.negativeNet = negativeNet;
				return Boolean(item);
			},
			async createEqualLengthNetGroup(name, nets, color) {
				equalLengthGroups.push({ name, nets, color });
				return true;
			},
			async deleteEqualLengthNetGroup(name) {
				const index = equalLengthGroups.findIndex(item => item.name === name);
				if (index >= 0)
					equalLengthGroups.splice(index, 1);
				return index >= 0;
			},
			async modifyEqualLengthNetGroupName(name, newName) {
				const item = equalLengthGroups.find(item => item.name === name);
				if (item)
					item.name = newName;
				return Boolean(item);
			},
			async addNetToEqualLengthNetGroup(name, nets) {
				const item = equalLengthGroups.find(candidate => candidate.name === name);
				if (item)
					item.nets.push(...nets);
				return Boolean(item);
			},
			async removeNetFromEqualLengthNetGroup(name, nets) {
				const item = equalLengthGroups.find(candidate => candidate.name === name);
				if (item)
					item.nets = item.nets.filter(net => !nets.includes(net));
				return Boolean(item);
			},
			async createPadPairGroup(name, padPairs) {
				padPairGroups.push({ name, padPairs });
				return true;
			},
			async deletePadPairGroup(name) {
				const index = padPairGroups.findIndex(item => item.name === name);
				if (index >= 0)
					padPairGroups.splice(index, 1);
				return index >= 0;
			},
			async modifyPadPairGroupName(name, newName) {
				const item = padPairGroups.find(item => item.name === name);
				if (item)
					item.name = newName;
				return Boolean(item);
			},
			async addPadPairToPadPairGroup(name, padPairs) {
				const item = padPairGroups.find(candidate => candidate.name === name);
				if (item)
					item.padPairs.push(...padPairs);
				return Boolean(item);
			},
			async removePadPairFromPadPairGroup(name, padPairs) {
				const item = padPairGroups.find(candidate => candidate.name === name);
				if (item)
					item.padPairs = item.padPairs.filter(pair => !padPairs.some(candidate => candidate[0] === pair[0] && candidate[1] === pair[1]));
				return Boolean(item);
			},
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
			async getTheNumberOfCopperLayers() { return 2; },
			async getCurrentPhysicalStackingConfigurationName() { return '2 Layer'; },
			async getCurrentPhysicalStackingConfiguration() { return { name: '2 Layer', layerCount: 2 }; },
			async getAllPhysicalStackingConfigurations() { return [{ name: '2 Layer', layerCount: 2 }]; },
			async getPhysicalStackingConfiguration(name) { return { name, layerCount: 2 }; },
		},
		sch_Drc: { async check() { return []; } },
		sch_Document: {
			async autoLayout() { return { placedComponents: 2 }; },
			async autoRouting() { return { routedNets: 3 }; },
			async getCurrentFilterConfiguration() { return { wires: true }; },
			async navigateToCoordinates(x, y) {
				assert.deepEqual([x, y], [25, 35]);
				return true;
			},
			async navigateToRegion(left, right, top, bottom) {
				assert.deepEqual([left, right, top, bottom], [0, 100, 100, 0]);
				return true;
			},
			getPrimitiveAtPoint(x, y) { return { uuid: 'sch-pin-1', x, y }; },
			getPrimitivesInRegion(left, right, top, bottom) {
				if (right === 500) {
					return Array.from({ length: 130 }, (_value, index) => ({ uuid: `sch-${index}` }));
				}
				assert.deepEqual([left, right, top, bottom], [0, 100, 100, 0]);
				return [{ uuid: 'sch-pin-1', type: 'PIN' }];
			},
			async save() {
				return true;
			},
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
		sys_Unit: {
			async getFrontendDataUnit() { return 'mm'; },
		},
		sys_Storage: {
			async setExtensionUserConfig() { return true; },
			getExtensionUserConfig() { return undefined; },
		},
		sys_FileManager: {
			async getProjectFile(fileName, password, fileType) {
				assert.deepEqual([fileName, password, fileType], ['robot', undefined, 'epro2']);
				return new File(['project-archive'], 'robot.epro2', { type: 'application/octet-stream' });
			},
			async getDocumentFile(fileName, password, fileType) {
				assert.deepEqual([fileName, password, fileType], [undefined, undefined, undefined]);
				return new File(['document-archive'], 'power.epro2', { type: 'application/octet-stream' });
			},
			async getProjectFileByProjectUuid(projectUuid, fileName, password, fileType) {
				assert.deepEqual([projectUuid, fileName, password, fileType], ['project-2', undefined, undefined, undefined]);
				return new File(['other-project'], 'other.epro2', { type: 'application/octet-stream' });
			},
			async getDocumentSource() { return 'DOCHEAD: example schematic source'; },
			async getDocumentFootprintSources() {
				return [
					{ footprintUuid: 'footprint-1', documentSource: 'FOOTPRINT: one' },
					{ footprintUuid: 'footprint-2', documentSource: 'FOOTPRINT: two' },
				];
			},
		},
		sys_Tool: {
			async netlistComparison(a, b) {
				if (a === 'net-1') {
					assert.deepEqual(b, { projectUuid: 'project-1', documentUuid: 'net-2' });
				}
				else if (a === 'net-many') {
					assert.equal(b, 'net-many-other');
					return Array.from({ length: 130 }, (_, index) => ({ type: 'Net', object: `N${index + 1}` }));
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
			async getOpenDatabaseDoublePlusFile(fileName, unit) {
				assert.equal(fileName, undefined);
				assert.equal(unit, 'mm');
				return new Blob(['odb'], { type: 'application/octet-stream' });
			},
			async getAutoLayoutJsonFile() { return new File(['{"components":[]}'], 'layout.json', { type: 'application/json' }); },
		},
		sch_ManufactureData: {
			async getAssemblyVariantsConfigs() { return [{ text: 'Prototype', value: 'prototype' }]; },
			async getBomFile(fileName, fileType, template, filterOptions, statistics, property, columns, assemblyVariantsConfig) {
				assert.equal(template, undefined);
				assert.deepEqual(assemblyVariantsConfig, { text: 'Prototype', value: 'prototype' });
				return new Blob(['ref,value\nR1,1k\n'], { type: 'text/csv' });
			},
		},
	};
	const originalStorageWrite = globalThis.eda.sys_Storage.setExtensionUserConfig;
	const originalConsoleError = console.error;
	const storageErrors = [];
	console.error = (...args) => storageErrors.push(args);
	globalThis.eda.sys_Storage.setExtensionUserConfig = async () => {
		throw new Error('storage unavailable');
	};
	debugLog('storage rejection test');
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(storageErrors.length, 1);
	assert.match(String(storageErrors[0][1]), /storage unavailable/);
	console.error = originalConsoleError;
	globalThis.eda.sys_Storage.setExtensionUserConfig = originalStorageWrite;
	const originalSchematicComponents = globalThis.eda.sch_PrimitiveComponent;
	globalThis.eda.sch_PrimitiveComponent = {
		async getAllPrimitiveId(_type, allPages) {
			assert.equal(_type, null);
			assert.equal(allPages, false);
			return Array.from({ length: 125 }, (_, index) => `component-${index + 1}`);
		},
		async getAll(_type, allPages) {
			assert.equal(_type, undefined);
			assert.equal(allPages, false);
			return Array.from({ length: 125 }, (_, index) => ({
				getState_PrimitiveId: () => `component-${index + 1}`,
				getState_Designator: () => `U${index + 1}`,
				getState_OtherProperty: () => index === 0 ? { supplierId: 'C1' } : undefined,
			}));
		},
	};
	const completeSchematicIds = await handleApiInvokeTask({
		apiFullName: 'eda.sch_PrimitiveComponent.getAllPrimitiveId',
		args: [null, false],
		includeCompleteSchematicComponentIds: true,
	});
	assert.equal(completeSchematicIds.result.length, 120, 'ordinary API result retains its serialization limit');
	assert.equal(completeSchematicIds.schematicComponentCount, 125);
	assert.equal((await toSerializableAsync(completeSchematicIds)).schematicComponentIds.length, 125);
	assert.equal(completeSchematicIds.schematicComponentIds[124], 'component-125');
	assert.equal((await toSerializableAsync(completeSchematicIds)).schematicComponentStates.length, 125);
	assert.deepEqual((await toSerializableAsync(completeSchematicIds)).schematicComponentStates[0], { primitiveId: 'component-1', designator: 'U1', otherPropertyJson: '{"supplierId":"C1"}' });
	assert.deepEqual(completeSchematicIds.schematicComponentStates[124], { primitiveId: 'component-125', designator: 'U125', otherPropertyJson: '{}' });
	await assert.rejects(() => handleApiInvokeTask({
		apiFullName: 'eda.sch_PrimitiveComponent.getAllPrimitiveId',
		args: [],
		includeCompleteSchematicComponentIds: true,
	}), /args \[null, false\]/);
	globalThis.eda.sch_PrimitiveComponent.getAllPrimitiveId = async () => ['same-id', 'same-id'];
	assert.equal((await handleApiInvokeTask({
		apiFullName: 'eda.sch_PrimitiveComponent.getAllPrimitiveId',
		args: [null, false],
		includeCompleteSchematicComponentIds: true,
	})).ok, false);
	globalThis.eda.sch_PrimitiveComponent = originalSchematicComponents;
	const originalCurrentPcbInfo = globalThis.eda.dmt_Pcb.getCurrentPcbInfo;
	let activePcbUuid = 'pcb-1';
	globalThis.eda.dmt_Pcb.getCurrentPcbInfo = async () => ({ uuid: activePcbUuid });
	let pcbAutoLayoutCalls = 0;
	globalThis.eda.pcb_Document.autoLayout = async () => {
		pcbAutoLayoutCalls += 1;
		throw new Error('RPC Call autoLayout Timed Out');
	};
	await assert.rejects(() => handleApiInvokeTask({ apiFullName: 'eda.pcb_Document.autoLayout', args: [], expectedPcbUuid: 'pcb-other' }), /PCB page changed between task start and autoLayout invocation/);
	assert.equal(pcbAutoLayoutCalls, 0, 'a page mismatch must fail before the native autoLayout call');
	const unknownLayout = await handleApiInvokeTask({ apiFullName: 'eda.pcb_Document.autoLayout', args: [] });
	assert.equal(unknownLayout.commitState, 'unknown');
	assert.equal(unknownLayout.retryBlocked, true);
	assert.equal(unknownLayout.layoutContext.pageUuid, 'pcb-1');
	const runtimeLayoutQuarantine = new BridgeTaskQuarantine();
	const runtimeLayoutPath = '/bridge/jlceda/api/invoke';
	if (requiresHostRestartForResult(runtimeLayoutPath, { apiFullName: 'eda.pcb_Document.autoLayout', args: [] }, unknownLayout))
		runtimeLayoutQuarantine.requireHostRestart(runtimeLayoutPath);
	const blockedLayout = await handleApiInvokeTask({ apiFullName: 'eda.pcb_Document.autoLayout', args: [] });
	assert.equal(blockedLayout.retryBlocked, true);
	assert.equal(pcbAutoLayoutCalls, 1);
	globalThis.eda.pcb_PrimitiveComponent = {
		async getAll() { return Array.from({ length: 125 }, (_, index) => ({ uuid: `R${index + 1}`, x: 10 + index, y: 20, rotation: 90, footprint: '0402' })); },
	};
	const filteredReadback = await handleApiInvokeTask({ apiFullName: 'eda.pcb_PrimitiveComponent.getAll', args: [1, false] });
	assert.equal(filteredReadback.autoLayoutReadbackPerformed, undefined);
	assert.equal(filteredReadback.result[0].footprint, '0402', 'ordinary getAll must retain component fields');
	assert.equal((await handleApiInvokeTask({ apiFullName: 'eda.pcb_Document.autoLayout', args: [] })).retryBlocked, true);
	activePcbUuid = 'pcb-2';
	const otherPcbReadback = await handleApiInvokeTask({ apiFullName: 'eda.pcb_PrimitiveComponent.getAll', args: [] });
	assert.equal(otherPcbReadback.autoLayoutReadbackPerformed, undefined);
	assert.equal(otherPcbReadback.componentPositions, undefined);
	assert.equal(otherPcbReadback.result[0].footprint, '0402');
	assert.equal((await handleApiInvokeTask({ apiFullName: 'eda.pcb_Document.autoLayout', args: [] })).retryBlocked, true);
	activePcbUuid = 'pcb-1';
	const layoutReadback = await handleApiInvokeTask({ apiFullName: 'eda.pcb_PrimitiveComponent.getAll', args: [] });
	assert.equal(layoutReadback.autoLayoutReadbackPerformed, true);
	assert.equal(layoutReadback.componentCount, 125);
	assert.equal(layoutReadback.result[0].footprint, '0402');
	assert.equal(layoutReadback.componentPositions.length, 125, 'layout recovery must return every component position');
	assert.equal(layoutReadback.componentPositions[124].primitiveId, 'R125');
	const serializedLayoutReadback = await toSerializableAsync(layoutReadback);
	assert.equal(serializedLayoutReadback.componentPositions.length, 125, 'Bridge result serialization must preserve every verified position');
	assert.equal(layoutReadback.componentPositions[0].rotation, 90);
	assert.equal(runtimeLayoutQuarantine.requiresHostRestart(), true, 'same-page readback must not clear the runtime write barrier before EDA host restart');
	globalThis.eda.pcb_Document.autoLayout = async () => ({ success: true, successComponentsCount: 1 });
	const completedLayout = await handleApiInvokeTask({ apiFullName: 'eda.pcb_Document.autoLayout', args: [] });
	assert.equal(completedLayout.result.success, true);
	const nextLayoutBaseline = await handleApiInvokeTask({ apiFullName: 'eda.pcb_PrimitiveComponent.getAll', args: [] });
	assert.equal(nextLayoutBaseline.componentCount, undefined);
	assert.equal(nextLayoutBaseline.result.length, 120, 'ordinary getAll retains its bounded generic serialization');
	assert.equal(nextLayoutBaseline.result[0].footprint, '0402');
	const requestedPositionReadback = await handleApiInvokeTask({ apiFullName: 'eda.pcb_PrimitiveComponent.getAll', args: [], includeCompletePositions: true });
	assert.equal(requestedPositionReadback.componentCount, 125);
	assert.equal(requestedPositionReadback.componentPositions[124].primitiveId, 'R125');
	globalThis.eda.pcb_PrimitiveComponent.getAll = async () => [{ uuid: 'R1', footprint: '0402' }];
	assert.equal((await handleApiInvokeTask({ apiFullName: 'eda.pcb_PrimitiveComponent.getAll', args: [] })).result[0].footprint, '0402');
	assert.equal((await handleApiInvokeTask({ apiFullName: 'eda.pcb_PrimitiveComponent.getAll', args: [], includeCompletePositions: true })).ok, false, 'strict position validation applies only to requested recovery readbacks');
	globalThis.eda.dmt_Pcb.getCurrentPcbInfo = originalCurrentPcbInfo;
	globalThis.eda.pcb_Document.autoRouting = async () => ({ success: false, successNetsCount: 0, duration: 0, failedNets: ['VCC'] });
	const failedRouting = await handleApiInvokeTask({ apiFullName: 'eda.pcb_Document.autoRouting', args: [] });
	assert.equal(failedRouting.ok, false);
	assert.equal(failedRouting.routingState, 'not_started');
	assert.deepEqual(failedRouting.result.failedNets, ['VCC']);
	const selectedRoutingResult = { success: true, totalNetsCount: 1, successNetsCount: 1, failedNets: [], duration: 42 };
	globalThis.eda.pcb_Document.autoRouting = async (props) => {
		assert.deepEqual(props, { RoutingNets: ['VCC'] });
		return selectedRoutingResult;
	};
	const selectedRouting = await handleApiInvokeTask({ apiFullName: 'eda.pcb_Document.autoRouting', args: [{ RoutingNets: ['VCC'] }] });
	assert.deepEqual(selectedRouting.result, selectedRoutingResult, 'native result remains intact');
	assert.deepEqual(selectedRouting.requestedRoutingNets, ['VCC']);
	assert.deepEqual(selectedRouting.reportedFailedNetsOutsideSelection, []);
	assert.equal(selectedRouting.reportedTotalNetsCountExceedsSelection, false);
	assert.equal(selectedRouting.selectionScopeUnconfirmed, false);
	assert.equal(selectedRouting.ok, undefined);
	const allUnroutedResult = { success: true, totalNetsCount: 2, successNetsCount: 2, failedNets: [], duration: 45 };
	globalThis.eda.pcb_Document.autoRouting = async (props) => {
		assert.deepEqual(props, { RoutingNets: [] });
		return allUnroutedResult;
	};
	const allUnroutedRouting = await handleApiInvokeTask({ apiFullName: 'eda.pcb_Document.autoRouting', args: [{ RoutingNets: [] }] });
	assert.deepEqual(allUnroutedRouting.result, allUnroutedResult);
	assert.deepEqual(allUnroutedRouting.requestedRoutingNets, []);
	assert.equal(allUnroutedRouting.reportedFailedNetsOutsideSelection, undefined);
	assert.equal(allUnroutedRouting.reportedTotalNetsCountExceedsSelection, undefined);
	assert.equal(allUnroutedRouting.selectionScopeUnconfirmed, undefined);
	assert.equal(allUnroutedRouting.ok, undefined, 'an empty RoutingNets array requests all unrouted nets');
	const scopeMismatchResult = { success: false, totalNetsCount: 62, successNetsCount: 0, failedNets: ['VCC', 'GND'], duration: 0 };
	globalThis.eda.pcb_Document.autoRouting = async () => scopeMismatchResult;
	const scopeMismatch = await handleApiInvokeTask({ apiFullName: 'eda.pcb_Document.autoRouting', args: [{ RoutingNets: ['VCC'] }] });
	assert.deepEqual(scopeMismatch.result, scopeMismatchResult);
	assert.deepEqual(scopeMismatch.requestedRoutingNets, ['VCC']);
	assert.deepEqual(scopeMismatch.reportedFailedNetsOutsideSelection, ['GND']);
	assert.equal(scopeMismatch.reportedTotalNetsCountExceedsSelection, true);
	assert.equal(scopeMismatch.selectionScopeUnconfirmed, true);
	assert.equal(scopeMismatch.ok, false);
	assert.equal(scopeMismatch.routingState, 'not_started');
	globalThis.eda.pcb_Document.autoRouting = async () => ({ success: true, totalNetsCount: 2, successNetsCount: 2, failedNets: [], duration: 42 });
	const countMismatch = await handleApiInvokeTask({ apiFullName: 'eda.pcb_Document.autoRouting', args: [{ RoutingNets: ['VCC'] }] });
	assert.equal(countMismatch.ok, false, 'more reported participating nets than requested must not be treated as a confirmed success');
	assert.deepEqual(countMismatch.reportedFailedNetsOutsideSelection, []);
	assert.equal(countMismatch.reportedTotalNetsCountExceedsSelection, true);
	assert.equal(countMismatch.selectionScopeUnconfirmed, true);
	globalThis.eda.pcb_Document.autoRouting = async () => ({ success: true, totalNetsCount: 3, successNetsCount: 2, failedNets: ['GND'], duration: 42 });
	const partialRouting = await handleApiInvokeTask({ apiFullName: 'eda.pcb_Document.autoRouting', args: [] });
	assert.equal(partialRouting.ok, false, 'successful start with unfinished nets must not report completed routing');
	assert.equal(partialRouting.routingState, 'incomplete');
	globalThis.eda.pcb_Document.autoRouting = async () => {
		throw new Error('RPC Call autoRouting Timed Out');
	};
	const uncertainRouting = await handleApiInvokeTask({ apiFullName: 'eda.pcb_Document.autoRouting', args: [{ RoutingNets: ['VCC'] }] });
	assert.equal(uncertainRouting.commitState, 'unknown');
	assert.equal(uncertainRouting.commitUnknown, true);
	assert.equal(uncertainRouting.retryBlocked, true);
	assert.deepEqual(uncertainRouting.requestedRoutingNets, ['VCC']);
	const originalRoutingNetPrimitives = globalThis.eda.pcb_Net.getAllPrimitivesByNet;
	const originalRoutingNetLength = globalThis.eda.pcb_Net.getNetLength;
	const originalRoutingPcbInfo = globalThis.eda.dmt_Pcb.getCurrentPcbInfo;
	let routingItems = [
		{ globalIndex: 'pad-1', pcbItemPrimitiveType: 'Pad' },
		{ globalIndex: 'pad-2', pcbItemPrimitiveType: 'Pad' },
	];
	let routingLength = 0;
	let routingPageUuid = 'pcb-1';
	globalThis.eda.dmt_Pcb.getCurrentPcbInfo = async () => ({ uuid: routingPageUuid });
	globalThis.eda.pcb_Net.getAllPrimitivesByNet = async (net) => {
		assert.equal(net, 'VCC');
		return [...routingItems];
	};
	globalThis.eda.pcb_Net.getNetLength = async (net) => {
		assert.equal(net, 'VCC');
		return routingLength;
	};
	globalThis.eda.pcb_Document.autoRouting = async () => {
		routingItems = [...routingItems, { globalIndex: 'track-1', pcbItemPrimitiveType: 'Track' }];
		routingLength = 65.677034;
		throw new Error('RPC Call autoRouting Timed Out');
	};
	const changedRouting = await handleApiInvokeTask({ apiFullName: 'eda.pcb_Document.autoRouting', args: [{ RoutingNets: ['VCC'] }] });
	assert.equal(changedRouting.commitUnknown, true, 'observed routing must retain the unknown native outcome');
	assert.equal(changedRouting.retryBlocked, true);
	assert.equal(changedRouting.routingObservation.status, 'changed');
	assert.equal(changedRouting.routingObservation.provisional, true);
	assert.equal(changedRouting.routingObservation.pageUuid, 'pcb-1');
	const serializedRouting = JSON.parse(JSON.stringify(await toSerializableAsync(changedRouting)));
	assert.equal(serializedRouting.routingObservation.status, 'changed');
	assert.equal(serializedRouting.routingObservation.nets[0].net, 'VCC');
	assert.equal(serializedRouting.routingObservation.nets[0].beforeLength, 0);
	assert.equal(serializedRouting.routingObservation.nets[0].beforeRoutingPrimitiveCount, 0);
	assert.equal(serializedRouting.routingObservation.nets[0].afterLength, 65.677034);
	assert.equal(serializedRouting.routingObservation.nets[0].afterRoutingPrimitiveCount, 1);
	assert.deepEqual(serializedRouting.routingObservation.addedRoutingPrimitiveIds, { VCC: ['track-1'] });
	assert.deepEqual(serializedRouting.routingObservation.removedRoutingPrimitiveIds, { VCC: [] });
	assert.equal(JSON.stringify(serializedRouting).includes('[MaxDepthExceeded]'), false, 'the actual Bridge wire payload must retain routing observation details');
	globalThis.eda.pcb_Document.autoRouting = async () => {
		throw new Error('RPC Call autoRouting Timed Out');
	};
	const unchangedRouting = await handleApiInvokeTask({ apiFullName: 'eda.pcb_Document.autoRouting', args: [{ RoutingNets: ['VCC'] }] });
	const serializedUnchangedRouting = JSON.parse(JSON.stringify(await toSerializableAsync(unchangedRouting)));
	assert.equal(serializedUnchangedRouting.routingObservation.status, 'unchanged');
	assert.equal(serializedUnchangedRouting.routingObservation.nets[0].beforeLength, 65.677034);
	assert.equal(serializedUnchangedRouting.routingObservation.nets[0].afterLength, 65.677034);
	assert.equal(serializedUnchangedRouting.routingObservation.nets[0].beforeRoutingPrimitiveCount, 1);
	assert.equal(serializedUnchangedRouting.routingObservation.nets[0].afterRoutingPrimitiveCount, 1);
	assert.deepEqual(serializedUnchangedRouting.routingObservation.addedRoutingPrimitiveIds, { VCC: [] });
	assert.equal(unchangedRouting.commitUnknown, true, 'no observed change must not imply a safe retry');
	let routingStarted = 0;
	globalThis.eda.pcb_Document.autoRouting = async () => {
		routingStarted += 1;
		return { success: true };
	};
	globalThis.eda.pcb_Net.getNetLength = async () => {
		routingPageUuid = 'pcb-2';
		return routingLength;
	};
	await assert.rejects(
		handleApiInvokeTask({ apiFullName: 'eda.pcb_Document.autoRouting', args: [{ RoutingNets: ['VCC'] }] }),
		/active PCB changed during autoRouting readback/,
	);
	assert.equal(routingStarted, 0, 'a PCB switch during observation must stop native autoRouting');
	routingPageUuid = 'pcb-1';
	globalThis.eda.pcb_Net.getNetLength = async () => {
		routingPageUuid = 'pcb-2';
		throw new Error('network readback failed');
	};
	await assert.rejects(
		handleApiInvokeTask({ apiFullName: 'eda.pcb_Document.autoRouting', args: [{ RoutingNets: ['VCC'] }] }),
		/active PCB changed before autoRouting invocation/,
	);
	assert.equal(routingStarted, 0, 'a failed observation still must not route a different PCB');
	routingPageUuid = 'pcb-1';
	globalThis.eda.pcb_Net.getNetLength = originalRoutingNetLength;
	globalThis.eda.pcb_Document.autoRouting = async () => {
		routingPageUuid = 'pcb-2';
		throw new Error('RPC Call autoRouting Timed Out');
	};
	const changedPageRouting = await handleApiInvokeTask({ apiFullName: 'eda.pcb_Document.autoRouting', args: [{ RoutingNets: ['VCC'] }] });
	assert.equal(changedPageRouting.routingObservation.status, 'unavailable');
	assert.equal(changedPageRouting.commitUnknown, true);
	routingPageUuid = 'pcb-1';
	globalThis.eda.pcb_Net.getAllPrimitivesByNet = originalRoutingNetPrimitives;
	globalThis.eda.pcb_Net.getNetLength = originalRoutingNetLength;
	globalThis.eda.dmt_Pcb.getCurrentPcbInfo = originalRoutingPcbInfo;
	globalThis.eda.pcb_Document.autoRouting = async () => {
		throw new Error('WebSocket closed');
	};
	const disconnectedRouting = await handleApiInvokeTask({ apiFullName: 'eda.pcb_Document.autoRouting', args: [{ RoutingNets: ['VCC'] }] });
	assert.equal(disconnectedRouting.commitUnknown, true);
	assert.deepEqual(disconnectedRouting.requestedRoutingNets, ['VCC']);
	const linePrimitives = Array.from({ length: 125 }, (_, index) => ({ primitiveId: `line-${index}`, net: 'VCC', layer: 1, startX: index, startY: 0, endX: index + 1, endY: 1, lineWidth: 0.2, primitiveLock: false }));
	globalThis.eda.pcb_PrimitiveLine = {
		async getAll() { return linePrimitives; },
	};
	globalThis.eda.pcb_PrimitiveArc = {
		async getAll() { return [{ primitiveId: 'arc-1', net: 'VCC', layer: 1, startX: 0, startY: 0, endX: 1, endY: 1, arcAngle: 90, interactiveMode: 1, lineWidth: 0.2, primitiveLock: false }]; },
	};
	const polylinePrimitives = [
		{ primitiveId: 'polyline-1', net: 'VCC', layer: 1, polygon: { getSource: () => ['L', 0, 0, 1, 1] }, lineWidth: 0.2, primitiveLock: false },
		{
			getState_PrimitiveId: () => 'board-outline-polyline',
			getState_Net: () => null,
			getState_Layer: () => 11,
			getState_Polygon: () => ({ getSource: () => [0, 0, 'L', 10, 0, 10, 10] }),
			getState_LineWidth: () => 10,
			getState_PrimitiveLock: () => false,
		},
		{ primitiveId: 'silkscreen-polyline', net: null, layer: 3, polygon: { getSource: () => ['R', 20, 20, 8, 4, 0, 0] }, lineWidth: 10, primitiveLock: false },
	];
	globalThis.eda.pcb_PrimitivePolyline = {
		async getAll() {
			return polylinePrimitives;
		},
	};
	globalThis.eda.pcb_PrimitiveVia = {
		async getAll() { return [{ primitiveId: 'via-1', net: 'VCC', x: 1, y: 2, holeDiameter: 0.3, diameter: 0.6, viaType: 1, primitiveLock: true }]; },
	};
	const lineReadback = await handleApiInvokeTask({ apiFullName: 'eda.pcb_PrimitiveLine.getAll', args: [], includeCompleteRouting: true });
	assert.equal(lineReadback.result.length, 120, 'ordinary API result remains bounded');
	assert.equal((await toSerializableAsync(lineReadback)).routingPrimitives.length, 125, 'complete routing geometry must not be truncated');
	assert.equal(lineReadback.routingPrimitives[124].endX, 125);
	assert.equal(lineReadback.routingPrimitives[124].primitiveLock, false);
	linePrimitives[0] = { ...linePrimitives[0], net: undefined };
	await assert.rejects(() => handleApiInvokeTask({ apiFullName: 'eda.pcb_PrimitiveLine.getAll', args: [], includeCompleteRouting: true }), /omitted an ID or geometry/);
	linePrimitives[0].net = 'VCC';
	const arcReadback = await handleApiInvokeTask({ apiFullName: 'eda.pcb_PrimitiveArc.getAll', args: [], includeCompleteRouting: true });
	assert.equal(arcReadback.routingPrimitives[0].arcAngle, 90);
	assert.equal(arcReadback.routingPrimitives[0].interactiveMode, 1);
	const polylineReadback = await handleApiInvokeTask({ apiFullName: 'eda.pcb_PrimitivePolyline.getAll', args: [], includeCompleteRouting: true });
	assert.equal(polylineReadback.routingPrimitives[0].polygonSource, '["L",0,0,1,1]');
	assert.equal(polylineReadback.routingPrimitiveCount, 3);
	assert.deepEqual(polylineReadback.routingPrimitives.map(item => item.primitiveId), ['polyline-1', 'board-outline-polyline', 'silkscreen-polyline']);
	assert.equal(polylineReadback.routingPrimitives[1].net, null);
	assert.equal(polylineReadback.routingPrimitives[1].layer, 11);
	assert.equal(polylineReadback.routingPrimitives[1].polygonSource, '[0,0,"L",10,0,10,10]');
	assert.equal(polylineReadback.routingPrimitives[2].net, null);
	assert.equal(polylineReadback.routingPrimitives[2].polygonSource, '["R",20,20,8,4,0,0]');
	polylinePrimitives[2] = { ...polylinePrimitives[2], net: undefined };
	await assert.rejects(() => handleApiInvokeTask({ apiFullName: 'eda.pcb_PrimitivePolyline.getAll', args: [], includeCompleteRouting: true }), /omitted an ID or geometry/);
	polylinePrimitives[2] = { ...polylinePrimitives[2], net: null };
	const viaReadback = await handleApiInvokeTask({ apiFullName: 'eda.pcb_PrimitiveVia.getAll', args: [], includeCompleteRouting: true });
	assert.equal(viaReadback.routingPrimitives[0].diameter, 0.6);
	assert.equal(viaReadback.routingPrimitives[0].primitiveLock, true);
	await assert.rejects(() => handleApiInvokeTask({ apiFullName: 'eda.pcb_PrimitiveLine.getAll', args: ['VCC'], includeCompleteRouting: true }), /only supported/);

	const project = await handleProjectInfoTask({ includePages: true });
	assert.equal(project.project.name, '2026');
	assert.equal(project.schematicPages.total, 3);
	assert.equal(project.schematicPages.returned, 3);
	assert.equal(project.schematicPages.truncated, false);
	assert.equal(project.schematicPages.items.length, 3);
	assert.equal(project.schematicPages.items[2].parentSchematicUuid, 'sch-2');
	const currentSchematicPages = globalThis.eda.dmt_Schematic.getCurrentSchematicAllSchematicPagesInfo;
	globalThis.eda.dmt_Schematic.getCurrentSchematicAllSchematicPagesInfo = async () => {
		throw new Error('No active schematic on PCB page');
	};
	assert.equal((await handleProjectInfoTask({ includePages: true })).schematicPages.total, 3);
	globalThis.eda.dmt_Schematic.getCurrentSchematicAllSchematicPagesInfo = currentSchematicPages;
	const limitedPages = await handleProjectInfoTask({ includePages: true, limit: 1 });
	assert.equal(limitedPages.schematicPages.total, 3);
	assert.equal(limitedPages.schematicPages.returned, 1);
	assert.equal(limitedPages.schematicPages.truncated, true);
	const projectInventory = await handleProjectInfoTask({ includePages: false, includeSchematics: true, includePcbs: true, includeBoards: true, includePanels: true, limit: 2 });
	assert.equal(projectInventory.schematics.items[1].name, 'Control');
	assert.equal(projectInventory.pcbs.items[1].name, 'Auxiliary PCB');
	assert.equal(projectInventory.boards.total, 2);
	assert.equal(projectInventory.boards.items[1].name, 'Auxiliary board');
	assert.equal(projectInventory.panels.items[0].name, 'Production panel');
	const context = await handleEdaContextTask({});
	assert.equal(context.environment.editorVersion, '3.2.181');
	assert.equal(context.environment.isJLCEDAProEdition, true);
	assert.equal(context.environment.frontendDataUnit, 'mm');
	const canvasSnapshot = await handleCanvasSnapshotTask({ includeData: true });
	assert.equal(canvasSnapshot.image.type, 'image/png');
	assert.ok(typeof canvasSnapshot.image.dataBase64 === 'string');
	const omittedCanvasSnapshot = await handleCanvasSnapshotTask({ maxBytes: 65536, includeData: false });
	assert.equal(omittedCanvasSnapshot.image.dataBase64, undefined);
	const projectArchive = await handleDesignArchiveExportTask({ action: 'project', fileName: 'robot', fileType: 'epro2', includeData: true });
	assert.equal(projectArchive.archive.name, 'robot.epro2');
	assert.ok(typeof projectArchive.archive.dataBase64 === 'string');
	assert.equal((await handleDesignArchiveExportTask({ action: 'document' })).archive.name, 'power.epro2');
	assert.equal((await handleDesignArchiveExportTask({ action: 'project_by_uuid', projectUuid: 'project-2' })).archive.name, 'other.epro2');
	const designSource = await handleDesignSourceExportTask({ includeData: true });
	assert.equal(designSource.source.data, 'DOCHEAD: example schematic source');
	const designSourceWithSchemaDefault = await handleDesignSourceExportTask({ limit: 50 });
	assert.equal(designSourceWithSchemaDefault.source.bytes, 33);
	const footprintSources = await handleDesignSourceExportTask({ action: 'footprints', limit: 1 });
	assert.equal(footprintSources.total, 2);
	assert.equal(footprintSources.sources[0].footprintUuid, 'footprint-1');
	assert.equal(footprintSources.sources[0].source.data, undefined);
	const workspaceCurrent = await handleWorkspaceQueryTask({});
	assert.equal(workspaceCurrent.workspace.uuid, 'workspace-1');
	const workspaceList = await handleWorkspaceQueryTask({ action: 'workspaces' });
	assert.equal(workspaceList.workspaces.length, 2);
	const teams = await handleWorkspaceQueryTask({ action: 'teams' });
	assert.equal(teams.involved.teams[0].uuid, 'team-2');
	globalThis.eda.dmt_Team.getAllInvolvedTeamInfo = async () => {
		throw new Error('Client team service is unavailable');
	};
	const teamsWithoutInvolved = await handleWorkspaceQueryTask({ action: 'teams' });
	assert.equal(teamsWithoutInvolved.direct.teams[0].uuid, 'team-1');
	assert.equal(teamsWithoutInvolved.involved.available, false);
	const projects = await handleWorkspaceQueryTask({ action: 'projects', teamUuid: 'team-1' });
	assert.equal(projects.projects[1].uuid, 'project-2');
	const folders = await handleWorkspaceQueryTask({ action: 'folders', teamUuid: 'team-1' });
	assert.equal(folders.folders[0].name, 'Robot');
	const pcbDrc = await handlePcbDrcCheckTask({});
	assert.equal(pcbDrc.errorCount, 2);
	const originalPcbDrcCheck = globalThis.eda.pcb_Drc.check;
	globalThis.eda.pcb_Drc.check = async function () {
		assert.equal(this.receiver, 'pcb-drc');
		return Array.from({ length: 130 }, (_value, index) => ({ code: `bulk-${index + 1}`, count: 1 }));
	};
	const truncatedPcbDrc = await handlePcbDrcCheckTask({});
	assert.equal(truncatedPcbDrc.errorCount, 130);
	assert.equal(truncatedPcbDrc.errors.length, 120);
	assert.equal(truncatedPcbDrc.truncated, true);
	globalThis.eda.pcb_Drc.check = originalPcbDrcCheck;
	const layers = await handlePcbLayerQueryTask({ kind: 'layers' });
	assert.equal(layers.copperLayerCount, 2);
	await assert.rejects(() => handlePcbLayerQueryTask({ kind: 'physical_stacking' }), /kind must be layers when provided/);
	const realtimeDrc = await handlePcbRealtimeDrcTask({ action: 'status' });
	assert.equal(realtimeDrc.enabled, false);
	const realtimeDrcStart = await handlePcbRealtimeDrcTask({ action: 'start' });
	assert.equal(realtimeDrcStart.changed, true);
	globalThis.eda.pcb_Drc.stopRealTimeDrc = async () => false;
	const realtimeDrcStopFailed = await handlePcbRealtimeDrcTask({ action: 'stop' });
	assert.equal(realtimeDrcStopFailed.ok, false);
	assert.equal(realtimeDrcStopFailed.changed, false);
	globalThis.eda.pcb_Drc.stopRealTimeDrc = async () => true;
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
	const region = await handlePcbDocumentTask({ action: 'primitives_in_region', left: 0, right: 100, top: 100, bottom: 0 });
	assert.equal(region.total, 2);
	const largePcbRegion = await toSerializableAsync(await handlePcbDocumentTask({ action: 'primitives_in_region', left: 0, right: 500, top: 100, bottom: 0, limit: 130 }));
	assert.equal(largePcbRegion.returned, 130);
	assert.equal(largePcbRegion.primitives.length, 130);
	assert.deepEqual((await handlePcbDocumentTask({ action: 'convert_canvas_to_data', x: 25, y: 35 })).point, { x: 15, y: 15 });
	assert.deepEqual((await handlePcbDocumentTask({ action: 'convert_data_to_canvas', x: 15, y: 15 })).point, { x: 25, y: 35 });
	assert.equal((await handlePcbDocumentTask({ action: 'navigate_to_coordinates', x: 25, y: 35 })).navigated, true);
	assert.equal((await handlePcbDocumentTask({ action: 'navigate_to_region', left: 0, right: 100, top: 100, bottom: 0 })).navigated, true);
	await assert.rejects(() => handlePcbDocumentTask({ action: 'primitives_in_region', left: 0, right: 100, top: 0, bottom: 100 }), /top >= bottom/);
	await assert.rejects(() => handlePcbDocumentTask({ action: 'navigate_to_region', left: 0, right: 100, top: 0, bottom: 100 }), /top >= bottom/);
	assert.equal((await handlePcbDocumentTask({ action: 'zoom_to_board_outline' })).zoomed, true);
	const savedPcb = await handlePcbDocumentTask({ action: 'save' });
	assert.equal(savedPcb.saved, true);
	assert.equal(savedPcb.uuid, undefined);
	await assert.rejects(() => handlePcbDocumentTask({ action: 'save', uuid: 'pcb-other' }), /uuid is not supported for save/);
	assert.equal((await handlePcbDocumentTask({ action: 'start_ratline' })).changed, true);
	assert.equal((await handlePcbDocumentTask({ action: 'stop_ratline' })).changed, true);
	await assert.rejects(() => handlePcbDocumentTask({ action: 'clear_routing' }), /routingType is required/);
	await assert.rejects(() => handlePcbDocumentTask({ action: 'clear_routing', routingType: 'connection' }), /confirm must be true/);
	assert.equal((await handlePcbDocumentTask({ action: 'clear_routing', routingType: 'connection', confirm: true })).cleared, true);
	const linkedPcbInfo = globalThis.eda.dmt_Pcb.getCurrentPcbInfo;
	const originalCurrentDocumentInfo = globalThis.eda.dmt_SelectControl.getCurrentDocumentInfo;
	globalThis.eda.dmt_SelectControl.getCurrentDocumentInfo = async () => ({ uuid: 'pcb-1', parentProjectUuid: 'project-1' });
	const nativeImportChanges = globalThis.eda.pcb_Document.importChanges;
	globalThis.eda.dmt_SelectControl.getCurrentDocumentInfo = async () => ({ uuid: 'pcb-previous', parentProjectUuid: 'project-1' });
	globalThis.eda.pcb_Document.importChanges = async () => {
		throw new Error('Native import must not run before the PCB page identity settles.');
	};
	const stalePcbImport = await handlePcbDocumentTask({ action: 'import_changes', uuid: 'sch-1' });
	assert.equal(stalePcbImport.reason, 'pcb_page_not_ready');
	assert.equal(stalePcbImport.commitState, 'not_started');
	globalThis.eda.dmt_SelectControl.getCurrentDocumentInfo = async () => ({ uuid: 'pcb-1', parentProjectUuid: 'project-1' });
	globalThis.eda.dmt_Pcb.getCurrentPcbInfo = async () => ({ uuid: 'pcb-1' });
	globalThis.eda.pcb_Document.importChanges = async () => {
		throw new Error('Native import must not run for an unlinked PCB.');
	};
	const unlinkedPcbImport = await handlePcbDocumentTask({ action: 'import_changes', uuid: 'sch-1' });
	assert.equal(unlinkedPcbImport.ok, false);
	assert.equal(unlinkedPcbImport.reason, 'pcb_not_associated_with_board');
	assert.equal(unlinkedPcbImport.commitState, 'not_started');
	assert.equal(unlinkedPcbImport.requiresNativeConfirmation, false);
	globalThis.eda.dmt_Pcb.getCurrentPcbInfo = async () => {
		throw new Error('PCB metadata unavailable');
	};
	const unavailablePcbImport = await handlePcbDocumentTask({ action: 'import_changes', uuid: 'sch-1' });
	assert.equal(unavailablePcbImport.reason, 'pcb_identity_unavailable');
	assert.equal(unavailablePcbImport.commitState, 'not_started');
	assert.equal(unavailablePcbImport.requiresNativeConfirmation, false);
	globalThis.eda.dmt_Pcb.getCurrentPcbInfo = linkedPcbInfo;
	globalThis.eda.pcb_Document.importChanges = nativeImportChanges;
	const pendingPcbImport = await handlePcbDocumentTask({ action: 'import_changes', uuid: 'sch-1' });
	assert.equal(pendingPcbImport.imported, true);
	assert.equal(pendingPcbImport.commitState, 'pending_confirmation');
	assert.equal(pendingPcbImport.importContext.pageUuid, 'pcb-1');
	assert.equal(pendingPcbImport.requiresNativeConfirmation, true);
	assert.equal((await handlePcbDocumentTask({ action: 'import_auto_route_json', fileName: 'route.json', dataBase64: 'e30=' })).bytes, 2);
	assert.equal((await handlePcbDocumentTask({ action: 'import_auto_route_ses', fileName: 'route.ses', dataBase64: 'e30=' })).imported, true);
	assert.equal((await handlePcbDocumentTask({ action: 'import_auto_layout_json', fileName: 'layout.json', dataBase64: 'e30=' })).imported, true);
	globalThis.eda.pcb_SelectControl.doSelectPrimitives = async () => false;
	globalThis.eda.pcb_SelectControl.clearSelected = async () => false;
	globalThis.eda.pcb_Document.navigateToCoordinates = async () => false;
	globalThis.eda.pcb_Document.navigateToRegion = async () => false;
	globalThis.eda.pcb_Document.zoomToBoardOutline = async () => false;
	globalThis.eda.pcb_Document.save = async () => false;
	globalThis.eda.pcb_Document.startCalculatingRatline = async () => false;
	globalThis.eda.pcb_Document.stopCalculatingRatline = async () => false;
	globalThis.eda.pcb_Document.clearRouting = async () => false;
	globalThis.eda.pcb_Document.importChanges = async () => false;
	globalThis.eda.pcb_Document.importAutoRouteJsonFile = async () => false;
	globalThis.eda.pcb_Document.importAutoRouteSesFile = async () => false;
	globalThis.eda.pcb_Document.importAutoLayoutJsonFile = async () => false;
	assert.equal((await handlePcbDocumentTask({ action: 'select_primitives', ids: ['pad-1'] })).ok, false);
	assert.equal((await handlePcbDocumentTask({ action: 'clear_selection' })).ok, false);
	assert.equal((await handlePcbDocumentTask({ action: 'navigate_to_coordinates', x: 25, y: 35 })).ok, false);
	assert.equal((await handlePcbDocumentTask({ action: 'navigate_to_region', left: 0, right: 100, top: 100, bottom: 0 })).ok, false);
	assert.equal((await handlePcbDocumentTask({ action: 'zoom_to_board_outline' })).ok, false);
	assert.equal((await handlePcbDocumentTask({ action: 'save' })).ok, false);
	assert.equal((await handlePcbDocumentTask({ action: 'start_ratline' })).ok, false);
	assert.equal((await handlePcbDocumentTask({ action: 'stop_ratline' })).ok, false);
	assert.equal((await handlePcbDocumentTask({ action: 'clear_routing', routingType: 'connection', confirm: true })).ok, false);
	const rejectedPcbImport = await handlePcbDocumentTask({ action: 'import_changes', uuid: 'sch-1' });
	assert.equal(rejectedPcbImport.ok, false);
	assert.equal(rejectedPcbImport.commitState, 'not_started');
	globalThis.eda.dmt_SelectControl.getCurrentDocumentInfo = originalCurrentDocumentInfo;
	assert.equal((await handlePcbDocumentTask({ action: 'import_auto_route_json', dataBase64: 'e30=' })).ok, false);
	assert.equal((await handlePcbDocumentTask({ action: 'import_auto_route_ses', dataBase64: 'e30=' })).ok, false);
	assert.equal((await handlePcbDocumentTask({ action: 'import_auto_layout_json', dataBase64: 'e30=' })).ok, false);
	const pcbNetAnalysis = await handlePcbNetQueryTask({ mode: 'exact', query: 'USB_D+', analysis: { length: true, color: true, primitiveTypes: ['POLYLINE', 'VIA'] } });
	assert.equal(pcbNetAnalysis.length, 42.5);
	assert.equal(pcbNetAnalysis.color, '#00ff00');
	assert.equal(pcbNetAnalysis.primitiveCount, 2);
	assert.deepEqual(pcbNetAnalysis.primitives.map(primitive => primitive.globalIndex), ['polyline-1', 'via-1']);
	const pcbNetRoutingAndPads = await handlePcbNetQueryTask({ mode: 'exact', query: 'USB_D+', analysis: { primitiveTypes: ['PAD', 'COMPONENT_PAD', 'LINE', 'ARC', 'POLYLINE', 'VIA'] } });
	assert.equal(pcbNetRoutingAndPads.primitiveCount, 5);
	const pcbNetComponentPads = await handlePcbNetQueryTask({ mode: 'exact', query: 'USB_D+', analysis: { primitiveTypes: ['COMPONENT_PAD'] } });
	assert.deepEqual(pcbNetComponentPads.primitives.map(primitive => primitive.globalIndex), ['pad-1']);
	const pcbNetStandalonePads = await handlePcbNetQueryTask({ mode: 'exact', query: 'USB_D+', analysis: { primitiveTypes: ['PAD'] } });
	assert.deepEqual(pcbNetStandalonePads.primitives.map(primitive => primitive.globalIndex), ['pad-2']);
	const pcbNetLines = await handlePcbNetQueryTask({ mode: 'exact', query: 'USB_D+', analysis: { primitiveTypes: ['LINE'] } });
	assert.deepEqual(pcbNetLines.primitives.map(primitive => primitive.globalIndex), ['track-1']);
	const originalGetAllPrimitivesByNet = globalThis.eda.pcb_Net.getAllPrimitivesByNet;
	globalThis.eda.pcb_Net.getAllPrimitivesByNet = async (name, primitiveTypes) => {
		assert.equal(name, 'USB_D+');
		assert.equal(primitiveTypes, undefined);
		return Array.from({ length: 130 }, (_value, index) => ({ uuid: `primitive-${index + 1}` }));
	};
	const truncatedPcbNetAnalysis = await handlePcbNetQueryTask({ mode: 'exact', query: 'USB_D+', analysis: { primitives: true } });
	assert.equal(truncatedPcbNetAnalysis.primitiveCount, 130);
	assert.equal(truncatedPcbNetAnalysis.primitives.length, 120);
	assert.equal(truncatedPcbNetAnalysis.primitivesTruncated, true);
	globalThis.eda.pcb_Net.getAllPrimitivesByNet = originalGetAllPrimitivesByNet;
	await assert.rejects(() => handlePcbNetQueryTask({ mode: 'exact', query: 'USB_D+', analysis: { primitiveTypes: [] } }), /analysis\.primitiveTypes/);
	const filteredPcbNets = await handlePcbNetQueryTask({ query: 'USB' });
	assert.equal(filteredPcbNets.total, 1);
	assert.equal(filteredPcbNets.returned, 1);
	assert.equal(filteredPcbNets.truncated, false);
	globalThis.eda.pcb_Net.getAllNets = async () => Array.from({ length: 130 }, (_, index) => ({ name: `NET_${index + 1}` }));
	const largePcbNetList = await toSerializableAsync(await handlePcbNetQueryTask({ limit: 130 }));
	assert.equal(largePcbNetList.total, 130);
	assert.equal(largePcbNetList.returned, 130);
	assert.equal(largePcbNetList.nets.length, 130);
	globalThis.eda.pcb_Net.getAllNets = async () => [{ name: 'USB_D+' }, { name: 'GND' }];
	globalThis.eda.pcb_Net.getAllNetsName = async () => Array.from({ length: 1001 }, (_, index) => `NET_${index}`);
	const finalNetPage = await handlePcbNetQueryTask({ mode: 'names', offset: 1000, limit: 1000 });
	assert.equal(finalNetPage.total, 1001);
	assert.equal(finalNetPage.offset, 1000);
	assert.deepEqual(finalNetPage.names, ['NET_1000']);
	assert.equal(finalNetPage.truncated, false);
	await assert.rejects(() => handlePcbNetQueryTask({ mode: 'names', offset: -1 }), /non-negative integer/);
	delete globalThis.eda.pcb_Net.getAllNetsName;
	globalThis.eda.pcb_Net.getAllNets = async () => [{ net: 'NET_A' }, { net: 'NET_B' }];
	assert.deepEqual((await handlePcbNetQueryTask({ mode: 'names', offset: 1, limit: 1 })).names, ['NET_B']);
	globalThis.eda.pcb_Net.getAllNets = async () => [{ name: 'USB_D+' }, { name: 'GND' }];
	await assert.rejects(() => handleManufactureExportTask({ domain: 'pcb', kind: 'netlist', netlistType: 'Ngspice' }), /netlistType must be one of: Allegro, PADS, Protel2, JLCEDA/);
	await assert.rejects(() => handleManufactureExportTask({ domain: 'schematic', kind: 'simulation_netlist', netlistType: 'Allegro' }), /netlistType must be one of: Ngspice/);
	globalThis.eda.pcb_Drc.modifyDifferentialPairName = async () => true;
	globalThis.eda.pcb_Drc.getAllDifferentialPairs = async () => ({ USB_PAIR_RENAMED: { name: 'USB_PAIR_RENAMED', positiveNet: 'USB_D+', negativeNet: 'USB_D-' } });
	const objectReadback = await handlePcbConstraintsManageTask({ kind: 'differential_pair', operation: 'rename', name: 'USB_PAIR', newName: 'USB_PAIR_RENAMED', confirm: true });
	assert.equal(objectReadback.readback.total, 1);
	assert.deepEqual(objectReadback.readback.item, { name: 'USB_PAIR_RENAMED', positiveNet: 'USB_D+', negativeNet: 'USB_D-' });
	globalThis.eda.pcb_Drc.getAllDifferentialPairs = async () => differentialPairs;
	const schDrc = await handleSchematicDrcCheckTask({});
	assert.equal(schDrc.ok, true);
	assert.equal((await handleAutoLayoutTask({})).ok, true);
	assert.equal((await handleAutoRoutingTask({})).ok, true);
	const originalAutoLayout = globalThis.eda.sch_Document.autoLayout;
	const originalAutoRouting = globalThis.eda.sch_Document.autoRouting;
	globalThis.eda.sch_Document.autoLayout = async () => false;
	globalThis.eda.sch_Document.autoRouting = async () => false;
	assert.equal((await handleAutoLayoutTask({})).ok, false);
	assert.equal((await handleAutoRoutingTask({})).ok, false);
	globalThis.eda.sch_Document.autoLayout = originalAutoLayout;
	globalThis.eda.sch_Document.autoRouting = originalAutoRouting;
	const originalSchematicDrcCheck = globalThis.eda.sch_Drc.check;
	globalThis.eda.sch_Drc.check = async () => Array.from({ length: 130 }, (_value, index) => ({ code: `bulk-${index + 1}`, count: 1 }));
	const truncatedSchematicDrc = await handleSchematicDrcCheckTask({});
	assert.equal(truncatedSchematicDrc.errorCount, 130);
	assert.equal(truncatedSchematicDrc.errors.length, 120);
	assert.equal(truncatedSchematicDrc.truncated, true);
	globalThis.eda.sch_Drc.check = originalSchematicDrcCheck;
	assert.deepEqual((await handleSchematicDocumentTask({ action: 'status' })).filterConfiguration, { wires: true });
	const schSelection = await handleSchematicDocumentTask({ action: 'selection', includeObjects: true });
	assert.equal(schSelection.selectedCount, 1);
	assert.equal(schSelection.selectedPrimitives.length, 1);
	assert.deepEqual((await handleSchematicDocumentTask({ action: 'mouse_position' })).position, { x: 25, y: 35 });
	assert.equal((await handleSchematicDocumentTask({ action: 'primitive_at_point', x: 25, y: 35 })).primitive.uuid, 'sch-pin-1');
	assert.equal((await handleSchematicDocumentTask({ action: 'primitives_in_region', left: 0, right: 100, top: 100, bottom: 0 })).total, 1);
	const largeSchematicRegion = await toSerializableAsync(await handleSchematicDocumentTask({ action: 'primitives_in_region', left: 0, right: 500, top: 100, bottom: 0, limit: 130 }));
	assert.equal(largeSchematicRegion.returned, 130);
	assert.equal(largeSchematicRegion.primitives.length, 130);
	assert.equal((await handleSchematicDocumentTask({ action: 'navigate_to_coordinates', x: 25, y: 35 })).navigated, true);
	assert.equal((await handleSchematicDocumentTask({ action: 'navigate_to_region', left: 0, right: 100, top: 100, bottom: 0 })).navigated, true);
	await assert.rejects(() => handleSchematicDocumentTask({ action: 'primitives_in_region', left: 0, right: 100, top: 0, bottom: 100 }), /top >= bottom/);
	await assert.rejects(() => handleSchematicDocumentTask({ action: 'navigate_to_region', left: 0, right: 100, top: 0, bottom: 100 }), /top >= bottom/);
	assert.equal((await handleSchematicDocumentTask({ action: 'select_primitives', ids: ['sch-pin-1'] })).selected, true);
	assert.equal((await handleSchematicDocumentTask({ action: 'clear_selection' })).cleared, true);
	assert.equal((await handleSchematicDocumentTask({ action: 'primitive_type_by_id', id: 'sch-pin-1' })).primitiveType, 'PIN');
	assert.equal((await handleSchematicDocumentTask({ action: 'primitive_by_id', id: 'sch-pin-1' })).primitive.uuid, 'sch-pin-1');
	assert.equal((await handleSchematicDocumentTask({ action: 'primitives_by_id', ids: ['sch-pin-1'] })).primitives.length, 1);
	assert.deepEqual((await handleSchematicDocumentTask({ action: 'primitives_bbox', ids: ['sch-pin-1'] })).bounds, { minX: 1, minY: 2, maxX: 3, maxY: 4 });
	assert.equal((await handleSchematicDocumentTask({ action: 'save' })).saved, true);
	assert.equal((await handleSchematicDocumentTask({ action: 'import_changes' })).imported, true);
	globalThis.eda.sch_Document.navigateToCoordinates = async () => false;
	globalThis.eda.sch_Document.navigateToRegion = async () => false;
	globalThis.eda.sch_Document.save = async () => false;
	globalThis.eda.sch_Document.importChanges = async () => false;
	globalThis.eda.sch_SelectControl.doSelectPrimitives = async () => false;
	globalThis.eda.sch_SelectControl.clearSelected = async () => false;
	assert.equal((await handleSchematicDocumentTask({ action: 'navigate_to_coordinates', x: 25, y: 35 })).ok, false);
	assert.equal((await handleSchematicDocumentTask({ action: 'navigate_to_region', left: 0, right: 100, top: 100, bottom: 0 })).ok, false);
	assert.equal((await handleSchematicDocumentTask({ action: 'save' })).ok, false);
	assert.equal((await handleSchematicDocumentTask({ action: 'import_changes' })).ok, false);
	assert.equal((await handleSchematicDocumentTask({ action: 'select_primitives', ids: ['sch-pin-1'] })).ok, false);
	assert.equal((await handleSchematicDocumentTask({ action: 'clear_selection' })).ok, false);
	const createdPage = await handleSchematicPagesManageTask({ operation: 'create', schematicUuid: 'sch-1', confirm: true });
	assert.equal(createdPage.pageUuid, 'page-4');
	assert.equal(createdPage.readback.total, 3);
	const copiedPage = await handleSchematicPagesManageTask({ operation: 'copy', sourcePageUuid: 'page-1', schematicUuid: 'sch-1', confirm: true });
	assert.equal(copiedPage.pageUuid, 'page-5');
	assert.equal(copiedPage.readback.total, 4);
	const renamedPage = await handleSchematicPagesManageTask({ operation: 'rename', schematicPageUuid: 'page-4', newName: 'Interfaces', confirm: true });
	assert.equal(renamedPage.readback.pages.find(page => page.uuid === 'page-4').name, 'Interfaces');
	const reorderedPages = await handleSchematicPagesManageTask({ operation: 'reorder', schematicUuid: 'sch-1', orderedPageUuids: ['page-5', 'page-4', 'page-2', 'page-1'], confirm: true });
	assert.equal(reorderedPages.readback.verified, true);
	assert.deepEqual(reorderedPages.readback.pageUuids, ['page-5', 'page-4', 'page-2', 'page-1']);
	await assert.rejects(() => handleSchematicPagesManageTask({ operation: 'reorder', schematicUuid: 'sch-1', orderedPageUuids: ['page-1', 'page-1'], confirm: true }), /must not contain duplicates/);
	await assert.rejects(() => handleSchematicPagesManageTask({ operation: 'reorder', schematicUuid: 'sch-1', orderedPageUuids: ['page-1'], confirm: true }), /include every page/);
	await assert.rejects(() => handleSchematicPagesManageTask({ operation: 'create', schematicUuid: 'sch-1', confirm: false }), /confirm must be true/);
	await assert.rejects(() => handleSchematicPagesManageTask({ operation: 'rename', schematicPageUuid: 'page-1', newName: 'Unsafe', deleted: true, confirm: true }), /deleted is not supported/);
	const constraints = await handlePcbConstraintsQueryTask({ kind: 'differential_pairs' });
	assert.equal(constraints.count, 1);
	assert.equal((await handlePcbConstraintsQueryTask({ kind: 'current_rule_configuration_name' })).result, 'current');
	assert.equal((await handlePcbConstraintsQueryTask({ kind: 'default_rule_configuration_name' })).result, 'default');
	const netRules = await handlePcbConstraintsQueryTask({ kind: 'net_rules' });
	assert.equal(netRules.count, 1);
	const padPairMinimum = await handlePcbConstraintsQueryTask({ kind: 'pad_pair_min_wire_length', padPairGroupName: 'USB_PADS' });
	assert.equal(padPairMinimum.count, 1);
	const namedRule = await handlePcbConstraintsQueryTask({ kind: 'rule_configuration', configurationName: 'strict' });
	assert.equal(namedRule.result.name, 'strict');
	const ruleConfigurations = await handlePcbConstraintsQueryTask({ kind: 'rule_configurations', includeSystem: true });
	assert.equal(ruleConfigurations.count, 1);
	const netClass = await handlePcbConstraintsManageTask({ kind: 'net_class', operation: 'create', name: 'USB', nets: ['USB_D+', 'USB_D-'], color: { r: 0, g: 120, b: 255, alpha: 1 }, confirm: true });
	assert.equal(netClass.readback.total, 1);
	assert.deepEqual(netClass.readback.item.nets, ['USB_D+', 'USB_D-']);
	const netClassWithMember = await handlePcbConstraintsManageTask({ kind: 'net_class', operation: 'add_members', name: 'USB', nets: ['USB_VBUS'], confirm: true });
	assert.deepEqual(netClassWithMember.readback.item.nets, ['USB_D+', 'USB_D-', 'USB_VBUS']);
	const netClassWithoutMember = await handlePcbConstraintsManageTask({ kind: 'net_class', operation: 'remove_members', name: 'USB', nets: ['USB_VBUS'], confirm: true });
	assert.deepEqual(netClassWithoutMember.readback.item.nets, ['USB_D+', 'USB_D-']);
	netClasses.push(...Array.from({ length: 130 }, (_value, index) => ({ name: `BULK_${String(index)}`, nets: [], color: undefined })));
	const largeNetClasses = await handlePcbConstraintsQueryTask({ kind: 'net_classes' });
	assert.equal(largeNetClasses.count, 131);
	assert.equal(largeNetClasses.returned, 120);
	assert.equal(largeNetClasses.truncated, true);
	const largeRename = await handlePcbConstraintsManageTask({ kind: 'net_class', operation: 'rename', name: 'BULK_129', newName: 'BULK_RENAMED', confirm: true });
	assert.equal(largeRename.readback.total, 131);
	assert.equal(largeRename.readback.item.name, 'BULK_RENAMED');
	const differentialPair = await handlePcbConstraintsManageTask({ kind: 'differential_pair', operation: 'create', name: 'USB_PAIR', positiveNet: 'USB_D+', negativeNet: 'USB_D-', confirm: true });
	assert.equal(differentialPair.readback.item.positiveNet, 'USB_D+');
	const updatedDifferentialPair = await handlePcbConstraintsManageTask({ kind: 'differential_pair', operation: 'set_positive_net', name: 'USB_PAIR', positiveNet: 'USB_DP', confirm: true });
	assert.equal(updatedDifferentialPair.readback.item.positiveNet, 'USB_DP');
	const equalLengthGroup = await handlePcbConstraintsManageTask({ kind: 'equal_length_group', operation: 'create', name: 'MEMORY', nets: ['DQ0', 'DQ1'], color: { r: 255, g: 100, b: 0, alpha: 0.8 }, confirm: true });
	assert.equal(equalLengthGroup.readback.item.name, 'MEMORY');
	const padPairGroup = await handlePcbConstraintsManageTask({ kind: 'pad_pair_group', operation: 'create', name: 'USB_PADS', padPairs: [['J1.1', 'U1.1']], confirm: true });
	assert.deepEqual(padPairGroup.readback.item.padPairs, [['J1.1', 'U1.1']]);
	await assert.rejects(() => handlePcbConstraintsManageTask({ kind: 'net_class', operation: 'delete', name: 'USB', confirm: false }), /confirm must be true/);
	await assert.rejects(() => handlePcbConstraintsManageTask({ kind: 'differential_pair', operation: 'create', name: 'BAD', positiveNet: 'P', negativeNet: 'N', nets: ['unexpected'], confirm: true }), /nets is not supported/);
	const exactComponent = await handleComponentSelectTask({ properties: { supplierId: 'C1523' }, limit: 2 });
	assert.equal(exactComponent.searchMode, 'properties');
	assert.equal(exactComponent.selection.candidates[0].libraryUuid, 'system-library-1');
	const symbolSearch = await handleLibrarySearchTask({ kind: 'symbol', keyword: 'LM358' });
	assert.equal(symbolSearch.items[0].uuid, 'symbol-1');
	const pagedDeviceSearch = await handleLibrarySearchTask({ kind: 'device', keyword: 'paged', limit: 20, page: 2 });
	assert.equal(pagedDeviceSearch.returned, 20);
	assert.equal(pagedDeviceSearch.page, 2);
	assert.equal(pagedDeviceSearch.pageSize, 20);
	assert.equal(pagedDeviceSearch.total, undefined);
	assert.equal(pagedDeviceSearch.totalKnown, false);
	assert.equal(pagedDeviceSearch.mayHaveMore, true);
	// #72：宿主忽略 name 时，不得把连接器当作精确电阻匹配。
	const savedDeviceSearch = globalThis.eda.lib_Device.search;
	const savedDeviceProperties = globalThis.eda.lib_Device.searchByProperties;
	const resistorName = '0603WAF6202T5E';
	globalThis.eda.lib_Device.searchByProperties = async () => [{ uuid: 'connector', name: '842-044-521-102' }];
	globalThis.eda.lib_Device.search = async (keyword, libraryUuid, classification, symbolType, limit, page) => {
		assert.deepEqual([keyword, libraryUuid, classification, symbolType, limit, page], [resistorName, 'system-library-1', undefined, undefined, 3, 2]);
		return [{ uuid: 'prefix', name: `${resistorName}-ALT` }, { uuid: 'resistor', name: resistorName, supplierId: 'C23221' }, { uuid: 'other-supplier', name: resistorName, supplierId: 'C00000' }];
	};
	const exactNameQuery = { kind: 'device', properties: { name: resistorName }, libraryUuid: 'system-library-1', limit: 3, page: 2 };
	const exactNameSearch = await handleLibrarySearchTask(exactNameQuery);
	assert.deepEqual(exactNameSearch.items.map(item => item.uuid), ['resistor', 'other-supplier']);
	assert.equal(exactNameSearch.exactNameVerified, true);
	assert.equal(exactNameSearch.searchImplementation, 'keyword_name_fallback');
	assert.equal(exactNameSearch.mayHaveMore, true, 'pagination uses the native candidate page, not the filtered hit count');
	const combinedNameSearch = await handleLibrarySearchTask({ ...exactNameQuery, properties: { name: resistorName, supplierId: 'C23221' } });
	assert.deepEqual(combinedNameSearch.items.map(item => item.uuid), ['resistor'], 'keyword fallback must also verify requested extra properties');
	globalThis.eda.lib_Device.search = async () => [{ uuid: 'connector', name: '842-044-521-102' }];
	assert.equal((await handleLibrarySearchTask(exactNameQuery)).returned, 0);
	globalThis.eda.lib_Device.searchByProperties = async () => [{ uuid: 'resistor', name: resistorName }, { uuid: 'connector', name: '842-044-521-102' }];
	globalThis.eda.lib_Device.search = async () => {
		throw new Error('Native exact name matches must not call keyword fallback');
	};
	const nativeNameSearch = await handleLibrarySearchTask(exactNameQuery);
	assert.deepEqual(nativeNameSearch.items.map(item => item.uuid), ['resistor']);
	assert.equal(nativeNameSearch.searchImplementation, 'native_properties');
	assert.equal(nativeNameSearch.excludedNameMismatches, 1);
	globalThis.eda.lib_Device.search = savedDeviceSearch;
	globalThis.eda.lib_Device.searchByProperties = savedDeviceProperties;
	const classifications = await handleLibraryClassificationTask({ kind: 'symbol', libraryUuid: 'system-library-1' });
	assert.equal(classifications.total, 2);
	assert.equal(classifications.tree[0].children[0].name, 'Operational');
	const deviceGet = await handleLibrarySearchTask({ kind: 'device', uuid: 'device-1', libraryUuid: 'system-library-1' });
	assert.equal(deviceGet.item.name, 'R0402');
	const symbolGet = await handleLibrarySearchTask({ kind: 'symbol', uuid: 'symbol-1', libraryUuid: 'system-library-1' });
	assert.equal(symbolGet.item.name, 'LM358');
	const footprintGet = await handleLibrarySearchTask({ kind: 'footprint', uuid: 'footprint-1', libraryUuid: 'system-library-1' });
	assert.equal(footprintGet.item.name, 'SOIC-8');
	const symbolPreview = await handleLibraryPreviewTask({ kind: 'symbol', uuid: 'symbol-1', libraryUuid: 'system-library-1', subPartName: 'A', includeData: true });
	assert.equal(symbolPreview.image.type, 'image/svg+xml');
	assert.ok(typeof symbolPreview.image.dataBase64 === 'string');
	const footprintPreview = await handleLibraryPreviewTask({ kind: 'footprint', uuid: 'footprint-1', libraryUuid: 'system-library-1' });
	assert.equal(footprintPreview.image.dataBase64, undefined);
	const footprintSearch = await handleLibrarySearchTask({ kind: 'footprint', keyword: 'SOIC-8' });
	assert.equal(footprintSearch.items[0].name, 'SOIC-8');
	const modelSearch = await handleLibrarySearchTask({ kind: 'model_3d', keyword: 'SOT-23' });
	assert.equal(modelSearch.items[0].uuid, 'model-1');
	const modelGet = await handleLibrarySearchTask({ kind: 'model_3d', uuid: 'model-1' });
	assert.equal(modelGet.item.name, 'SOT-23 3D');
	const cbbSearch = await handleLibrarySearchTask({ kind: 'cbb', keyword: 'Buck' });
	assert.equal(cbbSearch.items[0].uuid, 'cbb-1');
	const panelGet = await handleLibrarySearchTask({ kind: 'panel_library', uuid: 'panel-1' });
	assert.equal(panelGet.item.name, 'Panel A');
	const simulationSearch = await handleLibrarySearchTask({ kind: 'simulation_model', keyword: 'resistor', simulationModelType: 'Ngspice', libraryUuid: 'system-library-1', limit: 3, page: 2 });
	assert.equal(simulationSearch.items[0].uuid, 'simulation-1');
	await assert.rejects(() => handleLibrarySearchTask({ kind: 'simulation_model', uuid: 'simulation-1' }), /only supports keyword search/);
	const librarySources = await toSerializableAsync(await handleLibrarySourcesTask({ limit: 130 }));
	assert.equal(librarySources.total, 130);
	assert.equal(librarySources.libraries.length, 130);
	assert.equal(librarySources.knownLibraryUuids.project, 'project-library-1');
	const apiIndex = await toSerializableAsync(await handleApiIndexTask({}));
	assert.ok(apiIndex.total > 120);
	assert.equal(apiIndex.index.length, apiIndex.total);
	assert.equal(new Set(apiIndex.index.map(entry => entry.fullName)).size, apiIndex.index.length);
	assert.ok(apiIndex.index.some(entry => entry.fullName === 'eda.sch_Document.autoRouting'));
	const apiSearch = await handleApiSearchTask({ query: 'getRealTimeDrcStatus', scope: 'callable' });
	assert.ok(apiSearch.items.some(item => item.fullName === 'eda.pcb_Drc.getRealTimeDrcStatus'));
	const renderImageSearch = await handleApiSearchTask({ query: 'getRenderImage', scope: 'callable', owner: 'lib_Symbol' });
	assert.ok(renderImageSearch.items.some(item => item.fullName === 'eda.lib_Symbol.getRenderImage'));
	const lcscSearch = await handleLibrarySearchTask({ kind: 'device', lcscIds: ['C1523', 'C17168'], allowMultiMatch: true });
	assert.equal(lcscSearch.searchMode, 'lcsc_ids');
	assert.equal(lcscSearch.items.length, 2);
	const singleLcscSearch = await handleLibrarySearchTask({ kind: 'device', lcscIds: ['C1523'], allowMultiMatch: true });
	assert.equal(singleLcscSearch.items.length, 2);
	const manyLcscSearch = await handleLibrarySearchTask({ kind: 'device', lcscIds: ['C99999'], allowMultiMatch: true, limit: 20 });
	assert.equal(manyLcscSearch.total, 130);
	assert.equal(manyLcscSearch.returned, 20);
	assert.equal(manyLcscSearch.truncated, true);
	assert.equal(manyLcscSearch.page, undefined);
	await assert.rejects(() => handleLibrarySearchTask({ kind: 'device', lcscIds: ['C99999'], page: 2 }), /page is not supported for lcscIds/);
	const comparison = await handleNetlistCompareTask({ sourceA: 'pcb-1', sourceB: { projectUuid: 'project-1', documentUuid: 'pcb-2' } });
	assert.equal(comparison.differenceCount, 1);
	const truncatedNetlistComparison = await handleNetlistCompareTask({ sourceA: 'net-many', sourceB: 'net-many-other' });
	assert.equal(truncatedNetlistComparison.differenceCount, 130);
	assert.equal(truncatedNetlistComparison.byType.Net, 130);
	assert.equal(truncatedNetlistComparison.differences.length, 120);
	assert.equal(truncatedNetlistComparison.truncated, true);
	const schematicComparison = await handleDesignCompareTask({ domain: 'schematic', sourceA: 'sch-1', sourceB: 'sch-2' });
	assert.equal(schematicComparison.result.changed, 2);
	const designNetlistComparison = await handleDesignCompareTask({ domain: 'netlist', sourceA: 'net-1', sourceB: { projectUuid: 'project-1', documentUuid: 'net-2' } });
	assert.equal(designNetlistComparison.differenceCount, 1);
	assert.equal(designNetlistComparison.returned, 1);
	assert.equal(designNetlistComparison.truncated, false);
	const truncatedDesignComparison = await handleDesignCompareTask({ domain: 'netlist', sourceA: 'net-many', sourceB: 'net-many-other' });
	assert.equal(truncatedDesignComparison.differenceCount, 130);
	assert.equal(truncatedDesignComparison.returned, 120);
	assert.equal(truncatedDesignComparison.differences.length, 120);
	assert.equal(truncatedDesignComparison.truncated, true);
	const pcbComparison = await handleDesignCompareTask({ domain: 'pcb', sourceA: 'pcb-1', sourceB: { projectUuid: 'project-1', pcbUuid: 'pcb-2' } });
	assert.equal(pcbComparison.ok, true);
	assert.equal(pcbComparison.result.data.changed, 3);
	globalThis.eda.sys_Tool.pcbComparison = async () => ({ success: false, error: { code: 'INCOMPATIBLE', message: 'Cannot compare the requested boards.' } });
	const failedPcbComparison = await handleDesignCompareTask({ domain: 'pcb', sourceA: 'pcb-1', sourceB: { projectUuid: 'project-1', pcbUuid: 'pcb-2' } });
	assert.equal(failedPcbComparison.ok, false);
	assert.equal(failedPcbComparison.result.error.code, 'INCOMPATIBLE');
	const templates = await handleManufactureTemplatesQueryTask({ domain: 'pcb' });
	assert.deepEqual(templates.templates, ['jlcpcb', 'assembly']);
	const exportResult = await handleManufactureExportTask({ domain: 'pcb', kind: 'bom', template: 'jlcpcb', includeData: true });
	assert.equal(exportResult.ok, true);
	assert.equal(exportResult.file.type, 'text/csv');
	assert.ok(typeof exportResult.file.dataBase64 === 'string');
	const schematicTemplates = await handleManufactureTemplatesQueryTask({ domain: 'schematic' });
	assert.equal(schematicTemplates.templates, undefined);
	assert.deepEqual(schematicTemplates.assemblyVariants, [{ text: 'Prototype', value: 'prototype' }]);
	const schematicBom = await handleManufactureExportTask({ domain: 'schematic', kind: 'bom', assemblyVariantsConfig: { text: 'Prototype', value: 'prototype' } });
	assert.equal(schematicBom.ok, true);
	const flyingProbeExport = await handleManufactureExportTask({ domain: 'pcb', kind: 'flying_probe_test' });
	assert.equal(flyingProbeExport.ok, true);
	const autoLayoutExport = await handleManufactureExportTask({ domain: 'pcb', kind: 'auto_layout_json' });
	assert.equal(autoLayoutExport.file.preview, '{"components":[]}');
	const odbExport = await handleManufactureExportTask({ domain: 'pcb', kind: 'open_database', unit: 'mm' });
	assert.equal(odbExport.ok, true);
	await assert.rejects(() => handleManufactureExportTask({ domain: 'pcb', kind: 'gerber', unit: 'mil' }), /unit must be one of: mm, inch/);
	await assert.rejects(() => handleManufactureExportTask({ domain: 'pcb', kind: 'pick_and_place', unit: 'in' }), /unit must be one of: mm, mil/);
	await assert.rejects(() => handleManufactureExportTask({ domain: 'pcb', kind: 'open_database', unit: 'mil' }), /unit must be one of: mm, inch/);
	await assert.rejects(() => handleManufactureExportTask({ domain: 'pcb', kind: 'pdf', template: 'ignored' }), /template is not supported/);
	await assert.rejects(() => handleManufactureExportTask({ domain: 'pcb', kind: 'bom', unit: 'mm' }), /unit is not supported/);
	// #75：只验证选中导出种类的参数，CSV/XLSX 与图像格式互不冲突。
	const savedPcbManufacture = globalThis.eda.pcb_ManufactureData;
	const savedSchManufacture = globalThis.eda.sch_ManufactureData;
	let lastExportCall;
	const fakeExport = method => async (...args) => {
		lastExportCall = { method, args };
		return Object.assign(new Blob(['Ref,Value\nR1,10k'], { type: 'text/csv' }), { name: 'Export_BOM.csv' });
	};
	globalThis.eda.pcb_ManufactureData = { getBomFile: fakeExport('pcb_BOM'), get3DFile: fakeExport('pcb_3d'), get3DShellFile: fakeExport('pcb_3d_shell') };
	globalThis.eda.sch_ManufactureData = { getBomFile: fakeExport('sch_BOM'), getExportDocumentFile: fakeExport('sch_document'), getNetlistFile: fakeExport('sch_netlist'), getSimulationNetlistFile: fakeExport('sch_simulation') };
	for (const domain of ['schematic', 'pcb']) {
		for (const fileType of ['csv', 'xlsx']) {
			const bomResult = await handleManufactureExportTask({ domain, kind: 'bom', fileType, includeData: true });
			assert.equal(bomResult.ok, true);
			assert.equal(lastExportCall.args[1], fileType);
			assert.equal(globalThis.atob(bomResult.file.dataBase64), 'Ref,Value\nR1,10k');
		}
		await assert.rejects(handleManufactureExportTask({ domain, kind: 'bom', fileType: 'PDF' }), /xlsx, csv/);
	}
	for (const fileType of ['PDF', 'PNG', 'SVG']) {
		assert.equal((await handleManufactureExportTask({ domain: 'schematic', kind: 'document', fileType })).ok, true);
		assert.equal(lastExportCall.args[1], fileType);
	}
	await assert.rejects(handleManufactureExportTask({ domain: 'schematic', kind: 'document', fileType: 'csv' }), /PDF, PNG, SVG/);
	for (const [kind, netlistType, method] of [['netlist', 'JLCEDA', 'sch_netlist'], ['simulation_netlist', 'Ngspice', 'sch_simulation']]) {
		assert.equal((await handleManufactureExportTask({ domain: 'schematic', kind, netlistType })).ok, true);
		assert.deepEqual(lastExportCall, { method, args: [undefined, netlistType] });
	}
	assert.equal((await handleManufactureExportTask({ domain: 'pcb', kind: '3d', fileType: 'step' })).ok, true);
	assert.equal((await handleManufactureExportTask({ domain: 'pcb', kind: '3d_shell', fileType: 'stl' })).ok, true);
	globalThis.eda.pcb_ManufactureData = savedPcbManufacture;
	globalThis.eda.sch_ManufactureData = savedSchManufacture;
	assert.equal(routingCalls, 0);
	console.log('2.1 tool handler tests passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
