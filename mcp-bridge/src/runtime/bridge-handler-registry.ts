import type { SchematicPinAdapter } from '../bridge/protocol.ts';
import { operationForBridgePath } from '../bridge/bridge-contract.ts';
import { handleApiIndexTask } from '../mcp/api-index-handler.ts';
import { handleApiSearchTask } from '../mcp/api-search-handler.ts';
import { handleAutoLayoutTask } from '../mcp/auto-layout-handler.ts';
import { handleAutoRoutingTask } from '../mcp/auto-routing-handler.ts';
import { handleBoardSetupTask } from '../mcp/board-setup-handler.ts';
import { handleCanvasSnapshotTask } from '../mcp/canvas-snapshot-handler.ts';
import { handleComponentPlaceAutoTask } from '../mcp/component-place-auto-handler.ts';
import {
	handleComponentPlaceCheckTask,
	handleComponentPlaceCloseTask,
	handleComponentPlaceStartTask,
	handleComponentPlaceTask,
} from '../mcp/component-place-handler.ts';
import { handleComponentSelectTask } from '../mcp/component-select-handler.ts';
import { handleEdaContextTask } from '../mcp/context-handler.ts';
import { handleDesignArchiveExportTask } from '../mcp/design-archive-export-handler.ts';
import { handleDesignCompareTask } from '../mcp/design-compare-handler.ts';
import { handleDesignSourceExportTask } from '../mcp/design-source-export-handler.ts';
import { handleEditorNavigateTask } from '../mcp/editor-navigate-handler.ts';
import { handleApiInvokeTask } from '../mcp/invoke-handler.ts';
import { handleLibraryClassificationTask } from '../mcp/library-classification-handler.ts';
import { handleLibraryPreviewTask } from '../mcp/library-preview-handler.ts';
import { handleLibrarySearchTask } from '../mcp/library-search-handler.ts';
import { handleLibrarySourcesTask } from '../mcp/library-sources-handler.ts';
import { handleManufactureExportTask } from '../mcp/manufacture-export-handler.ts';
import { handleManufactureTemplatesQueryTask } from '../mcp/manufacture-template-handler.ts';
import { handlePcbNetQueryTask } from '../mcp/net-query-handler.ts';
import { handleNetLabelModifyTask } from '../mcp/netlabel-modify-handler.ts';
import { handleNetLabelPlaceTask } from '../mcp/netlabel-place-handler.ts';
import { handleNetlistCompareTask } from '../mcp/netlist-compare-handler.ts';
import { handlePcbBoardOutlineManageTask } from '../mcp/pcb-board-outline-manage-handler.ts';
import { handlePcbComponentEditTask } from '../mcp/pcb-component-edit-handler.ts';
import { handlePcbConnectivityTask } from '../mcp/pcb-connectivity-handler.ts';
import { handlePcbConstraintsQueryTask } from '../mcp/pcb-constraints-handler.ts';
import { handlePcbConstraintsManageTask } from '../mcp/pcb-constraints-manage-handler.ts';
import { handlePcbDocumentTask } from '../mcp/pcb-document-handler.ts';
import { handlePcbDocumentsManageTask } from '../mcp/pcb-documents-manage-handler.ts';
import { handlePcbDrcCheckTask } from '../mcp/pcb-drc-handler.ts';
import { handlePcbLayerManageTask, handlePcbLayerQueryTask } from '../mcp/pcb-layer-handler.ts';
import { handlePcbPourManageTask } from '../mcp/pcb-pour-manage-handler.ts';
import { handlePcbReadTask } from '../mcp/pcb-read-handler.ts';
import { handlePcbRealtimeDrcTask } from '../mcp/pcb-realtime-drc-handler.ts';
import { handlePcbRegionManageTask } from '../mcp/pcb-region-manage-handler.ts';
import { handlePcbRoutingEditTask } from '../mcp/pcb-routing-edit-handler.ts';
import { handlePcbTextManageTask } from '../mcp/pcb-text-manage-handler.ts';
import { handleProjectInfoTask } from '../mcp/project-info-handler.ts';
import { handleSchematicComponentEditTask } from '../mcp/schematic-component-edit-handler.ts';
import { handleSchematicConnectivityTask } from '../mcp/schematic-connectivity-handler.ts';
import { handleSchematicDocumentTask } from '../mcp/schematic-document-handler.ts';
import { handleSchematicDrcCheckTask } from '../mcp/schematic-drc-handler.ts';
import { handleSchematicLayoutCheckTask } from '../mcp/schematic-layout-check-handler.ts';
import { handleSchematicPagesManageTask } from '../mcp/schematic-pages-manage-handler.ts';
import { handleSchematicReadTask } from '../mcp/schematic-read-handler.ts';
import { handleSchematicReviewTask } from '../mcp/schematic-review-handler.ts';
import { handleSchematicTextManageTask } from '../mcp/schematic-text-manage-handler.ts';
import { handleSchematicWireManageTask } from '../mcp/schematic-wire-manage-handler.ts';
import { handleWorkspaceQueryTask } from '../mcp/workspace-query-handler.ts';
import { handlePcbImportResolveTask } from './pcb-import-confirm-barrier.ts';

export type BridgeTaskHandler = (payload: unknown, reportPinAdapter?: (adapter: SchematicPinAdapter) => void) => Promise<unknown>;

const handlers: Readonly<Record<string, BridgeTaskHandler>> = {
	'/bridge/jlceda/api/index': handleApiIndexTask,
	'/bridge/jlceda/api/search': handleApiSearchTask,
	'/bridge/jlceda/api/invoke': handleApiInvokeTask,
	'/bridge/jlceda/board/setup': handleBoardSetupTask,
	'/bridge/jlceda/auto/layout': handleAutoLayoutTask,
	'/bridge/jlceda/auto/routing': handleAutoRoutingTask,
	'/bridge/jlceda/component/place/check': handleComponentPlaceCheckTask,
	'/bridge/jlceda/component/place/close': handleComponentPlaceCloseTask,
	'/bridge/jlceda/component/place/start': handleComponentPlaceStartTask,
	'/bridge/jlceda/component/place': handleComponentPlaceTask,
	'/bridge/jlceda/component/place-auto': handleComponentPlaceAutoTask,
	'/bridge/jlceda/component/select': handleComponentSelectTask,
	'/bridge/jlceda/canvas/snapshot': handleCanvasSnapshotTask,
	'/bridge/jlceda/context': handleEdaContextTask,
	'/bridge/jlceda/editor/navigate': handleEditorNavigateTask,
	'/bridge/jlceda/netlabel/modify': handleNetLabelModifyTask,
	'/bridge/jlceda/netlabel/place': handleNetLabelPlaceTask,
	'/bridge/jlceda/pcb/drc-check': handlePcbDrcCheckTask,
	'/bridge/jlceda/pcb/document': handlePcbDocumentTask,
	'/bridge/jlceda/pcb/documents-manage': handlePcbDocumentsManageTask,
	'/bridge/jlceda/pcb/import-resolve': handlePcbImportResolveTask,
	'/bridge/jlceda/schematic/drc-check': handleSchematicDrcCheckTask,
	'/bridge/jlceda/schematic/document': handleSchematicDocumentTask,
	'/bridge/jlceda/schematic/pages-manage': handleSchematicPagesManageTask,
	'/bridge/jlceda/pcb/constraints-query': handlePcbConstraintsQueryTask,
	'/bridge/jlceda/pcb/constraints-manage': handlePcbConstraintsManageTask,
	'/bridge/jlceda/pcb/connectivity': handlePcbConnectivityTask,
	'/bridge/jlceda/pcb/component-edit': handlePcbComponentEditTask,
	'/bridge/jlceda/pcb/pour-manage': handlePcbPourManageTask,
	'/bridge/jlceda/pcb/read': handlePcbReadTask,
	'/bridge/jlceda/pcb/routing-edit': handlePcbRoutingEditTask,
	'/bridge/jlceda/pcb/board-outline-manage': handlePcbBoardOutlineManageTask,
	'/bridge/jlceda/pcb/region-manage': handlePcbRegionManageTask,
	'/bridge/jlceda/pcb/text-manage': handlePcbTextManageTask,
	'/bridge/jlceda/netlist/compare': handleNetlistCompareTask,
	'/bridge/jlceda/pcb/layer-query': handlePcbLayerQueryTask,
	'/bridge/jlceda/pcb/layer-manage': handlePcbLayerManageTask,
	'/bridge/jlceda/pcb/realtime-drc': handlePcbRealtimeDrcTask,
	'/bridge/jlceda/design/compare': handleDesignCompareTask,
	'/bridge/jlceda/design/archive-export': handleDesignArchiveExportTask,
	'/bridge/jlceda/design/source-export': handleDesignSourceExportTask,
	'/bridge/jlceda/project/info': handleProjectInfoTask,
	'/bridge/jlceda/manufacture/export': handleManufactureExportTask,
	'/bridge/jlceda/manufacture/templates-query': handleManufactureTemplatesQueryTask,
	'/bridge/jlceda/library/search': handleLibrarySearchTask,
	'/bridge/jlceda/library/preview': handleLibraryPreviewTask,
	'/bridge/jlceda/library/classification-query': handleLibraryClassificationTask,
	'/bridge/jlceda/library/sources': handleLibrarySourcesTask,
	'/bridge/jlceda/net/query-pcb': handlePcbNetQueryTask,
	'/bridge/jlceda/schematic/read': handleSchematicReadTask,
	'/bridge/jlceda/schematic/layout-check': handleSchematicLayoutCheckTask,
	'/bridge/jlceda/schematic/connectivity': handleSchematicConnectivityTask,
	'/bridge/jlceda/schematic/component-edit': handleSchematicComponentEditTask,
	'/bridge/jlceda/schematic/wire-manage': handleSchematicWireManageTask,
	'/bridge/jlceda/schematic/text-manage': handleSchematicTextManageTask,
	'/bridge/jlceda/schematic/review': handleSchematicReviewTask,
	'/bridge/jlceda/workspace/query': handleWorkspaceQueryTask,
};

for (const path of Object.keys(handlers)) {
	if (operationForBridgePath(path)?.owner !== 'bridge') {
		throw new Error(`Bridge handler is not declared by the shared contract: ${path}`);
	}
}

export function getBridgeTaskHandler(path: string): BridgeTaskHandler | undefined {
	return handlers[path];
}

export function registeredBridgeTaskPaths(): readonly string[] {
	return Object.keys(handlers);
}
