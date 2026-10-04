import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { BRIDGE_CONTRACT, BRIDGE_PROTOCOL_VERSION, isReadOnlyBridgeRequest, operationForPath, validateBridgeClientMessage } from './bridge-contract.js';
import { BRIDGE_MAX_PAYLOAD_BYTES, decodeBridgeMessage, sendBridgeJson, tokensMatch } from './bridge-wire.js';

export function formatInternalClientEndpoint(port: number): string {
  return `ws://127.0.0.1:${String(port)}/mcp-internal`;
}

interface BridgePeer {
  clientId: string;
  bridgeVersion: string;
  selectionProbeVersion?: number;
  connectedAt: number;
  context?: BridgeClientContext;
  isReady: boolean;
  lastSeenAt: number;
  lastHeartbeatAt: number;
  socket: WebSocket;
}

interface PendingSelectionProbe {
  clientId: string;
  socket: WebSocket;
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface BridgeClientContext {
  documentType?: number;
  documentUuid?: string;
  tabId?: string;
  projectUuid?: string;
  projectName?: string;
  pageKind?: 'schematic' | 'pcb';
  pageUuid?: string;
  pageName?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout?: NodeJS.Timeout;
  executionTimeoutMs?: number;
  started?: boolean;
  clientId?: string;
  leaseTerm?: number;
  mcpSocket?: WebSocket;
  internalRequestId?: string;
  edaSocket?: WebSocket;
  path?: string;
  payload?: unknown;
  startedAt?: number;
  context?: BridgeClientContext;
}

interface RecoveryDiagnostic {
  requestId: string;
  clientId: string;
  path: string;
  startedAt: string;
  timeoutMs: number;
  timedOutAtMs: number;
  mutating: boolean;
  pageBound: boolean;
  targetProjectUuid?: string;
  targetDocumentUuid?: string;
  targetTabId?: string;
  targetSchematicUuid?: string;
  targetSchematicMayBeEmpty?: boolean;
  targetSchematicPageUuid?: string;
  targetSchematicPinPrimitiveId?: string;
  sourceSchematicPageUuid?: string;
  targetPageMayBeAbsent?: boolean;
  targetPcbUuid?: string;
  requiredReadback?: 'pcb_component_positions' | 'pcb_component_state' | 'pcb_pour_state' | 'pcb_region_state' | 'pcb_text_state' | 'pcb_layer_state' | 'pcb_routing_state' | 'pcb_document_inventory' | 'board_document_inventory' | 'schematic_page_inventory' | 'schematic_connectivity_primitives' | 'schematic_component_ids' | 'schematic_component_state' | 'schematic_text_state';
  hostRestartRequired?: boolean;
  pendingNativeConfirmation?: boolean;
  importContextConflict?: boolean;
  uncertaintyReason?: string;
  context?: BridgeClientContext;
}

interface RecoverySession {
  recoveryId: string;
  diagnostic: RecoveryDiagnostic;
  requestedAt: string;
  sourceConnected: boolean;
  sourceSocket?: WebSocket;
  preRecoverySockets: Set<WebSocket>;
  preRecoveryClientIds: Set<string>;
  targetClientId?: string;
  targetSocket?: WebSocket;
}

interface BridgeTask {
  type: 'bridge/task';
  requestId: string;
  path: string;
  payload: unknown;
  timeoutMs: number;
}

export interface BridgeTaskErrorDetails {
  message: string;
  name?: string;
  stack?: string;
  code?: string;
  timeoutMs?: number;
  reason?: string;
  field?: string;
  status?: string | number;
}

/** Keep diagnostic fields without echoing native document source or request payloads. */
export function normalizeBridgeTaskError(error: unknown): BridgeTaskErrorDetails {
  if (!isRecord(error)) return { message: String(error).slice(0, 2048) };
  const details: BridgeTaskErrorDetails = { message: '' };
  for (const key of ['message', 'name', 'code', 'reason', 'field'] as const) {
    if (typeof error[key] === 'string' && error[key].trim()) details[key] = error[key].slice(0, 2048);
  }
  if (typeof error.stack === 'string') details.stack = error.stack.slice(0, 8000);
  if (typeof error.status === 'string' || typeof error.status === 'number')
    details.status = typeof error.status === 'string' ? error.status.slice(0, 128) : error.status;
  const timeoutMs = Number(error.timeoutMs);
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) details.timeoutMs = timeoutMs;
  if (!details.message || details.message === '[object Object]')
    details.message = details.reason || (details.code ? `EDA rejected the operation (${details.code}).` : 'EDA rejected the operation (object error without a message).');
  return details;
}

/** Error raised from a Bridge task while retaining the serialized task metadata. */
export class BridgeTaskError extends Error {
  public readonly code?: string;
  public readonly timeoutMs?: number;
  public readonly reason?: string;
  public readonly field?: string;
  public readonly status?: string | number;

  public constructor(details: BridgeTaskErrorDetails) {
    super(details.message);
    this.name = details.name || 'BridgeTaskError';
    this.code = details.code;
    this.timeoutMs = details.timeoutMs;
    this.reason = details.reason;
    this.field = details.field;
    this.status = details.status;
    if (details.stack) {
      this.stack = details.stack;
    }
  }
}

const BRIDGE_QUEUE_TIMEOUT_MS = 15 * 60 * 1000;
const INTERNAL_QUEUE_RESPONSE_GRACE_MS = 5_000;
const BRIDGE_MAX_PENDING_REQUESTS = 64;
const SELECTION_PROBE_TIMEOUT_MS = 1_500;
const RECOVERY_READBACK_TIMEOUT_MS = 15_000;
const RECOVERY_DIAGNOSTIC_TTL_MS = 15 * 60 * 1000;
const TARGETED_SCHEMATIC_PAGE_APIS = new Set([
  'eda.dmt_schematic.createschematicpage',
  'eda.dmt_schematic.copyschematicpage',
  'eda.dmt_schematic.modifyschematicpagename',
  'eda.dmt_schematic.reorderschematicpages',
  'eda.dmt_schematic.deleteschematicpage',
]);
function isReadOnlyRequest(path: string, payload: unknown): boolean {
	return isReadOnlyBridgeRequest(path, payload);
}

function isPageBoundWrite(path: string, payload: unknown): boolean {
  if (isTargetedSchematicPageMutation(path, payload) || path === '/bridge/jlceda/pcb/documents-manage')
    return false;
  if (path === '/bridge/jlceda/api/invoke' && isRecord(payload) && typeof payload.apiFullName === 'string') {
    const apiFullName = payload.apiFullName.trim().toLowerCase();
    return apiFullName.startsWith('eda.sch_') || apiFullName.startsWith('eda.pcb_');
  }
  return path.startsWith('/bridge/jlceda/pcb/')
    || path.startsWith('/bridge/jlceda/schematic/')
    || path.startsWith('/bridge/jlceda/component/')
    || path.startsWith('/bridge/jlceda/netlabel/')
    || path.startsWith('/bridge/jlceda/auto/');
}

function isTargetedSchematicPageMutation(path: string, payload: unknown): boolean {
  if (path === '/bridge/jlceda/schematic/pages-manage')
    return true;
  if (path !== '/bridge/jlceda/api/invoke' || !isRecord(payload) || typeof payload.apiFullName !== 'string')
    return false;
  return TARGETED_SCHEMATIC_PAGE_APIS.has(payload.apiFullName.trim().toLowerCase());
}

function schematicPageMutationTarget(path: string, payload: unknown): Pick<RecoveryDiagnostic,
  'targetSchematicUuid' | 'targetSchematicMayBeEmpty' | 'targetSchematicPageUuid' | 'sourceSchematicPageUuid' | 'targetPageMayBeAbsent'> {
  if (!isRecord(payload)) return {};
  if (path === '/bridge/jlceda/schematic/pages-manage') {
    const operation = optionalString(payload.operation);
    return {
      targetSchematicUuid: optionalString(payload.schematicUuid),
      ...((operation === 'create' || operation === 'copy') ? { targetSchematicMayBeEmpty: true } : {}),
      ...(operation === 'rename' ? { targetSchematicPageUuid: optionalString(payload.schematicPageUuid) } : {}),
      ...(operation === 'copy' ? { sourceSchematicPageUuid: optionalString(payload.sourcePageUuid) } : {}),
    };
  }
  if (path !== '/bridge/jlceda/api/invoke' || !Array.isArray(payload.args)) return {};
  const api = optionalString(payload.apiFullName)?.toLowerCase();
  const first = optionalString(payload.args[0]);
  const second = optionalString(payload.args[1]);
  switch (api) {
    case 'eda.dmt_schematic.createschematicpage':
      return { targetSchematicUuid: first, targetSchematicMayBeEmpty: true };
    case 'eda.dmt_schematic.reorderschematicpages':
      return { targetSchematicUuid: first };
    case 'eda.dmt_schematic.copyschematicpage':
      return { sourceSchematicPageUuid: first, targetSchematicUuid: second, targetSchematicMayBeEmpty: true };
    case 'eda.dmt_schematic.modifyschematicpagename':
      return { targetSchematicPageUuid: first };
    case 'eda.dmt_schematic.deleteschematicpage':
      return { targetSchematicPageUuid: first, targetPageMayBeAbsent: true };
    default:
      return {};
  }
}

function knownProjectTargetUuid(path: string, payload: unknown): string | undefined {
  if ((path === '/bridge/jlceda/pcb/documents-manage' || path === '/bridge/jlceda/board/setup' || path === '/bridge/jlceda/editor/navigate') && isRecord(payload))
    return optionalString(payload.projectUuid);
  if (path !== '/bridge/jlceda/api/invoke' || !isRecord(payload)
    || typeof payload.apiFullName !== 'string'
    || payload.apiFullName.trim().toLowerCase() !== 'eda.dmt_project.modifyprojectfriendlyname'
    || !Array.isArray(payload.args)) return undefined;
  return optionalString(payload.args[0]);
}

function isSchematicComponentDelete(path: string, payload: unknown): boolean {
  return path === '/bridge/jlceda/api/invoke'
    && isRecord(payload)
    && typeof payload.apiFullName === 'string'
    && payload.apiFullName.trim().toLowerCase() === 'eda.sch_primitivecomponent.delete';
}

function isSchematicPinModify(path: string, payload: unknown): boolean {
  return path === '/bridge/jlceda/api/invoke' && isRecord(payload)
    && typeof payload.apiFullName === 'string'
    && payload.apiFullName.trim().toLowerCase() === 'eda.sch_primitivepin.modify';
}

function isSchematicConnectivityMutation(path: string, payload: unknown): boolean {
  return isSchematicComponentDelete(path, payload)
    || isSchematicPinModify(path, payload)
    || path === '/bridge/jlceda/netlabel/place'
	|| (path === '/bridge/jlceda/schematic/wire-manage'
		&& isRecord(payload) && (payload.action === 'modify' || payload.action === 'delete'))
    || (path === '/bridge/jlceda/schematic/connectivity'
      && isRecord(payload)
      && (payload.action === 'wire_create' || payload.action === 'netport_create' || payload.action === 'netport_move'));
}

function isSchematicPlacementWrite(path: string): boolean {
  return path === '/bridge/jlceda/component/place/start'
    || path === '/bridge/jlceda/component/place/check'
    || path === '/bridge/jlceda/component/place-auto';
}

function isSchematicConnectivityReadbackRequest(path: string, payload: Record<string, unknown>): boolean {
  return path === '/bridge/jlceda/schematic/read' && payload.includeConnectivityPrimitives === true;
}

function validWireLine(value: unknown): boolean {
  const flat = (part: unknown): boolean => Array.isArray(part) && part.length >= 4 && part.length % 2 === 0
    && part.every(coordinate => typeof coordinate === 'number' && Number.isFinite(coordinate));
  if (flat(value)) return true;
  if (!Array.isArray(value) || value.length === 0) return false;
  if (value.every(part => Array.isArray(part) && part.length === 2
    && part.every(coordinate => typeof coordinate === 'number' && Number.isFinite(coordinate))))
    return value.length >= 2;
  return value.every(flat);
}

function hasMutatingRecoveryDiagnostics(diagnostics: Iterable<RecoveryDiagnostic>): boolean {
  for (const diagnostic of diagnostics) {
    if (diagnostic.mutating) {
      return true;
    }
  }
  return false;
}

function getBridgeTaskTimeoutMs(error: unknown): number | undefined {
  if (isRecord(error) && error.code === 'BRIDGE_TASK_TIMEOUT') {
    const timeoutMs = Number(error.timeoutMs);
    return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined;
  }
  // Accept older Bridge clients that only serialized the timeout message.
  const message = typeof error === 'string' ? error : isRecord(error) && typeof error.message === 'string' ? error.message : undefined;
  if (message) {
    const match = /^Bridge task timed out after (\d+)ms: /.exec(message);
    return match ? Number(match[1]) : undefined;
  }
  return undefined;
}

interface BridgeServerOptions {
  peerTtlMs?: number;
  peerSweepIntervalMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateInternalTaskMessage(value: unknown): string | undefined {
  if (!isRecord(value) || value.type !== 'bridge/task') {
    return 'Internal bridge task message must have type bridge/task';
  }
  if (typeof value.requestId !== 'string' || value.requestId.trim().length === 0) {
    return 'Internal bridge task requires a non-empty requestId';
  }
  if (typeof value.path !== 'string' || !operationForPath(value.path)) {
    return 'Internal bridge task path is not declared by the Bridge contract';
  }
  if (!Object.prototype.hasOwnProperty.call(value, 'payload')) {
    return 'Internal bridge task requires payload';
  }
  if (typeof value.timeoutMs !== 'number' || !Number.isInteger(value.timeoutMs) || value.timeoutMs <= 0) {
    return 'Internal bridge task requires a positive integer timeoutMs';
  }
  return undefined;
}

function optionalString(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || undefined;
}

function isPcbAutoLayoutRequest(path: string, payload: unknown): boolean {
  return path === '/bridge/jlceda/api/invoke'
    && isRecord(payload)
    && optionalString(payload.apiFullName)?.toLowerCase() === 'eda.pcb_document.autolayout';
}

function isPendingPcbImportResult(path: string | undefined, payload: unknown, result: unknown): boolean {
  return path === '/bridge/jlceda/pcb/document'
    && isRecord(payload)
    && payload.action === 'import_changes'
    && isRecord(result)
    && result.commitState === 'pending_confirmation';
}

function isPcbComponentReadbackRequest(path: string, payload: Record<string, unknown>): boolean {
  const args = payload.args;
  return path === '/bridge/jlceda/api/invoke'
    && optionalString(payload.apiFullName)?.toLowerCase() === 'eda.pcb_primitivecomponent.getall'
    && (args === undefined || (Array.isArray(args) && args.length === 0));
}

function isPcbComponentStateReadbackRequest(path: string, payload: Record<string, unknown>): boolean {
  return path === '/bridge/jlceda/pcb/component-edit' && payload.action === 'read';
}

function isPcbPourStateReadbackRequest(path: string, payload: Record<string, unknown>): boolean {
  return path === '/bridge/jlceda/pcb/pour-manage' && payload.action === 'read';
}

function isPcbRegionStateReadbackRequest(path: string, payload: Record<string, unknown>): boolean {
  return path === '/bridge/jlceda/pcb/region-manage' && payload.action === 'read' && payload.primitiveId === undefined;
}

function isPcbTextStateReadbackRequest(path: string, payload: Record<string, unknown>): boolean {
  return path === '/bridge/jlceda/pcb/text-manage' && payload.action === 'read'
    && payload.kind === undefined && payload.primitiveId === undefined && payload.parentPrimitiveId === undefined;
}

function isSchematicTextStateReadbackRequest(path: string, payload: Record<string, unknown>): boolean {
  return path === '/bridge/jlceda/schematic/text-manage' && payload.action === 'read'
    && payload.primitiveId === undefined;
}

function isPcbDocumentInventoryReadbackRequest(path: string, payload: Record<string, unknown>, projectUuid?: string): boolean {
  return path === '/bridge/jlceda/pcb/documents-manage' && payload.operation === 'list'
    && typeof payload.projectUuid === 'string' && payload.projectUuid === projectUuid;
}

function isBoardDocumentInventoryReadbackRequest(path: string, payload: Record<string, unknown>): boolean {
  return path === '/bridge/jlceda/project/info' && payload.includePages === false
    && payload.includeBoards === true && payload.includeSchematics === true && payload.includePcbs === true
    && payload.limit === 500;
}

function isPcbLayerStateReadbackRequest(path: string, payload: Record<string, unknown>): boolean {
  return path === '/bridge/jlceda/pcb/layer-manage' && payload.action === 'read';
}

function isPcbAutoRoutingRequest(path: string, payload: unknown): boolean {
  return path === '/bridge/jlceda/api/invoke'
    && isRecord(payload)
    && optionalString(payload.apiFullName)?.toLowerCase() === 'eda.pcb_document.autorouting';
}

function isPcbConnectivityMutation(path: string, payload: unknown): boolean {
  return path === '/bridge/jlceda/pcb/connectivity'
    && isRecord(payload)
    && (payload.action === 'line_create' || payload.action === 'via_create');
}

function isPcbRoutingEditMutation(path: string, payload: unknown): boolean {
  return path === '/bridge/jlceda/pcb/routing-edit'
    && isRecord(payload)
    && (payload.action === 'create' || payload.action === 'modify' || payload.action === 'delete');
}

function isPcbBoardOutlineMutation(path: string, payload: unknown): boolean {
  return path === '/bridge/jlceda/pcb/board-outline-manage'
    && isRecord(payload)
    && (payload.action === 'create' || payload.action === 'modify' || payload.action === 'delete');
}

const PCB_ROUTING_READBACK_APIS = [
  'eda.pcb_PrimitiveLine.getAll',
  'eda.pcb_PrimitiveArc.getAll',
  'eda.pcb_PrimitivePolyline.getAll',
  'eda.pcb_PrimitiveVia.getAll',
] as const;

function isPcbRoutingReadbackRequest(path: string, payload: Record<string, unknown>): boolean {
  const args = payload.args;
  return path === '/bridge/jlceda/api/invoke'
    && optionalString(payload.apiFullName)?.toLowerCase() === PCB_ROUTING_READBACK_APIS[0].toLowerCase()
    && (args === undefined || (Array.isArray(args) && args.length === 0));
}

function isSchematicComponentIdReadbackRequest(path: string, payload: Record<string, unknown>): boolean {
  return path === '/bridge/jlceda/api/invoke'
    && optionalString(payload.apiFullName)?.toLowerCase() === 'eda.sch_primitivecomponent.getallprimitiveid'
    && Array.isArray(payload.args) && payload.args.length === 2
    && payload.args[0] === null && payload.args[1] === false;
}

function isSchematicComponentStateReadbackRequest(path: string, payload: Record<string, unknown>): boolean {
  return path === '/bridge/jlceda/schematic/component-edit' && payload.action === 'read';
}

function isSchematicPageInventoryReadbackRequest(path: string, payload: Record<string, unknown>): boolean {
  const args = payload.args;
  return path === '/bridge/jlceda/api/invoke'
    && optionalString(payload.apiFullName)?.toLowerCase() === 'eda.dmt_schematic.getallschematicpagesinfo'
    && (args === undefined || (Array.isArray(args) && args.length === 0));
}

function serializeBridgeError(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return String(error);
  }
  // Preserve the historical string form for ordinary internal failures. Only
  // Bridge-originated errors need a structured envelope for metadata.
  if (!(error instanceof BridgeTaskError)
    && !(typeof (error as Error & { code?: unknown }).code === 'string')
    && !(typeof (error as Error & { timeoutMs?: unknown }).timeoutMs === 'number')) {
    return error.message;
  }
  const details: Record<string, unknown> = {
    message: error.message,
    name: error.name,
    stack: error.stack && error.stack.length > 8000 ? `${error.stack.slice(0, 8000)}...` : error.stack,
  };
  const code = (error as Error & { code?: unknown }).code;
  const timeoutMs = (error as Error & { timeoutMs?: unknown }).timeoutMs;
  if (typeof code === 'string' && code.length > 0) {
    details.code = code;
  }
  if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    details.timeoutMs = timeoutMs;
  }
  if (error instanceof BridgeTaskError) {
    details.reason = error.reason;
    details.field = error.field;
    details.status = error.status;
  }
  return details;
}

function parseClientContext(value: unknown): BridgeClientContext | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const pageKind = value.pageKind === 'schematic' || value.pageKind === 'pcb'
    ? value.pageKind
    : undefined;
  const documentType = typeof value.documentType === 'number' && Number.isFinite(value.documentType)
    ? value.documentType
    : undefined;
  return {
    documentType,
    documentUuid: optionalString(value.documentUuid),
    tabId: optionalString(value.tabId),
    projectUuid: optionalString(value.projectUuid),
    projectName: optionalString(value.projectName),
    pageKind,
    pageUuid: optionalString(value.pageUuid),
    pageName: optionalString(value.pageName),
  };
}

function updatePendingPcbImportContext(diagnostic: RecoveryDiagnostic, result: unknown): void {
  const importContext = isRecord(result) ? parseClientContext(result.importContext) : undefined;
  if (!importContext)
    return;
  const executionContext = diagnostic.context;
  if ((executionContext?.pageKind && importContext.pageKind && executionContext.pageKind !== importContext.pageKind)
    || (executionContext?.pageUuid && importContext.pageUuid && executionContext.pageUuid !== importContext.pageUuid)
    || (executionContext?.documentUuid && importContext.documentUuid && executionContext.documentUuid !== importContext.documentUuid)
    || (executionContext?.projectUuid && importContext.projectUuid && executionContext.projectUuid !== importContext.projectUuid)) {
    diagnostic.importContextConflict = true;
    diagnostic.uncertaintyReason = 'native PCB import identity disagrees with execution context';
    return;
  }
  diagnostic.context = {
    ...executionContext,
    ...(importContext.pageKind ? { pageKind: importContext.pageKind } : {}),
    ...(importContext.pageUuid ? { pageUuid: importContext.pageUuid } : {}),
    ...(importContext.documentUuid ? { documentUuid: importContext.documentUuid } : {}),
    ...(importContext.projectUuid ? { projectUuid: importContext.projectUuid } : {}),
  };
}

function extractReadbackIdentity(value: unknown, pageKind?: BridgeClientContext['pageKind']): { documentUuid?: string; projectUuid?: string; pageUuid?: string } {
  if (!isRecord(value)) {
    return {};
  }
  const document = isRecord(value.currentDocumentInfo) ? value.currentDocumentInfo : isRecord(value.currentDocument) ? value.currentDocument : undefined;
  const project = isRecord(value.currentProjectInfo) ? value.currentProjectInfo : isRecord(value.project) ? value.project : undefined;
  const schematicPage = isRecord(value.currentSchematicPageInfo) ? value.currentSchematicPageInfo : undefined;
  const pcb = isRecord(value.currentPcbInfo) ? value.currentPcbInfo : undefined;
  const pageUuid = pageKind === 'schematic'
    ? optionalString(schematicPage?.uuid)
    : pageKind === 'pcb'
      ? optionalString(pcb?.uuid)
      : optionalString(schematicPage?.uuid) ?? optionalString(pcb?.uuid);
  return {
    documentUuid: optionalString(document?.uuid),
    projectUuid: optionalString(document?.parentProjectUuid) ?? optionalString(project?.uuid),
    pageUuid,
  };
}

export class EdaBridgeServer {
  private wss: WebSocketServer | null = null;
  private readonly peers = new Map<string, BridgePeer>();
  private readonly clientIdBySocket = new Map<WebSocket, string>();
  private readonly mcpClients = new Set<WebSocket>();
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly pendingSelectionProbes = new Map<string, PendingSelectionProbe>();
  private readonly reconnectBarriers = new Map<string, { path: string; until: number }>();
  private readonly recoveryDiagnostics = new Map<string, RecoveryDiagnostic>();
  private readonly pendingImportSockets = new Map<string, WebSocket>();
  private readonly resolvingImports = new Set<string>();
  private recoverySession: RecoverySession | undefined;
  private readonly instanceId = randomUUID();
  private requestIdCounter = 0;
  private activeClientId = '';
  private activeClientExplicitlySelected = false;
  private leaseTerm = 0;
  private started = false;
  private isMainServer = false;
  private internalClient: WebSocket | null = null;
  private readonly authToken = String(process.env.JLCEDA_BRIDGE_TOKEN ?? '').trim();
  private readonly peerTtlMs: number;
  private readonly peerSweepIntervalMs: number;
  private peerSweepTimer: NodeJS.Timeout | null = null;
  private promoting = false;
  private closing = false;

  public constructor(private readonly port: number = 8765, options: BridgeServerOptions = {}) {
    this.peerTtlMs = options.peerTtlMs ?? 15000;
    this.peerSweepIntervalMs = options.peerSweepIntervalMs ?? 1000;
  }

  public async start(): Promise<void> {
    if (this.started) {
      return;
    }

    try {
      await this.startAsMainServer();
    } catch (error) {
      process.stderr.write(`Failed to start as main server, trying client mode: ${String(error)}\n`);
      await this.startAsClient();
    }
    this.started = true;
  }

  private async startAsMainServer(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const server = new WebSocketServer({
        host: '127.0.0.1',
        port: this.port,
        maxPayload: BRIDGE_MAX_PAYLOAD_BYTES,
      });
      this.wss = server;

      server.once('listening', () => {
        settled = true;
        this.isMainServer = true;
        process.stderr.write(`[Main Server] WebSocket server listening on ws://127.0.0.1:${this.port}\n`);
        if (!this.authToken) {
          process.stderr.write('[Security] JLCEDA_BRIDGE_TOKEN is not set; local WebSocket authentication is disabled\n');
        }
        this.startPeerSweep();
        resolve();
      });

      server.on('connection', (socket, request) => {
        const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
        const pathname = requestUrl.pathname;
        if (!this.isAuthorized(requestUrl)) {
          process.stderr.write(`[Main Server] Rejected unauthorized WebSocket connection on ${pathname}\n`);
          socket.close(1008, 'Unauthorized');
          return;
        }
        if (pathname === '/bridge/ws') {
          this.attachEdaSocket(socket);
          return;
        }
        if (pathname === '/mcp-internal') {
          this.attachMcpSocket(socket);
          return;
        }
        process.stderr.write(`[Main Server] Rejected unsupported WebSocket path: ${pathname}\n`);
        socket.close(1008, 'Unsupported WebSocket path');
      });

      server.on('error', (error) => {
        if (!settled) {
          this.wss = null;
          reject(error);
          return;
        }
        process.stderr.write(`WebSocket server error: ${error.message}\n`);
      });
    });
  }

  private async startAsClient(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const tokenQuery = this.authToken ? `?token=${encodeURIComponent(this.authToken)}` : '';
      const url = `ws://127.0.0.1:${this.port}/mcp-internal${tokenQuery}`;
      const socket = new WebSocket(url, { maxPayload: BRIDGE_MAX_PAYLOAD_BYTES });
      this.internalClient = socket;
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.close();
          reject(new Error('Connection to main server timeout'));
        }
      }, 5000);

      socket.on('message', (data) => {
        try {
          const message = decodeBridgeMessage(data);
          if (isRecord(message) && message.type === 'bridge/internal-ready' && !settled) {
            settled = true;
            clearTimeout(timer);
            process.stderr.write(`[Client Mode] Connected to main server at ${formatInternalClientEndpoint(this.port)}\n`);
            resolve();
            return;
          }
        } catch {
          // The regular message handler reports malformed payloads after authentication.
        }
        this.handleInternalMessage(data);
      });
      socket.on('close', () => {
        this.internalClient = null;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error('Main server closed before authentication completed'));
        }
        this.rejectAllPending('Main server connection closed');
        if (this.started && !this.closing && !this.promoting) {
          void this.recoverMainServer();
        }
      });
      socket.on('error', (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  private isAuthorized(requestUrl: URL): boolean {
    if (!this.authToken) {
      return true;
    }
    return tokensMatch(requestUrl.searchParams.get('token') ?? '', this.authToken);
  }

  private startPeerSweep(): void {
    if (this.peerSweepTimer) {
      clearInterval(this.peerSweepTimer);
    }
    this.peerSweepTimer = setInterval(() => this.expireStalePeers(), this.peerSweepIntervalMs);
    this.peerSweepTimer.unref();
  }

  private expireStalePeers(): void {
    const now = Date.now();
    for (const peer of [...this.peers.values()]) {
      if (now - (peer.lastHeartbeatAt || peer.connectedAt) <= this.peerTtlMs) {
        continue;
      }
      this.rejectPendingForClient(peer.clientId, 'EDA client heartbeat timed out');
      peer.socket.close(4000, 'Bridge heartbeat timeout');
      this.removeEdaSocket(peer.socket);
    }
  }

  private async recoverMainServer(): Promise<void> {
    if (this.promoting || this.closing) {
      return;
    }
    this.promoting = true;
    process.stderr.write('[Client Mode] Main server lost; attempting listener takeover\n');
    try {
      for (let attempt = 0; attempt < 20 && !this.closing; attempt += 1) {
        try {
          await this.startAsMainServer();
          process.stderr.write('[Client Mode] Promoted to main server\n');
          return;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100 + Math.floor(Math.random() * 100)));
          try {
            await this.startAsClient();
            return;
          } catch {
            // Another process may still be taking over. Retry until the deadline.
          }
        }
      }
      process.stderr.write('[Client Mode] Failed to recover a main bridge server\n');
    } finally {
      this.promoting = false;
    }
  }

  private attachEdaSocket(socket: WebSocket): void {
    socket.on('message', (data) => {
      try {
        this.handleEdaMessage(socket, decodeBridgeMessage(data));
      } catch (error) {
        this.trySend(socket, {
          type: 'bridge/error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
    socket.on('close', () => this.removeEdaSocket(socket));
    socket.on('error', () => this.removeEdaSocket(socket));
  }

  private handleEdaMessage(socket: WebSocket, rawMessage: unknown): void {
	const validationError = validateBridgeClientMessage(rawMessage);
	if (validationError) {
		throw new Error(validationError);
	}
	if (!isRecord(rawMessage)) {
		throw new Error('Bridge message must be an object');
	}
	const type = String(rawMessage.type ?? '');
	if (type === 'bridge/hello') {
		if (rawMessage.protocolVersion !== undefined && rawMessage.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
			throw new Error(`Unsupported Bridge protocol version: ${String(rawMessage.protocolVersion)}`);
		}
      const clientId = String(rawMessage.clientId ?? '').trim();
      if (!clientId) {
        throw new Error('bridge/hello requires clientId');
      }
      const peer = this.registerPeer(
        clientId,
        socket,
        optionalString(rawMessage.bridgeVersion) ?? 'unknown',
        parseClientContext(rawMessage.context),
        rawMessage.selectionProbeVersion === 1 ? 1 : undefined,
      );
		this.trySend(socket, {
			type: 'bridge/welcome',
			clientId,
			protocolVersion: BRIDGE_PROTOCOL_VERSION,
        connectedAt: new Date(peer.connectedAt).toISOString(),
      });
      this.trySend(socket, {
        type: 'bridge/debug-switch',
        clientId,
        debugSwitch: { enableSystemLog: true, enableConnectionList: false },
      });
      this.broadcastRoles('Client handshake completed');
      return;
    }

    const peer = this.getBoundPeer(socket, rawMessage.clientId);
    peer.lastSeenAt = Date.now();
    if (type === 'bridge/heartbeat') {
      peer.lastHeartbeatAt = peer.lastSeenAt;
      peer.context = parseClientContext(rawMessage.context) ?? peer.context;
      this.promoteReadyPeerIfNeeded(peer);
      this.trySend(socket, {
        type: 'bridge/heartbeat-ack',
        clientId: peer.clientId,
        sentAt: Number(rawMessage.sentAt ?? 0),
        receivedAt: new Date(peer.lastSeenAt).toISOString(),
      });
      return;
    }
    if (type === 'bridge/ready') {
      peer.isReady = true;
      this.promoteReadyPeerIfNeeded(peer);
      return;
    }
    if (type === 'bridge/probe-ack') {
      const probeId = String(rawMessage.probeId ?? '');
      const pendingProbe = this.pendingSelectionProbes.get(probeId);
      if (pendingProbe?.clientId === peer.clientId && pendingProbe.socket === socket) {
        clearTimeout(pendingProbe.timeout);
        this.pendingSelectionProbes.delete(probeId);
        pendingProbe.resolve();
      }
      return;
    }
    if (type === 'bridge/task-started') {
      this.markPendingRequestStarted(peer, rawMessage);
      return;
    }
    if (type === 'bridge/result') {
      this.completePendingRequest(peer, rawMessage);
      return;
    }
    if (type === 'bridge/log') {
      const log = isRecord(rawMessage.log) ? rawMessage.log : {};
      process.stderr.write(`[BridgeLog clientId=${peer.clientId}] ${JSON.stringify(log)}\n`);
      return;
    }
    throw new Error(`Unsupported bridge message type: ${type}`);
  }

  private registerPeer(
    clientId: string,
    socket: WebSocket,
    bridgeVersion: string,
    context: BridgeClientContext | undefined,
    selectionProbeVersion: number | undefined,
  ): BridgePeer {
    const previous = this.peers.get(clientId);
    if (previous && previous.socket !== socket) {
      this.rejectSelectionProbesForSocket(previous.socket, 'EDA client connection was replaced during selection probe');
      if (this.recoverySession?.targetClientId === clientId) {
        this.recoverySession.targetClientId = undefined;
        this.recoverySession.targetSocket = undefined;
      }
      this.enterReconnectBarrier(clientId);
      this.rejectPendingForClient(clientId, 'EDA client reconnected before the pending request completed');
      this.clientIdBySocket.delete(previous.socket);
      previous.socket.close(4001, 'Replaced by a newer connection');
    }
    const now = Date.now();
    const peer: BridgePeer = {
      clientId,
      bridgeVersion,
      selectionProbeVersion,
      connectedAt: previous?.socket === socket ? previous.connectedAt : now,
      context,
      isReady: previous?.socket === socket ? previous.isReady : false,
      lastSeenAt: now,
      lastHeartbeatAt: previous?.socket === socket ? previous.lastHeartbeatAt : 0,
      socket,
    };
    this.peers.set(clientId, peer);
    this.clientIdBySocket.set(socket, clientId);
    if (!this.activeClientId || !this.peers.has(this.activeClientId)) {
      this.activeClientId = clientId;
      this.activeClientExplicitlySelected = false;
      this.leaseTerm += 1;
    }
    return peer;
  }

  private getBoundPeer(socket: WebSocket, rawClientId: unknown): BridgePeer {
    const clientId = String(rawClientId ?? '').trim();
    const boundClientId = this.clientIdBySocket.get(socket);
    if (!clientId || clientId !== boundClientId) {
      throw new Error('Bridge client is not registered on this socket');
    }
    const peer = this.peers.get(clientId);
    if (!peer || peer.socket !== socket) {
      throw new Error('Bridge client registration is stale');
    }
    return peer;
  }

  private removeEdaSocket(socket: WebSocket): void {
    this.rejectSelectionProbesForSocket(socket, 'EDA client disconnected during selection probe');
    const clientId = this.clientIdBySocket.get(socket);
    if (!clientId) {
      return;
    }
    this.clientIdBySocket.delete(socket);
    const peer = this.peers.get(clientId);
    if (peer?.socket !== socket) {
      return;
    }
    this.peers.delete(clientId);
    if (this.recoverySession?.targetClientId === clientId) {
      // The readback target is a socket generation, not merely a clientId.
      // Permit a later generation to rebind after this socket disconnects.
      this.recoverySession.targetClientId = undefined;
      this.recoverySession.targetSocket = undefined;
    }
    if (this.activeClientId === clientId) {
      this.rejectPendingForClient(clientId, 'Active EDA client disconnected');
      const replacement = [...this.peers.values()].filter(candidate => this.isPeerReady(candidate)).sort((left, right) => left.connectedAt - right.connectedAt)[0];
      this.activeClientId = replacement?.clientId ?? '';
      this.activeClientExplicitlySelected = false;
      this.leaseTerm += 1;
      this.broadcastRoles('Active client disconnected; standby promoted');
    }
  }

  private broadcastRoles(reason: string): void {
    for (const peer of this.peers.values()) {
      this.trySend(peer.socket, {
        type: 'bridge/role',
        clientId: peer.clientId,
        role: peer.clientId === this.activeClientId ? 'active' : 'standby',
        leaseTerm: this.leaseTerm,
        activeClientId: this.activeClientId,
        reason,
      });
    }
  }

  private completePendingRequest(peer: BridgePeer, message: Record<string, unknown>): void {
    const requestId = String(message.requestId ?? '');
    const pending = this.pendingRequests.get(requestId);
    if (!pending || pending.clientId !== peer.clientId || pending.edaSocket !== peer.socket || pending.leaseTerm !== Number(message.leaseTerm)) {
      // A Bridge task timeout or an unknown commit state does not mean the
      // underlying EDA Promise settled. Keep the write quarantine in that case.
      const diagnostic = this.recoveryDiagnostics.get(requestId);
      this.updateAutoLayoutDiagnostic(requestId, message.result, peer.clientId);
      this.updatePcbDocumentDiagnostic(requestId, message.result, peer.clientId);
      const bridgeTimedOut = getBridgeTaskTimeoutMs(message.error) !== undefined
        || (isRecord(message.error) && message.error.code === 'BRIDGE_TASK_TIMEOUT');
      const commitUnknown = isRecord(message.result)
        && (message.result.commitState === 'unknown' || message.result.commitUnknown === true);
      if (diagnostic?.clientId === peer.clientId
        && diagnostic.path === '/bridge/jlceda/schematic/component-edit'
        && isRecord(message.result) && message.result.reason === 'pin_network_changed') {
        diagnostic.requiredReadback = 'schematic_connectivity_primitives';
        diagnostic.uncertaintyReason = 'component pin network changed';
      }
      if (diagnostic?.clientId === peer.clientId
        && isRecord(message.result)
        && ((diagnostic.requiredReadback === 'pcb_routing_state'
          && (diagnostic.path === '/bridge/jlceda/pcb/connectivity' || diagnostic.path === '/bridge/jlceda/pcb/routing-edit' || diagnostic.path === '/bridge/jlceda/pcb/board-outline-manage')
          && (message.result.nativeCallSettled === true
            || (message.result.ok === true && message.result.verified === true)))
          || ((diagnostic.requiredReadback === 'pcb_component_state'
            || diagnostic.requiredReadback === 'pcb_pour_state'
            || diagnostic.requiredReadback === 'pcb_region_state'
            || diagnostic.requiredReadback === 'pcb_text_state'
            || diagnostic.requiredReadback === 'schematic_text_state'
            || diagnostic.requiredReadback === 'pcb_document_inventory'
            || diagnostic.requiredReadback === 'board_document_inventory'
            || diagnostic.requiredReadback === 'pcb_layer_state'
            || diagnostic.requiredReadback === 'schematic_component_ids'
            || diagnostic.requiredReadback === 'schematic_component_state'
            || diagnostic.requiredReadback === 'schematic_connectivity_primitives')
            && message.result.nativeCallSettled === true)))
        diagnostic.hostRestartRequired = false;
      const pendingImport = diagnostic?.clientId === peer.clientId
        && isPendingPcbImportResult(diagnostic.path, { action: 'import_changes' }, message.result);
      if (pendingImport) {
        diagnostic.pendingNativeConfirmation = true;
        diagnostic.uncertaintyReason = 'native PCB import confirmation pending';
        updatePendingPcbImportContext(diagnostic, message.result);
        this.pendingImportSockets.set(requestId, peer.socket);
      }
      else if (diagnostic?.clientId === peer.clientId && !bridgeTimedOut && !commitUnknown
        && diagnostic.requiredReadback !== 'pcb_component_positions'
        && diagnostic.requiredReadback !== 'pcb_routing_state') {
        this.recoveryDiagnostics.delete(requestId);
      }
      return;
    }
    this.clearPendingTimeout(pending);
    this.pendingRequests.delete(requestId);
    const bridgeTimeoutMs = getBridgeTaskTimeoutMs(message.error);
    if (bridgeTimeoutMs !== undefined) {
      this.recordTimedOutRequest(requestId, pending, bridgeTimeoutMs);
    }
    else if (isPcbAutoLayoutRequest(pending.path ?? '', pending.payload)
      && isRecord(message.result)
      && message.result.ok === false
      && message.result.commitState === 'unknown'
      && message.result.retryBlocked === true) {
      this.recordTimedOutRequest(requestId, pending, pending.executionTimeoutMs ?? 30000, 'native autoLayout timeout');
    }
    else if (isPcbAutoRoutingRequest(pending.path ?? '', pending.payload)
      && isRecord(message.result)
      && message.result.commitState === 'unknown'
      && message.result.retryBlocked === true) {
      this.recordTimedOutRequest(requestId, pending, pending.executionTimeoutMs ?? 30000, 'native autoRouting timeout');
    }
    else if (!isReadOnlyRequest(pending.path ?? '', pending.payload)
      && isRecord(message.result)
      && message.result.commitUnknown === true) {
      const pinNetworkChanged = pending.path === '/bridge/jlceda/schematic/component-edit'
        && message.result.reason === 'pin_network_changed';
      this.recordTimedOutRequest(requestId, pending, pending.executionTimeoutMs ?? 30000,
        pinNetworkChanged ? 'component pin network changed' : 'write result could not be verified',
        message.result.nativeCallSettled === true);
      if (pinNetworkChanged) {
        const diagnostic = this.recoveryDiagnostics.get(requestId);
        if (diagnostic) diagnostic.requiredReadback = 'schematic_connectivity_primitives';
      }
    }
    else if (isPendingPcbImportResult(pending.path, pending.payload, message.result)) {
      this.recordTimedOutRequest(requestId, pending, pending.executionTimeoutMs ?? 30000, 'native PCB import confirmation pending');
      const diagnostic = this.recoveryDiagnostics.get(requestId)!;
      diagnostic.pendingNativeConfirmation = true;
      updatePendingPcbImportContext(diagnostic, message.result);
      this.pendingImportSockets.set(requestId, peer.socket);
    }
    this.updateAutoLayoutDiagnostic(requestId, message.result, peer.clientId);
    this.updatePcbDocumentDiagnostic(requestId, message.result, peer.clientId);
    if (message.error) {
      pending.reject(isRecord(message.error) ? new BridgeTaskError(normalizeBridgeTaskError(message.error)) : new Error(String(message.error)));
      return;
    }
    pending.resolve(message.result);
  }

  private markPendingRequestStarted(peer: BridgePeer, message: Record<string, unknown>): void {
    const requestId = String(message.requestId ?? '');
    const pending = this.pendingRequests.get(requestId);
    if (!pending || pending.started || pending.clientId !== peer.clientId || pending.edaSocket !== peer.socket || pending.leaseTerm !== Number(message.leaseTerm)) {
      return;
    }

    pending.started = true;
    pending.startedAt = Date.now();
    if (!isReadOnlyRequest(pending.path ?? '', pending.payload)) {
      const executionContext = parseClientContext(message.context);
      pending.context = isPcbAutoLayoutRequest(pending.path ?? '', pending.payload)
        ? executionContext?.pageKind === 'pcb' && executionContext.pageUuid
          ? executionContext
          : { pageKind: 'pcb' }
        : executionContext;
    }
    this.clearPendingTimeout(pending);
    const executionTimeoutMs = pending.executionTimeoutMs ?? 30000;
    if (pending.mcpSocket && pending.internalRequestId) {
      this.trySend(pending.mcpSocket, {
        type: 'bridge/task-started',
        requestId: pending.internalRequestId,
      });
    }
    pending.timeout = setTimeout(() => {
      // The EDA handler cannot be cancelled when the server-side timeout wins.
      // Keep this client quarantined for the execution window before admitting
      // another task that could mutate the same document.
      this.recordTimedOutRequest(requestId, pending, executionTimeoutMs);
      this.pendingRequests.delete(requestId);
      pending.reject(new Error(`Request execution timeout after ${String(executionTimeoutMs)}ms`));
    }, executionTimeoutMs);
  }

  private clearPendingTimeout(pending: PendingRequest): void {
    if (pending.timeout) {
      clearTimeout(pending.timeout);
      pending.timeout = undefined;
    }
  }

  private attachMcpSocket(socket: WebSocket): void {
    this.mcpClients.add(socket);
    this.trySend(socket, { type: 'bridge/internal-ready' });
    socket.on('message', (data) => {
      let message: unknown;
      try {
        message = decodeBridgeMessage(data);
      } catch {
        socket.close(1007, 'Invalid JSON');
        return;
      }
      const validationError = validateInternalTaskMessage(message);
      if (validationError) {
        this.trySend(socket, {
          type: 'bridge/result',
          requestId: isRecord(message) && typeof message.requestId === 'string' ? message.requestId : '',
          error: validationError,
        });
        return;
      }
      if (!isRecord(message)) {
        return;
      }
      const requestId = String(message.requestId ?? '');
      const path = String(message.path ?? '');
      if (this.pendingRequests.has(requestId)) {
        this.trySend(socket, {
          type: 'bridge/result',
          requestId,
          error: 'Duplicate bridge requestId',
        });
        return;
      }
      const forwardedTimeoutMs = Number(message.timeoutMs);
      const timeoutMs = Number.isInteger(forwardedTimeoutMs) && forwardedTimeoutMs > 0
        ? Math.min(forwardedTimeoutMs, BRIDGE_QUEUE_TIMEOUT_MS)
        : 30000;
      void this.dispatchRequest(path, message.payload, timeoutMs, socket, requestId).then(
        (result) => {
          if (!this.trySend(socket, { type: 'bridge/result', requestId, result })) {
            this.trySend(socket, {
              type: 'bridge/result',
              requestId,
              error: 'Bridge result exceeded the WebSocket payload limit',
            });
          }
        },
        (error) => this.trySend(socket, {
          type: 'bridge/result',
          requestId,
          error: serializeBridgeError(error),
        }),
      );
    });
    const cleanupMcpSocket = (): void => {
      this.mcpClients.delete(socket);
      this.rejectPendingForMcpSocket(socket, 'MCP client disconnected while the request was pending');
    };
    socket.on('close', cleanupMcpSocket);
    socket.on('error', cleanupMcpSocket);
  }

  private handleInternalMessage(data: RawData): void {
    try {
      const message = decodeBridgeMessage(data);
      if (!isRecord(message)) {
        return;
      }
      const requestId = String(message.requestId ?? '');
      const pending = this.pendingRequests.get(requestId);
      if (!pending) {
        return;
      }
      if (message.type === 'bridge/task-started') {
        this.markInternalPendingRequestStarted(pending, requestId);
        return;
      }
      if (message.type !== 'bridge/result') {
        return;
      }
      this.clearPendingTimeout(pending);
      this.pendingRequests.delete(requestId);
      if (message.error) {
        pending.reject(isRecord(message.error) ? new BridgeTaskError(normalizeBridgeTaskError(message.error)) : new Error(String(message.error)));
      } else {
        pending.resolve(message.result);
      }
    } catch (error) {
      process.stderr.write(`Failed to parse message from main server: ${String(error)}\n`);
    }
  }

  public async request(path: string, payload: unknown, timeoutMs: number = 30000): Promise<unknown> {
    if (!this.started) {
      throw new Error('Bridge server not started');
    }
    if (!this.isMainServer) {
      return this.dispatchViaInternalClient(path, payload, timeoutMs);
    }
    return this.dispatchRequest(path, payload, timeoutMs);
  }

  private async dispatchRequest(path: string, payload: unknown, timeoutMs: number, mcpSocket?: WebSocket, internalRequestId?: string): Promise<unknown> {
    if (path === '/bridge/admin/clients') {
      return this.getClientSnapshot();
    }
    if (path === '/bridge/admin/select-client') {
      const clientId = isRecord(payload) ? String(payload.clientId ?? '').trim() : '';
      const force = isRecord(payload) && payload.force === true;
      return this.selectClientWithProbe(clientId, force);
    }
    if (path === '/bridge/admin/recover-client') {
      return this.recoverClient(payload, timeoutMs);
    }
    return this.dispatchToEda(path, payload, timeoutMs, mcpSocket, false, undefined, internalRequestId);
  }

  private isPeerReady(peer: BridgePeer, now = Date.now()): boolean {
    return peer.isReady
      && peer.socket.readyState === WebSocket.OPEN
      && now - (peer.lastHeartbeatAt || peer.connectedAt) <= this.peerTtlMs;
  }

  private promoteReadyPeerIfNeeded(peer: BridgePeer): void {
    if (!this.isPeerReady(peer) || this.activeClientId === peer.clientId)
      return;
    const active = this.peers.get(this.activeClientId);
    if ((active && (this.isPeerReady(active) || this.activeClientExplicitlySelected))
      || this.recoverySession || this.resolvingImports.size > 0
      || hasMutatingRecoveryDiagnostics(this.recoveryDiagnostics.values())
      || [...this.pendingRequests.values()].some(request => request.clientId === this.activeClientId))
      return;
    this.activeClientId = peer.clientId;
    this.activeClientExplicitlySelected = false;
    this.leaseTerm += 1;
    this.broadcastRoles('Ready standby promoted');
  }

  private getClientSnapshot(): Record<string, unknown> {
    this.pruneRecoveryDiagnostics();
    const now = Date.now();
    const clients = [...this.peers.values()]
      .sort((left, right) => left.connectedAt - right.connectedAt)
      .map((peer) => ({
        clientId: peer.clientId,
        active: peer.clientId === this.activeClientId,
        ready: this.isPeerReady(peer, now),
        bridgeVersion: peer.bridgeVersion,
        selectionProbeSupported: peer.selectionProbeVersion === 1,
        connectedAt: new Date(peer.connectedAt).toISOString(),
        lastSeenMsAgo: Math.max(0, now - peer.lastSeenAt),
        lastHeartbeatMsAgo: peer.lastHeartbeatAt ? Math.max(0, now - peer.lastHeartbeatAt) : null,
        context: peer.context,
        quarantine: this.recoverySession?.targetClientId === peer.clientId
          ? { state: 'readback-required', recoveryId: this.recoverySession.recoveryId }
          : [...this.recoveryDiagnostics.values()].some(diagnostic => diagnostic.clientId === peer.clientId)
            ? {
              state: 'timed-out',
              diagnostics: [...this.recoveryDiagnostics.values()].filter(diagnostic => diagnostic.clientId === peer.clientId),
            }
            : undefined,
        }));
    const visibleClientIds = new Set(clients.map((client) => client.clientId));
    const disconnectedDiagnostics = new Map<string, RecoveryDiagnostic[]>();
    for (const diagnostic of this.recoveryDiagnostics.values()) {
      if (!visibleClientIds.has(diagnostic.clientId)) {
        const entries = disconnectedDiagnostics.get(diagnostic.clientId) ?? [];
        entries.push(diagnostic);
        disconnectedDiagnostics.set(diagnostic.clientId, entries);
      }
    }
    for (const [clientId, diagnostics] of disconnectedDiagnostics) {
      clients.push({
        clientId,
        active: false,
        ready: false,
        bridgeVersion: 'unknown',
        selectionProbeSupported: false,
        connectedAt: diagnostics[0].startedAt,
        lastSeenMsAgo: Math.max(0, now - diagnostics.reduce((earliest, diagnostic) => Math.min(earliest, diagnostic.timedOutAtMs), now)),
        lastHeartbeatMsAgo: null,
        context: diagnostics.find((diagnostic) => diagnostic.context)?.context,
        quarantine: { state: 'timed-out', diagnostics },
      });
    }
    return { activeClientId: this.activeClientId || null, leaseTerm: this.leaseTerm, clients };
  }

  private async selectClientWithProbe(clientId: string, force: boolean): Promise<Record<string, unknown>> {
    if (!clientId)
      throw new Error('clientId is required');
    const peer = this.peers.get(clientId);
    if (!peer || !this.isPeerReady(peer))
      throw new Error(`EDA client is not connected and ready: ${clientId}`);
    if (this.activeClientId === clientId)
      return this.selectClient(clientId, force);
    if (this.recoverySession)
      throw new Error(`Cannot switch EDA client while recovery ${this.recoverySession.recoveryId} is awaiting readback.`);
    if (!force && [...this.pendingRequests.values()].some(pending => pending.clientId === this.activeClientId))
      throw new Error('Cannot switch EDA client while the active client has a pending task');
    if (peer.selectionProbeVersion !== 1)
      throw new Error(`EDA client ${clientId} does not support selection probe; upgrade its Bridge extension before selecting it.`);
    await this.probeClient(peer);
    if (this.peers.get(clientId) !== peer || !this.isPeerReady(peer))
      throw new Error(`EDA client disconnected before selection completed: ${clientId}`);
    return this.selectClient(clientId, force);
  }

  private probeClient(peer: BridgePeer): Promise<void> {
    const probeId = this.createRequestId();
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingSelectionProbes.delete(probeId);
        reject(new Error(`EDA client selection probe timed out: ${peer.clientId}`));
      }, SELECTION_PROBE_TIMEOUT_MS);
      this.pendingSelectionProbes.set(probeId, { clientId: peer.clientId, socket: peer.socket, resolve, reject, timeout });
      if (!this.trySend(peer.socket, { type: 'bridge/probe', clientId: peer.clientId, probeId }))
        this.rejectSelectionProbesForSocket(peer.socket, `Could not send selection probe to EDA client: ${peer.clientId}`);
    });
  }

  private rejectSelectionProbesForSocket(socket: WebSocket, reason: string): void {
    for (const [probeId, pending] of this.pendingSelectionProbes) {
      if (pending.socket !== socket)
        continue;
      clearTimeout(pending.timeout);
      this.pendingSelectionProbes.delete(probeId);
      pending.reject(new Error(reason));
    }
  }

  private selectClient(clientId: string, force: boolean, allowRecoverySessionSwitch = false): Record<string, unknown> {
    if (!clientId) {
      throw new Error('clientId is required');
    }
    const peer = this.peers.get(clientId);
    if (!peer || !this.isPeerReady(peer)) {
      throw new Error(`EDA client is not connected and ready: ${clientId}`);
    }
    if (this.recoverySession && this.activeClientId !== clientId && !allowRecoverySessionSwitch) {
      throw new Error(`Cannot switch EDA client while recovery ${this.recoverySession.recoveryId} is awaiting readback.`);
    }
    const hasPendingTask = [...this.pendingRequests.values()].some(
      (pending) => pending.clientId === this.activeClientId,
    );
    if (hasPendingTask && this.activeClientId !== clientId) {
      if (!force) {
        throw new Error('Cannot switch EDA client while the active client has a pending task');
      }
      this.rejectPendingForClient(this.activeClientId, `Active EDA client was force-switched to ${clientId}`);
    }
    if (this.activeClientId !== clientId) {
      this.activeClientId = clientId;
      this.leaseTerm += 1;
      this.broadcastRoles('Client explicitly selected by MCP');
    }
    this.activeClientExplicitlySelected = true;
    return this.getClientSnapshot();
  }

  private recordTimedOutRequest(requestId: string, pending: PendingRequest, timeoutMs: number, uncertaintyReason = 'execution timeout', nativeCallSettled = false): void {
    if (!pending.clientId) {
      return;
    }
    this.enterReconnectBarrier(pending.clientId);
    const mutating = !isReadOnlyRequest(pending.path ?? '', pending.payload);
    const targetProjectUuid = mutating ? knownProjectTargetUuid(pending.path ?? '', pending.payload) : undefined;
    const diagnostic: RecoveryDiagnostic = {
      requestId,
      clientId: pending.clientId,
      path: pending.path ?? '/bridge/jlceda/unknown',
      startedAt: new Date(pending.startedAt ?? Date.now()).toISOString(),
      timeoutMs,
      timedOutAtMs: Date.now(),
      mutating,
      pageBound: mutating && isPageBoundWrite(pending.path ?? '', pending.payload),
      ...(mutating && pending.path === '/bridge/jlceda/api/invoke'
        ? { hostRestartRequired: !nativeCallSettled } : {}),
      ...(targetProjectUuid ? { targetProjectUuid } : {}),
      ...(mutating && pending.path === '/bridge/jlceda/editor/navigate' && isRecord(pending.payload)
        ? { targetDocumentUuid: optionalString(pending.payload.documentUuid), targetTabId: optionalString(pending.payload.tabId), hostRestartRequired: !nativeCallSettled }
        : {}),
      ...(isPcbAutoLayoutRequest(pending.path ?? '', pending.payload) ? { requiredReadback: 'pcb_component_positions' as const } : {}),
      ...(mutating && pending.path === '/bridge/jlceda/pcb/component-edit'
        ? { requiredReadback: 'pcb_component_state' as const, hostRestartRequired: !nativeCallSettled }
        : {}),
      ...(mutating && pending.path === '/bridge/jlceda/pcb/pour-manage'
        ? { requiredReadback: 'pcb_pour_state' as const, hostRestartRequired: !nativeCallSettled }
        : {}),
      ...(mutating && pending.path === '/bridge/jlceda/pcb/region-manage'
        ? { requiredReadback: 'pcb_region_state' as const, hostRestartRequired: !nativeCallSettled }
        : {}),
      ...(mutating && pending.path === '/bridge/jlceda/pcb/text-manage'
        ? { requiredReadback: 'pcb_text_state' as const, hostRestartRequired: !nativeCallSettled }
        : {}),
      ...(mutating && pending.path === '/bridge/jlceda/schematic/text-manage'
        ? { requiredReadback: 'schematic_text_state' as const, hostRestartRequired: !nativeCallSettled }
        : {}),
      ...(mutating && pending.path === '/bridge/jlceda/pcb/documents-manage'
        ? { requiredReadback: 'pcb_document_inventory' as const, hostRestartRequired: !nativeCallSettled,
            targetPcbUuid: isRecord(pending.payload) ? optionalString(pending.payload.pcbUuid) : undefined }
        : {}),
      ...(mutating && pending.path === '/bridge/jlceda/board/setup'
        ? { requiredReadback: 'board_document_inventory' as const, hostRestartRequired: !nativeCallSettled }
        : {}),
      ...(mutating && pending.path === '/bridge/jlceda/pcb/layer-manage'
        ? { requiredReadback: 'pcb_layer_state' as const, hostRestartRequired: !nativeCallSettled }
        : {}),
      ...((isPcbAutoRoutingRequest(pending.path ?? '', pending.payload)
        || isPcbConnectivityMutation(pending.path ?? '', pending.payload)
        || isPcbRoutingEditMutation(pending.path ?? '', pending.payload)
        || isPcbBoardOutlineMutation(pending.path ?? '', pending.payload))
        ? { requiredReadback: 'pcb_routing_state' as const,
            hostRestartRequired: !nativeCallSettled || isPcbAutoRoutingRequest(pending.path ?? '', pending.payload) }
        : {}),
      ...(mutating && isSchematicPlacementWrite(pending.path ?? '')
        ? { requiredReadback: 'schematic_component_ids' as const, hostRestartRequired: !nativeCallSettled }
        : {}),
      ...(mutating && pending.path === '/bridge/jlceda/schematic/component-edit'
        ? { requiredReadback: 'schematic_component_state' as const, hostRestartRequired: !nativeCallSettled }
        : {}),
      ...(mutating && isSchematicConnectivityMutation(pending.path ?? '', pending.payload)
        ? { requiredReadback: 'schematic_connectivity_primitives' as const, hostRestartRequired: !nativeCallSettled } : {}),
      ...(mutating && isSchematicPinModify(pending.path ?? '', pending.payload) && isRecord(pending.payload) && Array.isArray(pending.payload.args)
		? { targetSchematicPinPrimitiveId: optionalString(pending.payload.args[0]) } : {}),
      ...(mutating && isTargetedSchematicPageMutation(pending.path ?? '', pending.payload)
        ? { requiredReadback: 'schematic_page_inventory' as const, ...schematicPageMutationTarget(pending.path ?? '', pending.payload) } : {}),
      uncertaintyReason,
      context: pending.context,
    };
    this.recoveryDiagnostics.set(requestId, diagnostic);
  }

  private updateAutoLayoutDiagnostic(requestId: string, result: unknown, clientId: string): void {
    const diagnostic = this.recoveryDiagnostics.get(requestId);
    if (diagnostic?.clientId !== clientId || diagnostic.requiredReadback !== 'pcb_component_positions' || !isRecord(result))
      return;
    const layoutContext = parseClientContext(result.layoutContext);
    const pageUuid = layoutContext?.pageKind === 'pcb' ? layoutContext.pageUuid : optionalString(result.pcbUuid);
    if (!pageUuid)
      return;
    diagnostic.context = {
      pageKind: 'pcb',
      pageUuid,
      documentUuid: layoutContext?.documentUuid,
      projectUuid: layoutContext?.projectUuid,
    };
  }

  private updatePcbDocumentDiagnostic(requestId: string, result: unknown, clientId: string): void {
    const diagnostic = this.recoveryDiagnostics.get(requestId);
    if (diagnostic?.clientId !== clientId || diagnostic.requiredReadback !== 'pcb_document_inventory' || !isRecord(result))
      return;
    const resultingPcbUuid = optionalString(result.resultingPcbUuid);
    if (resultingPcbUuid)
      diagnostic.targetPcbUuid = resultingPcbUuid;
  }

  private async recoverClient(payload: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
    this.pruneRecoveryDiagnostics();
    if (!isRecord(payload) || payload.confirm !== true) {
      throw new Error('bridge_recover_client requires confirm=true.');
    }
    const action = payload.action === undefined ? 'recover' : String(payload.action);
    if (action !== 'recover' && action !== 'readback' && action !== 'resolve_import') {
      throw new Error('bridge_recover_client action must be recover, readback, or resolve_import.');
    }

    if (action === 'resolve_import') {
      return await this.resolvePendingPcbImport(payload, timeoutMs);
    }

    if (action === 'recover') {
      if (this.recoverySession) {
        throw new Error('A Bridge recovery is already awaiting readback.');
      }
      const requestId = String(payload.requestId ?? '').trim();
      if (!requestId) {
        throw new Error('bridge_recover_client action=recover requires the timed-out requestId from bridge_clients.');
      }
      const diagnostic = this.recoveryDiagnostics.get(requestId);
      if (!diagnostic)
        throw new Error(`No unresolved timeout diagnostic exists for requestId: ${requestId}`);
      if (diagnostic.importContextConflict)
        throw new Error('PCB import identity disagrees with its execution context; inspect both PCB pages before restarting the MCP Server. Writes remain blocked.');
      const sourceClientId = diagnostic.clientId;
      if (!diagnostic.mutating) {
        throw new Error('The active timed-out task was read-only and does not require controlled mutation recovery.');
      }
      if (this.resolvingImports.has(requestId)) {
        throw new Error('PCB import resolution is already in progress.');
      }
      const source = this.peers.get(sourceClientId);
      const sourceConnected = Boolean(source && this.isPeerReady(source));
      const recoveryId = randomUUID();
      this.recoverySession = {
        recoveryId,
        diagnostic,
        requestedAt: new Date().toISOString(),
        sourceConnected,
        sourceSocket: source?.socket,
        preRecoverySockets: new Set([...this.peers.values()].map(peer => peer.socket)),
        preRecoveryClientIds: new Set([sourceClientId, ...this.peers.keys()]),
      };
      if (sourceConnected) {
        this.trySend(source!.socket, {
          type: 'bridge/recover',
          recoveryId,
          reason: `Controlled recovery after timed-out mutation ${diagnostic.requestId}`,
        });
      }
      return {
        ok: true,
        action,
        recoveryId,
        sourceClientId,
        freshBridgeGenerationRequested: sourceConnected,
        sourceConnected,
        readbackRequired: true,
        warning: 'mutation may have completed; underlying EDA API was not cancelled',
        diagnostic,
      };
    }

    const session = this.recoverySession;
    if (!session) {
      throw new Error('No Bridge recovery is awaiting readback.');
    }
    const pcbRoutingWriteLabel = session.diagnostic.path === '/bridge/jlceda/api/invoke'
      ? 'Timed-out PCB autoRouting'
      : session.diagnostic.path === '/bridge/jlceda/pcb/board-outline-manage'
        ? 'Unverified PCB board outline write'
        : 'Unverified PCB routing write';
    if (String(payload.recoveryId ?? '').trim() !== session.recoveryId) {
      throw new Error('recoveryId does not match the active recovery session.');
    }
    if (session.diagnostic.importContextConflict)
      throw new Error('PCB import identity disagrees with its execution context; writes remain blocked.');
    const pendingImportAtReadbackStart = session.diagnostic.pendingNativeConfirmation === true;
    const targetClientId = String(payload.clientId ?? '').trim();
    if (!targetClientId) {
      throw new Error('clientId must identify the fresh Bridge client reported by bridge_clients.');
    }
    if (session.targetClientId && session.targetClientId !== targetClientId) {
      throw new Error(`Recovery readback is already bound to client ${session.targetClientId}.`);
    }
    const readbackPath = String(payload.readbackPath ?? '/bridge/jlceda/context');
    const readbackPayload = isRecord(payload.readbackPayload) ? payload.readbackPayload : {};
    if (!isReadOnlyRequest(readbackPath, readbackPayload)) {
      throw new Error('readbackPath and readbackPayload must describe a read-only operation; schematic layout mode=fix is not allowed.');
    }
    if (session.diagnostic.requiredReadback === 'pcb_component_positions'
      && !isPcbComponentReadbackRequest(readbackPath, readbackPayload)) {
      throw new Error('Timed-out PCB autoLayout requires eda.pcb_PrimitiveComponent.getAll with no arguments for recovery readback.');
    }
    if (session.diagnostic.requiredReadback === 'pcb_component_state'
      && !isPcbComponentStateReadbackRequest(readbackPath, readbackPayload)) {
      throw new Error('PCB component edit requires pcb_component_edit action=read for complete current-page recovery readback.');
    }
    if (session.diagnostic.requiredReadback === 'pcb_pour_state'
      && !isPcbPourStateReadbackRequest(readbackPath, readbackPayload)) {
      throw new Error('PCB pour management requires pcb_pour_manage action=read for complete current-page recovery readback.');
    }
    if (session.diagnostic.requiredReadback === 'pcb_region_state'
      && !isPcbRegionStateReadbackRequest(readbackPath, readbackPayload)) {
      throw new Error('PCB region management requires pcb_region_manage action=read without primitiveId for complete current-page recovery readback.');
    }
    if (session.diagnostic.requiredReadback === 'pcb_text_state'
      && !isPcbTextStateReadbackRequest(readbackPath, readbackPayload)) {
      throw new Error('PCB text management requires pcb_text_manage action=read without filters for complete current-page recovery readback.');
    }
    if (session.diagnostic.requiredReadback === 'schematic_text_state'
      && !isSchematicTextStateReadbackRequest(readbackPath, readbackPayload)) {
      throw new Error('Schematic text management requires schematic_text_manage action=read without primitiveId for complete current-page recovery readback.');
    }
    if (session.diagnostic.requiredReadback === 'pcb_document_inventory'
      && !isPcbDocumentInventoryReadbackRequest(readbackPath, readbackPayload, session.diagnostic.targetProjectUuid)) {
      throw new Error('PCB document management requires pcb_documents_manage operation=list for the target project recovery readback.');
    }
    if (session.diagnostic.requiredReadback === 'board_document_inventory'
      && !isBoardDocumentInventoryReadbackRequest(readbackPath, readbackPayload)) {
      throw new Error('Board setup requires project_info with includePages=false, includeBoards/includeSchematics/includePcbs=true, and limit=500 for recovery readback.');
    }
    if (session.diagnostic.requiredReadback === 'pcb_layer_state'
      && !isPcbLayerStateReadbackRequest(readbackPath, readbackPayload)) {
      throw new Error('PCB copper-layer management requires pcb_layer_manage action=read for current-page recovery readback.');
    }
    if (session.diagnostic.requiredReadback === 'pcb_routing_state'
      && !isPcbRoutingReadbackRequest(readbackPath, readbackPayload)) {
      throw new Error(`${pcbRoutingWriteLabel} requires eda.pcb_PrimitiveLine.getAll with no arguments for recovery readback.`);
    }
    if (session.diagnostic.requiredReadback === 'schematic_component_ids'
      && !isSchematicComponentIdReadbackRequest(readbackPath, readbackPayload)) {
      throw new Error('Schematic placement requires current-page eda.sch_PrimitiveComponent.getAllPrimitiveId with args [null, false] for recovery readback.');
    }
    if (session.diagnostic.requiredReadback === 'schematic_component_state'
      && !isSchematicComponentStateReadbackRequest(readbackPath, readbackPayload)) {
      throw new Error('Schematic component edit requires schematic_component_edit action=read for complete current-page recovery readback.');
    }
    if (session.diagnostic.requiredReadback === 'schematic_page_inventory'
      && !isSchematicPageInventoryReadbackRequest(readbackPath, readbackPayload)) {
      throw new Error('Schematic page mutation requires eda.dmt_Schematic.getAllSchematicPagesInfo with no arguments for recovery readback.');
    }
    if (session.diagnostic.requiredReadback === 'schematic_connectivity_primitives'
      && !isSchematicConnectivityReadbackRequest(readbackPath, readbackPayload)) {
      throw new Error('Schematic connectivity mutation requires schematic_read with includeConnectivityPrimitives=true for recovery readback.');
    }
    if ((session.diagnostic.requiredReadback === 'schematic_component_ids'
      || session.diagnostic.requiredReadback === 'schematic_component_state'
      || session.diagnostic.requiredReadback === 'schematic_text_state')
      && (session.diagnostic.context?.pageKind !== 'schematic' || !session.diagnostic.context.pageUuid)) {
      throw new Error('Schematic write has no verified execution-time schematic page identity; writes remain blocked.');
    }
    if (session.diagnostic.requiredReadback === 'pcb_component_positions'
      && (session.diagnostic.context?.pageKind !== 'pcb' || !session.diagnostic.context.pageUuid)) {
      throw new Error('Timed-out PCB autoLayout has no verified execution-time PCB page identity; writes remain blocked.');
    }
    if (session.diagnostic.requiredReadback === 'pcb_component_state'
      && (session.diagnostic.context?.pageKind !== 'pcb' || !session.diagnostic.context.pageUuid)) {
      throw new Error('PCB component edit has no verified execution-time PCB page identity; writes remain blocked.');
    }
    if (session.diagnostic.requiredReadback === 'pcb_pour_state'
      && (session.diagnostic.context?.pageKind !== 'pcb' || !session.diagnostic.context.pageUuid)) {
      throw new Error('PCB pour write has no verified execution-time PCB page identity; writes remain blocked.');
    }
    if (session.diagnostic.requiredReadback === 'pcb_region_state'
      && (session.diagnostic.context?.pageKind !== 'pcb' || !session.diagnostic.context.pageUuid)) {
      throw new Error('PCB region write has no verified execution-time PCB page identity; writes remain blocked.');
    }
    if (session.diagnostic.requiredReadback === 'pcb_text_state'
      && (session.diagnostic.context?.pageKind !== 'pcb' || !session.diagnostic.context.pageUuid)) {
      throw new Error('PCB text write has no verified execution-time PCB page identity; writes remain blocked.');
    }
    if (session.diagnostic.requiredReadback === 'pcb_layer_state'
      && (session.diagnostic.context?.pageKind !== 'pcb' || !session.diagnostic.context.pageUuid)) {
      throw new Error('PCB copper-layer write has no verified execution-time PCB page identity; writes remain blocked.');
    }
    if (session.diagnostic.requiredReadback === 'pcb_routing_state'
      && (session.diagnostic.context?.pageKind !== 'pcb' || !session.diagnostic.context.pageUuid)) {
      throw new Error(`${pcbRoutingWriteLabel} has no verified execution-time PCB page identity; writes remain blocked.`);
    }
    if (session.diagnostic.hostRestartRequired && payload.hostRestartConfirmed !== true) {
      const writeLabel = session.diagnostic.requiredReadback === 'schematic_component_ids'
        ? 'Unverified schematic placement'
        : session.diagnostic.requiredReadback === 'pcb_component_state'
          ? 'Unverified PCB component edit'
        : session.diagnostic.requiredReadback === 'pcb_pour_state'
          ? 'Unverified PCB pour write'
        : session.diagnostic.requiredReadback === 'pcb_region_state'
          ? 'Unverified PCB region write'
        : session.diagnostic.requiredReadback === 'pcb_text_state'
          ? 'Unverified PCB text write'
        : session.diagnostic.requiredReadback === 'pcb_layer_state'
          ? 'Unverified PCB copper-layer write'
        : session.diagnostic.requiredReadback === 'board_document_inventory'
          ? 'Unverified Board setup'
        : session.diagnostic.requiredReadback === 'schematic_component_state'
          ? 'Unverified schematic component edit'
        : session.diagnostic.requiredReadback === 'schematic_text_state'
          ? 'Unverified schematic text write'
        : session.diagnostic.requiredReadback === 'schematic_connectivity_primitives'
          ? 'Unverified schematic connectivity write'
          : session.diagnostic.requiredReadback === 'pcb_routing_state'
            ? pcbRoutingWriteLabel
            : session.diagnostic.requiredReadback === 'pcb_component_positions'
              ? 'Unverified PCB autoLayout'
              : 'Unverified EDA API write';
      throw new Error(`${writeLabel} requires confirmation that the original EDA host was restarted; writes remain blocked.`);
    }
    if (session.diagnostic.pendingNativeConfirmation
      && (payload.hostRestartConfirmed !== true || !isPcbComponentReadbackRequest(readbackPath, readbackPayload))) {
      throw new Error('Pending PCB import recovery requires confirmation that the original EDA host was restarted and a complete PCB component readback.');
    }
    if (session.sourceSocket
      && this.peers.get(session.diagnostic.clientId)?.socket === session.sourceSocket) {
      throw new Error('The original Bridge client must disconnect before recovery readback. Wait for its EDA call to settle, or restart the EDA host if it remains hung.');
    }
    const target = this.peers.get(targetClientId);
    if (!target || !this.isPeerReady(target))
      throw new Error(`EDA client is not connected and ready: ${targetClientId}`);
    if (session.targetClientId && session.targetSocket !== target.socket) {
      throw new Error('Recovery readback target connection was replaced; retry with the new Bridge generation.');
    }
    // A disconnected source may still have a native EDA call in flight; an
    // already-connected standby is not a new host generation.
    // A routine transport reconnect replaces the socket but keeps the same
    // Bridge runtime clientId. Controlled recovery or a new runtime changes it.
    if (session.preRecoverySockets.has(target.socket) || session.preRecoveryClientIds.has(target.clientId))
      throw new Error('clientId is not a fresh Bridge generation created after recovery was requested.');
    const executionContext = session.diagnostic.context;
    if (session.diagnostic.pageBound && (!executionContext?.pageKind || !executionContext.pageUuid))
      throw new Error('Timed-out write has no verified execution-time page identity; writes remain blocked.');
    const requestedPageUuid = optionalString(payload.expectedPageUuid);
    if (requestedPageUuid && (!session.diagnostic.pageBound || requestedPageUuid !== executionContext?.pageUuid))
      throw new Error('expectedPageUuid does not match the verified execution-time page identity; writes remain blocked.');
    const expectedDocumentUuid = session.diagnostic.pageBound
      ? executionContext?.documentUuid ?? optionalString(payload.expectedDocumentUuid)
      : session.diagnostic.targetDocumentUuid ?? optionalString(payload.expectedDocumentUuid);
    const expectedProjectUuid = session.diagnostic.targetProjectUuid
      ?? (session.diagnostic.pageBound
        || session.diagnostic.requiredReadback === 'schematic_page_inventory'
        ? executionContext?.projectUuid : undefined)
      ?? optionalString(payload.expectedProjectUuid);
    const expectedPageUuid = session.diagnostic.pageBound ? executionContext?.pageUuid : undefined;
    const expectedPageKind = session.diagnostic.pageBound ? executionContext?.pageKind : undefined;
    const executionIdentity = {
      pageKind: executionContext?.pageKind,
      pageUuid: executionContext?.pageUuid,
      documentUuid: executionContext?.documentUuid,
      projectUuid: executionContext?.projectUuid,
    };
    if (!expectedDocumentUuid && !expectedProjectUuid)
      throw new Error('Recovery requires a target expectedDocumentUuid or expectedProjectUuid for this write.');
    if (expectedDocumentUuid && target.context?.documentUuid && target.context.documentUuid !== expectedDocumentUuid)
      throw new Error('Fresh Bridge client documentUuid does not match the expected document; writes remain blocked.');
    if (expectedProjectUuid && target.context?.projectUuid && target.context.projectUuid !== expectedProjectUuid)
      throw new Error('Fresh Bridge client projectUuid does not match the expected project; writes remain blocked.');
    if (expectedPageUuid && target.context?.pageUuid !== expectedPageUuid)
      throw new Error('Fresh Bridge client pageUuid does not match the timed-out page; writes remain blocked.');
    this.selectClient(targetClientId, true, true);
    session.targetClientId = targetClientId;
    session.targetSocket = target.socket;
    if (session.diagnostic.requiredReadback === 'pcb_routing_state'
      || session.diagnostic.requiredReadback === 'pcb_component_state'
      || session.diagnostic.requiredReadback === 'pcb_pour_state'
      || session.diagnostic.requiredReadback === 'pcb_region_state'
      || session.diagnostic.requiredReadback === 'pcb_text_state'
      || session.diagnostic.requiredReadback === 'pcb_layer_state') {
      if (!expectedPageUuid)
        throw new Error('PCB write has no verified execution-time PCB page identity; writes remain blocked.');
      const beforeRoutingReadback = await this.dispatchToEda('/bridge/jlceda/context', {}, Math.min(timeoutMs, RECOVERY_READBACK_TIMEOUT_MS), undefined, true, targetClientId);
      this.assertPcbIdentity(beforeRoutingReadback, expectedDocumentUuid, expectedProjectUuid, expectedPageUuid);
    }
    if (session.diagnostic.requiredReadback === 'schematic_component_ids'
      || session.diagnostic.requiredReadback === 'schematic_component_state'
      || session.diagnostic.requiredReadback === 'schematic_text_state') {
      const beforeSchematicReadback = await this.dispatchToEda('/bridge/jlceda/context', {}, Math.min(timeoutMs, RECOVERY_READBACK_TIMEOUT_MS), undefined, true, targetClientId);
      this.assertSchematicIdentity(beforeSchematicReadback, expectedDocumentUuid, expectedProjectUuid, expectedPageUuid!);
    }
    const requiresPcbPositions = session.diagnostic.requiredReadback === 'pcb_component_positions'
      || session.diagnostic.pendingNativeConfirmation;
    let effectiveReadbackPayload = requiresPcbPositions
      ? { ...readbackPayload, includeCompletePositions: true }
      : session.diagnostic.requiredReadback === 'pcb_routing_state'
        ? { ...readbackPayload, includeCompleteRouting: true }
        : session.diagnostic.requiredReadback === 'schematic_component_ids'
          ? { ...readbackPayload, includeCompleteSchematicComponentIds: true }
        : readbackPayload;
    const readbackPolicy = BRIDGE_CONTRACT.timeoutPolicies[operationForPath(readbackPath)?.timeoutPolicy ?? 'default'];
    // The main readback may scan a whole page. Leave one second for the Bridge result to reach the server.
    const bridgeReadbackBudget = Math.min(readbackPolicy.maxMs, timeoutMs - 1_000);
    if (readbackPolicy.allowOverride && bridgeReadbackBudget > readbackPolicy.defaultMs)
      effectiveReadbackPayload = { ...effectiveReadbackPayload, timeoutMs: bridgeReadbackBudget };
    const readback = await this.dispatchToEda(readbackPath, effectiveReadbackPayload, timeoutMs, undefined, true, targetClientId);
    if (isRecord(readback) && readback.ok === false) {
      const expectedNegative = readbackPath === '/bridge/jlceda/pcb/drc-check'
        || readbackPath === '/bridge/jlceda/schematic/drc-check';
      if (!expectedNegative || optionalString(readback.error)) {
        throw new Error(`Recovery readback failed: ${optionalString(readback.error) ?? 'the read-only operation returned ok:false'}`);
      }
    }
    if (session.diagnostic.requiredReadback === 'pcb_component_positions' || session.diagnostic.pendingNativeConfirmation)
      this.validateCompletePcbComponents(readback);
    if (session.diagnostic.requiredReadback === 'pcb_component_state')
      this.validateCompletePcbComponentState(readback, session.diagnostic);
    if (session.diagnostic.requiredReadback === 'pcb_pour_state')
      this.validateCompletePcbPourState(readback, session.diagnostic);
    if (session.diagnostic.requiredReadback === 'pcb_region_state')
      this.validateCompletePcbRegionState(readback, session.diagnostic);
    if (session.diagnostic.requiredReadback === 'pcb_text_state')
      this.validateCompletePcbTextState(readback, session.diagnostic);
    if (session.diagnostic.requiredReadback === 'pcb_document_inventory')
      this.validateCompletePcbDocuments(readback, session.diagnostic);
    if (session.diagnostic.requiredReadback === 'board_document_inventory')
      this.validateCompleteBoardDocuments(readback, session.diagnostic);
    if (session.diagnostic.requiredReadback === 'pcb_layer_state')
      this.validateCompletePcbLayerState(readback, session.diagnostic);
    const routingSnapshot = session.diagnostic.requiredReadback === 'pcb_routing_state'
      ? await this.readCompletePcbRoutingState(readback, targetClientId, timeoutMs)
      : undefined;
    if (session.diagnostic.requiredReadback === 'schematic_page_inventory')
      this.validateCompleteSchematicPages(readback, session.diagnostic);
    if (session.diagnostic.requiredReadback === 'schematic_connectivity_primitives')
      this.validateCompleteSchematicConnectivity(readback, session.diagnostic);
    if (session.diagnostic.requiredReadback === 'schematic_component_ids')
      this.validateCompleteSchematicComponentIds(readback);
    if (session.diagnostic.requiredReadback === 'schematic_component_state')
      this.validateCompleteSchematicComponentState(readback, session.diagnostic);
    if (session.diagnostic.requiredReadback === 'schematic_text_state')
      this.validateCompleteSchematicTextState(readback, session.diagnostic);
    const identityReadback = readbackPath === '/bridge/jlceda/context'
      ? readback
      : await this.dispatchToEda('/bridge/jlceda/context', {}, Math.min(timeoutMs, RECOVERY_READBACK_TIMEOUT_MS), undefined, true, targetClientId);
    const identity = extractReadbackIdentity(identityReadback, expectedPageKind);
    if (expectedDocumentUuid && identity.documentUuid !== expectedDocumentUuid) {
      throw new Error('Readback documentUuid does not match expectedDocumentUuid; writes remain blocked.');
    }
    if (session.diagnostic.targetTabId) {
      const identityRecord = isRecord(identityReadback) ? identityReadback : {};
      const document = isRecord(identityRecord.currentDocumentInfo) ? identityRecord.currentDocumentInfo : undefined;
      if (optionalString(document?.tabId) !== session.diagnostic.targetTabId)
        throw new Error('Readback tabId does not match the requested editor tab; writes remain blocked.');
    }
    if (expectedProjectUuid && identity.projectUuid !== expectedProjectUuid) {
      throw new Error('Readback projectUuid does not match expectedProjectUuid; writes remain blocked.');
    }
    if (expectedPageUuid && identity.pageUuid !== expectedPageUuid) {
      throw new Error('Readback pageUuid does not match the timed-out page; writes remain blocked.');
    }
    if (session.diagnostic.pendingNativeConfirmation) {
      if (!expectedPageUuid || expectedPageKind !== 'pcb')
        throw new Error('Pending PCB import recovery requires the original PCB page identity; writes remain blocked.');
      await this.readCompletePcbNets(targetClientId, timeoutMs);
      const finalContext = await this.dispatchToEda('/bridge/jlceda/context', {}, Math.min(timeoutMs, RECOVERY_READBACK_TIMEOUT_MS), undefined, true, targetClientId);
      this.assertPcbIdentity(finalContext, expectedDocumentUuid, expectedProjectUuid, expectedPageUuid);
    }
    if (session.diagnostic.context?.pageKind !== executionIdentity.pageKind
      || session.diagnostic.context?.pageUuid !== executionIdentity.pageUuid
      || session.diagnostic.context?.documentUuid !== executionIdentity.documentUuid
      || session.diagnostic.context?.projectUuid !== executionIdentity.projectUuid) {
      throw new Error('Write execution identity changed during recovery readback; retry against the actual page.');
    }
    if (session.diagnostic.importContextConflict)
      throw new Error('PCB import identity disagrees with its execution context during recovery readback; writes remain blocked.');
    if ((session.diagnostic.pendingNativeConfirmation === true) !== pendingImportAtReadbackStart)
      throw new Error('PCB import confirmation state changed during recovery readback; retry the import confirmation recovery flow. Writes remain blocked.');
    if (session.diagnostic.pendingNativeConfirmation
      && (payload.hostRestartConfirmed !== true || !isPcbComponentReadbackRequest(readbackPath, readbackPayload)))
      throw new Error('Pending PCB import recovery requires confirmation that the original EDA host was restarted and a complete PCB component readback.');
    this.recoverySession = undefined;
    this.recoveryDiagnostics.delete(session.diagnostic.requestId);
    this.pendingImportSockets.delete(session.diagnostic.requestId);
    return {
      ok: true,
      action,
      recoveryId: session.recoveryId,
      readbackVerified: true,
      writesRemainBlocked: hasMutatingRecoveryDiagnostics(this.recoveryDiagnostics.values()),
      unresolvedMutatingRequestIds: [...this.recoveryDiagnostics.values()].filter(item => item.mutating).map(item => item.requestId),
      readback,
      ...(routingSnapshot ? { routingSnapshot } : {}),
      identityReadback,
      warningAcknowledged: true,
    };
  }

  private assertPcbIdentity(value: unknown, documentUuid: string | undefined, projectUuid: string | undefined, pageUuid: string): void {
    const identity = extractReadbackIdentity(value, 'pcb');
    if ((documentUuid && identity.documentUuid !== documentUuid)
      || (projectUuid && identity.projectUuid !== projectUuid)
      || identity.pageUuid !== pageUuid) {
      throw new Error('PCB document or page identity changed during readback; writes remain blocked.');
    }
  }

  private validateCompletePcbComponents(value: unknown): number {
    if (!isRecord(value)
      || optionalString(value.apiFullName)?.toLowerCase() !== 'eda.pcb_primitivecomponent.getall'
      || !Array.isArray(value.componentPositions)
      || value.componentCount !== value.componentPositions.length
      || value.componentPositions.some(position => !isRecord(position)
        || !optionalString(position.primitiveId)
        || !Number.isFinite(position.x) || !Number.isFinite(position.y)
        || !Number.isFinite(position.rotation))) {
      throw new Error('PCB component position readback did not return a complete component list; writes remain blocked.');
    }
    return value.componentPositions.length;
  }

  private validateCompletePcbComponentState(value: unknown, diagnostic: RecoveryDiagnostic): number {
    if (!isRecord(value) || value.ok !== true || value.action !== 'read'
      || value.scope !== 'current_pcb_page' || value.complete !== true
      || diagnostic.context?.pageKind !== 'pcb' || value.pageUuid !== diagnostic.context.pageUuid
      || !Array.isArray(value.components) || !Number.isSafeInteger(value.componentCount)
      || Number(value.componentCount) < 0 || value.componentCount !== value.components.length) {
      throw new Error('PCB component state readback was incomplete or from another page; writes remain blocked.');
    }
    const ids = new Set<string>();
    const validLibraryRef = (item: unknown): boolean => item === null || (isRecord(item)
      && !!optionalString(item.libraryUuid) && !!optionalString(item.uuid)
      && (item.name === undefined || item.name === null || typeof item.name === 'string'));
    const nullableString = (item: unknown): boolean => item === null || typeof item === 'string';
    const nullableBoolean = (item: unknown): boolean => item === null || typeof item === 'boolean';
    for (const component of value.components) {
      if (!isRecord(component) || !optionalString(component.primitiveId)
        || ids.has(component.primitiveId as string)
        || (component.layer !== 1 && component.layer !== 2)
        || !Number.isFinite(component.x) || !Number.isFinite(component.y)
        || !Number.isFinite(component.rotation) || typeof component.primitiveLock !== 'boolean'
        || !nullableString(component.designator)
        || !validLibraryRef(component.component) || !validLibraryRef(component.footprint)
        || !nullableBoolean(component.addIntoBom) || !nullableString(component.name)
        || !nullableString(component.uniqueId) || !nullableString(component.manufacturer)
        || !nullableString(component.manufacturerId) || !nullableString(component.supplier)
        || !nullableString(component.supplierId) || !isRecord(component.otherProperty)
        || Object.values(component.otherProperty).some(item =>
          typeof item !== 'string' && typeof item !== 'boolean'
            && !(typeof item === 'number' && Number.isFinite(item)))) {
        throw new Error('PCB component state readback was incomplete; writes remain blocked.');
      }
      ids.add(component.primitiveId as string);
    }
    return value.components.length;
  }

  private validateCompletePcbPourState(value: unknown, diagnostic: RecoveryDiagnostic): number {
    if (!isRecord(value) || value.ok !== true || value.action !== 'read'
      || value.scope !== 'current_pcb_page' || value.complete !== true
      || diagnostic.context?.pageKind !== 'pcb' || value.pageUuid !== diagnostic.context.pageUuid
      || !Array.isArray(value.pours) || !Number.isSafeInteger(value.pourCount)
      || Number(value.pourCount) < 0 || value.pourCount !== value.pours.length
      || !Array.isArray(value.poured) || !Number.isSafeInteger(value.pouredCount)
      || Number(value.pouredCount) < 0 || value.pouredCount !== value.poured.length) {
      throw new Error('PCB pour state readback was incomplete or from another page; writes remain blocked.');
    }
    const isCopperLayer = (layer: unknown): boolean => Number.isSafeInteger(layer)
      && (layer === 1 || layer === 2 || (Number(layer) >= 15 && Number(layer) <= 44));
    const isPolygonSource = (source: unknown): boolean => Array.isArray(source) && source.length > 0
      && source.every(item => (typeof item === 'number' && Number.isFinite(item))
        || (typeof item === 'string' && ['L', 'ARC', 'CARC', 'C', 'R', 'CIRCLE'].includes(item)));
    const pourIds = new Set<string>();
    for (const pour of value.pours) {
      if (!isRecord(pour) || !optionalString(pour.primitiveId)
        || pourIds.has(pour.primitiveId as string) || typeof pour.net !== 'string'
        || !isCopperLayer(pour.layer) || !isPolygonSource(pour.polygonSource)
        || !['45grid', '90grid', 'solid'].includes(String(pour.pourFillMethod))
        || typeof pour.preserveSilos !== 'boolean' || typeof pour.pourName !== 'string'
        || !Number.isFinite(pour.pourPriority) || !Number.isFinite(pour.lineWidth)
        || typeof pour.primitiveLock !== 'boolean') {
        throw new Error('PCB pour border readback was incomplete; writes remain blocked.');
      }
      pourIds.add(pour.primitiveId as string);
    }
    const pouredIds = new Set<string>();
    for (const filled of value.poured) {
      if (!isRecord(filled) || !optionalString(filled.primitiveId)
        || pouredIds.has(filled.primitiveId as string)
        || !optionalString(filled.pourPrimitiveId)
        || !Number.isSafeInteger(filled.fillCount) || Number(filled.fillCount) < 0
        || !optionalString(filled.fillGeometryDigest)) {
        throw new Error('PCB poured fill readback was incomplete; writes remain blocked.');
      }
      pouredIds.add(filled.primitiveId as string);
    }
    return value.pours.length + value.poured.length;
  }

  private validateCompletePcbRegionState(value: unknown, diagnostic: RecoveryDiagnostic): number {
    if (!isRecord(value) || value.ok !== true || value.action !== 'read'
      || value.scope !== 'current_pcb_page' || value.complete !== true
      || diagnostic.context?.pageKind !== 'pcb' || value.pageUuid !== diagnostic.context.pageUuid
      || !Array.isArray(value.regions) || !Number.isSafeInteger(value.regionCount)
      || Number(value.regionCount) < 0 || value.regionCount !== value.regions.length) {
      throw new Error('PCB region state readback was incomplete or from another page; writes remain blocked.');
    }
    const validSinglePolygon = (source: unknown): boolean => Array.isArray(source) && source.length > 0
      && source.every(item => (typeof item === 'number' && Number.isFinite(item))
        || (typeof item === 'string' && ['L', 'ARC', 'CARC', 'C', 'R', 'CIRCLE'].includes(item)));
    const validPolygon = (source: unknown): boolean => validSinglePolygon(source)
      || (Array.isArray(source) && source.length > 0 && source.every(validSinglePolygon));
    const ids = new Set<string>();
    for (const region of value.regions) {
      if (!isRecord(region) || !optionalString(region.primitiveId)
        || ids.has(region.primitiveId as string)
        || !Number.isSafeInteger(region.layer)
        || (![1, 2, 12].includes(Number(region.layer)) && !(Number(region.layer) >= 15 && Number(region.layer) <= 44))
        || !validPolygon(region.polygonSource)
        || !Array.isArray(region.ruleType) || region.ruleType.some(item => ![2, 5, 6, 7, 8, 9].includes(item))
        || (region.regionName !== null && typeof region.regionName !== 'string')
        || !Number.isFinite(region.lineWidth) || typeof region.primitiveLock !== 'boolean') {
        throw new Error('PCB region readback was incomplete; writes remain blocked.');
      }
      ids.add(region.primitiveId as string);
    }
    return value.regions.length;
  }

  private validateCompletePcbTextState(value: unknown, diagnostic: RecoveryDiagnostic): number {
    if (!isRecord(value) || value.ok !== true || value.action !== 'read'
      || value.scope !== 'current_pcb_page' || value.complete !== true
      || diagnostic.context?.pageKind !== 'pcb' || value.pageUuid !== diagnostic.context.pageUuid
      || !Array.isArray(value.strings) || !Number.isSafeInteger(value.stringCount)
      || value.stringCount !== value.strings.length
      || !Array.isArray(value.attributes) || !Number.isSafeInteger(value.attributeCount)
      || value.attributeCount !== value.attributes.length) {
      throw new Error('PCB text state readback was incomplete or from another page; writes remain blocked.');
    }
    const isImageLayer = (layer: unknown): boolean => Number.isSafeInteger(layer)
      && ([1, 2, 3, 4, 5, 6, 9, 10, 13, 14, 56].includes(Number(layer))
        || (Number(layer) >= 15 && Number(layer) <= 44)
        || (Number(layer) >= 71 && Number(layer) <= 100));
    const ids = new Set<string>();
    const validCommon = (item: Record<string, unknown>, attribute: boolean): boolean =>
      !!optionalString(item.primitiveId) && isImageLayer(item.layer)
      && ((attribute && item.x === null) || Number.isFinite(item.x))
      && ((attribute && item.y === null) || Number.isFinite(item.y))
      && typeof item.fontFamily === 'string' && Number.isFinite(item.fontSize)
      && Number.isFinite(item.lineWidth) && Number.isSafeInteger(item.alignMode)
      && Number(item.alignMode) >= 1 && Number(item.alignMode) <= 9
      && Number.isFinite(item.rotation) && typeof item.reverse === 'boolean'
      && Number.isFinite(item.expansion) && typeof item.mirror === 'boolean'
      && typeof item.primitiveLock === 'boolean';
    for (const item of value.strings) {
      if (!isRecord(item) || !validCommon(item, false) || typeof item.text !== 'string'
        || ids.has(item.primitiveId as string)) {
        throw new Error('PCB string readback was incomplete; writes remain blocked.');
      }
      ids.add(item.primitiveId as string);
    }
    for (const item of value.attributes) {
      if (!isRecord(item) || !validCommon(item, true)
        || !optionalString(item.parentPrimitiveId) || typeof item.key !== 'string'
        || typeof item.value !== 'string' || typeof item.keyVisible !== 'boolean'
        || typeof item.valueVisible !== 'boolean' || ids.has(item.primitiveId as string)) {
        throw new Error('PCB attribute readback was incomplete; writes remain blocked.');
      }
      ids.add(item.primitiveId as string);
    }
    return value.strings.length + value.attributes.length;
  }

  private validateCompletePcbDocuments(value: unknown, diagnostic: RecoveryDiagnostic): number {
    if (!isRecord(value) || value.ok !== true || value.operation !== 'list' || value.complete !== true
      || value.projectUuid !== diagnostic.targetProjectUuid || !Array.isArray(value.pcbs)
      || !Number.isSafeInteger(value.pcbCount) || value.pcbCount !== value.pcbs.length) {
      throw new Error('PCB document inventory readback was incomplete or from another project; writes remain blocked.');
    }
    const uuids = new Set<string>();
    for (const pcb of value.pcbs) {
      if (!isRecord(pcb) || !optionalString(pcb.uuid) || !optionalString(pcb.name)
        || pcb.parentProjectUuid !== diagnostic.targetProjectUuid || uuids.has(pcb.uuid as string)) {
        throw new Error('PCB document inventory readback was incomplete; writes remain blocked.');
      }
      uuids.add(pcb.uuid as string);
    }
    if (diagnostic.targetPcbUuid && !uuids.has(diagnostic.targetPcbUuid))
      throw new Error('Target PCB is absent from the document inventory; writes remain blocked.');
    return value.pcbs.length;
  }

  private validateCompleteBoardDocuments(value: unknown, diagnostic: RecoveryDiagnostic): number {
    if (!isRecord(value) || value.ok !== true || !isRecord(value.project)
      || value.project.uuid !== diagnostic.targetProjectUuid) {
      throw new Error('Board setup readback is not from the target project; writes remain blocked.');
    }
    const inventory = (raw: unknown, kind: 'Board' | 'schematic' | 'PCB'): Record<string, unknown>[] => {
      if (!isRecord(raw) || raw.truncated !== false || !Array.isArray(raw.items)
        || !Number.isSafeInteger(raw.total) || raw.total !== raw.items.length
        || raw.returned !== raw.items.length) {
        throw new Error(`${kind} inventory readback is incomplete; writes remain blocked.`);
      }
      const names = new Set<string>();
      for (const item of raw.items) {
        if (!isRecord(item) || !optionalString(item.name)
          || item.parentProjectUuid !== diagnostic.targetProjectUuid
          || (kind !== 'Board' && !optionalString(item.uuid))) {
          throw new Error(`${kind} inventory readback is invalid; writes remain blocked.`);
        }
        const identity = kind === 'Board' ? item.name as string : item.uuid as string;
        if (names.has(identity))
          throw new Error(`${kind} inventory contains duplicate identities; writes remain blocked.`);
        names.add(identity);
      }
      return raw.items;
    };
    const boards = inventory(value.boards, 'Board');
    inventory(value.schematics, 'schematic');
    inventory(value.pcbs, 'PCB');
    return boards.length;
  }

  private validateCompletePcbLayerState(value: unknown, diagnostic: RecoveryDiagnostic): number {
    if (!isRecord(value) || value.ok !== true || value.action !== 'read'
      || value.scope !== 'current_pcb_page' || value.complete !== true
      || diagnostic.context?.pageKind !== 'pcb' || value.pageUuid !== diagnostic.context.pageUuid
      || !Number.isInteger(value.copperLayerCount) || Number(value.copperLayerCount) < 2
      || Number(value.copperLayerCount) > 32 || Number(value.copperLayerCount) % 2 !== 0
      || !Array.isArray(value.layers) || !Number.isSafeInteger(value.layerCount)
      || value.layerCount !== value.layers.length || value.layers.length === 0
      || value.layers.some(layer => !isRecord(layer) || !Number.isInteger(layer.id) || typeof layer.type !== 'string'
        || ![0, 1, 2].includes(layer.layerStatus as number))
      || new Set(value.layers.map(layer => layer.id)).size !== value.layers.length
      || value.layers.filter(layer => (layer.type === 'SIGNAL' || layer.type === 'PLANE')
        && (layer.layerStatus === 1 || layer.layerStatus === 2)).length !== value.copperLayerCount) {
      throw new Error('PCB copper-layer state readback was incomplete or from another page; writes remain blocked.');
    }
    return Number(value.copperLayerCount);
  }

  private assertSchematicIdentity(value: unknown, documentUuid: string | undefined, projectUuid: string | undefined, pageUuid: string): void {
    const identity = extractReadbackIdentity(value, 'schematic');
    if ((documentUuid && identity.documentUuid !== documentUuid)
      || (projectUuid && identity.projectUuid !== projectUuid)
      || identity.pageUuid !== pageUuid) {
      throw new Error('Schematic document or page identity changed during component readback; writes remain blocked.');
    }
  }

  private validateCompleteSchematicComponentIds(value: unknown): string[] {
    const validOtherPropertyJson = (raw: unknown): boolean => {
      if (typeof raw !== 'string') return false;
      try {
        const properties: unknown = JSON.parse(raw);
        return isRecord(properties) && Object.values(properties).every(item =>
          typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item)));
      } catch {
        return false;
      }
    };
    if (!isRecord(value)
      || optionalString(value.apiFullName)?.toLowerCase() !== 'eda.sch_primitivecomponent.getallprimitiveid'
      || !Array.isArray(value.schematicComponentIds)
      || !Array.isArray(value.schematicComponentStates)
      || value.schematicComponentCount !== value.schematicComponentIds.length
      || value.schematicComponentStates.length !== value.schematicComponentIds.length
      || value.schematicComponentIds.some(id => typeof id !== 'string' || !id.trim())
      || new Set(value.schematicComponentIds).size !== value.schematicComponentIds.length
      || value.schematicComponentStates.some(state => !isRecord(state)
        || !optionalString(state.primitiveId) || typeof state.designator !== 'string'
        || !validOtherPropertyJson(state.otherPropertyJson))
      || new Set(value.schematicComponentStates.map(state => state.primitiveId)).size !== value.schematicComponentIds.length
      || value.schematicComponentStates.some(state => !(value.schematicComponentIds as string[]).includes(state.primitiveId))) {
      throw new Error('Schematic component state readback was incomplete; writes remain blocked.');
    }
    return value.schematicComponentIds as string[];
  }

  private validateCompleteSchematicComponentState(value: unknown, diagnostic: RecoveryDiagnostic): number {
    if (!isRecord(value) || value.ok !== true || value.action !== 'read'
      || value.scope !== 'current_schematic_page' || value.complete !== true
      || diagnostic.context?.pageKind !== 'schematic' || value.pageUuid !== diagnostic.context.pageUuid
      || !Array.isArray(value.components) || !Number.isSafeInteger(value.componentCount)
      || value.componentCount !== value.components.length) {
      throw new Error('Schematic component state readback was incomplete or from another page; writes remain blocked.');
    }
    const ids = new Set<string>();
    const nullableString = (item: unknown): boolean => item === null || typeof item === 'string';
    const nullableBoolean = (item: unknown): boolean => item === null || typeof item === 'boolean';
    for (const component of value.components) {
      if (!isRecord(component) || !optionalString(component.primitiveId)
        || ids.has(component.primitiveId as string) || component.type !== 'part'
        || !Number.isFinite(component.x) || !Number.isFinite(component.y)
        || !Number.isFinite(component.rotation) || typeof component.mirror !== 'boolean'
        || !nullableString(component.designator) || !nullableString(component.name)
        || !nullableString(component.uniqueId)
        || !nullableBoolean(component.addIntoBom) || !nullableBoolean(component.addIntoPcb)
        || !nullableString(component.manufacturer) || !nullableString(component.manufacturerId)
        || !nullableString(component.supplier) || !nullableString(component.supplierId)
        || !isRecord(component.otherProperty)
        || Object.values(component.otherProperty).some(item =>
          typeof item !== 'string' && typeof item !== 'boolean'
            && !(typeof item === 'number' && Number.isFinite(item)))) {
        throw new Error('Schematic component state readback was incomplete; writes remain blocked.');
      }
      ids.add(component.primitiveId as string);
    }
    return value.components.length;
  }

  private validateCompleteSchematicTextState(value: unknown, diagnostic: RecoveryDiagnostic): number {
    if (!isRecord(value) || value.ok !== true || value.action !== 'read'
      || value.scope !== 'current_schematic_page' || value.complete !== true
      || diagnostic.context?.pageKind !== 'schematic' || value.pageUuid !== diagnostic.context.pageUuid
      || !Array.isArray(value.texts) || !Number.isSafeInteger(value.textCount)
      || value.textCount !== value.texts.length) {
      throw new Error('Schematic text state readback was incomplete or from another page; writes remain blocked.');
    }
    const ids = new Set<string>();
    for (const item of value.texts) {
      if (!isRecord(item) || !optionalString(item.primitiveId) || ids.has(item.primitiveId as string)
        || !Number.isFinite(item.x) || !Number.isFinite(item.y) || typeof item.content !== 'string'
        || !Number.isFinite(item.rotation) || !Number.isInteger(item.alignMode)
        || (item.textColor !== null && typeof item.textColor !== 'string')
        || (item.fontName !== null && typeof item.fontName !== 'string')
        || (item.fontSize !== null && !Number.isFinite(item.fontSize))
        || typeof item.bold !== 'boolean' || typeof item.italic !== 'boolean'
        || typeof item.underLine !== 'boolean') {
        throw new Error('Schematic text state readback was incomplete; writes remain blocked.');
      }
      ids.add(item.primitiveId as string);
    }
    return value.texts.length;
  }

  private validatePcbRoutingPrimitives(value: unknown, apiFullName: string): Record<string, unknown>[] {
    const number = (item: unknown): boolean => typeof item === 'number' && Number.isFinite(item);
    const kind = apiFullName.toLowerCase();
    const validPrimitive = (primitive: unknown): boolean => {
      if (!isRecord(primitive) || !optionalString(primitive.primitiveId)
        || (typeof primitive.net !== 'string' && primitive.net !== null)
        || typeof primitive.primitiveLock !== 'boolean')
        return false;
      if (kind.includes('primitivevia'))
        return number(primitive.x) && number(primitive.y) && number(primitive.holeDiameter) && number(primitive.diameter)
          && (typeof primitive.viaType === 'string' || number(primitive.viaType));
      if (!(typeof primitive.layer === 'string' || number(primitive.layer)) || !number(primitive.lineWidth))
        return false;
      if (kind.includes('primitivepolyline')) {
        if (typeof primitive.polygonSource !== 'string') return false;
        try {
          const source: unknown = JSON.parse(primitive.polygonSource);
          return Array.isArray(source) && source.length > 0 && source.every(part => typeof part === 'string' || number(part));
        } catch {
          return false;
        }
      }
      return number(primitive.startX) && number(primitive.startY) && number(primitive.endX) && number(primitive.endY)
        && (!kind.includes('primitivearc') || (number(primitive.arcAngle)
          && (primitive.interactiveMode === 1 || primitive.interactiveMode === 2)));
    };
    if (!isRecord(value)
      || optionalString(value.apiFullName)?.toLowerCase() !== apiFullName.toLowerCase()
      || !Array.isArray(value.routingPrimitives)
      || value.routingPrimitiveCount !== value.routingPrimitives.length
      || value.routingPrimitives.some(primitive => !validPrimitive(primitive))) {
      throw new Error(`PCB routing readback for ${apiFullName} was incomplete; writes remain blocked.`);
    }
    return value.routingPrimitives as Record<string, unknown>[];
  }

  private async readCompletePcbRoutingState(firstReadback: unknown, clientId: string, timeoutMs: number): Promise<Record<string, unknown>> {
    const primitives: Record<string, Record<string, unknown>[]> = {
      line: this.validatePcbRoutingPrimitives(firstReadback, PCB_ROUTING_READBACK_APIS[0]),
    };
    for (const [index, kind] of ['arc', 'polyline', 'via'].entries()) {
      const apiFullName = PCB_ROUTING_READBACK_APIS[index + 1];
      const value = await this.dispatchToEda('/bridge/jlceda/api/invoke', { apiFullName, args: [], includeCompleteRouting: true }, Math.min(timeoutMs, RECOVERY_READBACK_TIMEOUT_MS), undefined, true, clientId);
      primitives[kind] = this.validatePcbRoutingPrimitives(value, apiFullName);
    }

    let total: number | undefined;
    let offset = 0;
    const nets: Array<{ net: string; length: number }> = [];
    do {
      const value = await this.dispatchToEda('/bridge/jlceda/net/query-pcb', { mode: 'all', limit: 1000, offset }, Math.min(timeoutMs, RECOVERY_READBACK_TIMEOUT_MS), undefined, true, clientId);
      if (!isRecord(value) || value.ok !== true || value.mode !== 'all'
        || !Number.isSafeInteger(value.total) || Number(value.total) < 0
        || value.offset !== offset || !Array.isArray(value.nets)
        || value.returned !== value.nets.length || (total !== undefined && value.total !== total)
        || value.nets.some(net => !isRecord(net) || typeof net.net !== 'string' || !Number.isFinite(net.length))) {
        throw new Error('PCB routing net readback was incomplete; writes remain blocked.');
      }
      total = Number(value.total);
      nets.push(...value.nets.map(net => ({ net: (net as Record<string, unknown>).net as string, length: (net as Record<string, unknown>).length as number })));
      offset += value.nets.length;
      if (offset > total || value.truncated !== (offset < total) || (offset < total && value.nets.length === 0))
        throw new Error('PCB routing net readback was incomplete; writes remain blocked.');
    } while (offset < total);
    return { primitives, nets, netCount: total };
  }

  private validateCompleteSchematicPages(value: unknown, diagnostic: RecoveryDiagnostic): number {
    if (!isRecord(value)
      || optionalString(value.apiFullName)?.toLowerCase() !== 'eda.dmt_schematic.getallschematicpagesinfo'
      || !Array.isArray(value.schematicPages)
      || !Number.isSafeInteger(value.pageCount)
      || value.pageCount !== value.schematicPages.length) {
      throw new Error('Schematic page inventory readback was incomplete; writes remain blocked.');
    }
    const pages = value.schematicPages as unknown[];
    const uuids = new Set<string>();
    for (const page of pages) {
      if (!isRecord(page) || !optionalString(page.uuid) || !optionalString(page.parentSchematicUuid)
        || uuids.has(page.uuid as string)) {
        throw new Error('Schematic page inventory readback was incomplete; writes remain blocked.');
      }
      uuids.add(page.uuid as string);
    }
    if (diagnostic.targetSchematicUuid && !diagnostic.targetSchematicMayBeEmpty
      && !pages.some(page => isRecord(page) && page.parentSchematicUuid === diagnostic.targetSchematicUuid)) {
      throw new Error('Target schematic is absent from the page inventory; writes remain blocked.');
    }
    if (diagnostic.targetSchematicPageUuid && !diagnostic.targetPageMayBeAbsent
      && !uuids.has(diagnostic.targetSchematicPageUuid)) {
      throw new Error('Target schematic page is absent from the page inventory; writes remain blocked.');
    }
    if (diagnostic.sourceSchematicPageUuid && !uuids.has(diagnostic.sourceSchematicPageUuid)) {
      throw new Error('Source schematic page is absent from the page inventory; writes remain blocked.');
    }
    return pages.length;
  }

  private validateCompleteSchematicConnectivity(value: unknown, diagnostic: RecoveryDiagnostic): void {
    let primitives: unknown;
    let semantic: unknown;
    try {
      if (!isRecord(value) || value.ok !== true
        || typeof value.connectivityPrimitivesSnapshot !== 'string'
        || typeof value.schematicCircuitSnapshot !== 'string')
        throw new Error('missing readback');
      primitives = JSON.parse(value.connectivityPrimitivesSnapshot);
      semantic = JSON.parse(value.schematicCircuitSnapshot);
    } catch {
      throw new Error('Schematic connectivity readback was incomplete; writes remain blocked.');
    }
    if (!isRecord(primitives) || primitives.scope !== 'current_schematic_page' || primitives.complete !== true
      || primitives.pageUuid !== diagnostic.context?.pageUuid
      || diagnostic.context?.pageKind !== 'schematic'
      || !Array.isArray(primitives.wires) || !Array.isArray(primitives.netPorts)
      || !Array.isArray(primitives.netFlags) || !Array.isArray(primitives.netLabels)
      || !Number.isSafeInteger(primitives.wireCount) || primitives.wireCount !== primitives.wires.length
      || !Number.isSafeInteger(primitives.netPortCount) || primitives.netPortCount !== primitives.netPorts.length
      || !Number.isSafeInteger(primitives.netFlagCount) || primitives.netFlagCount !== primitives.netFlags.length
      || !Number.isSafeInteger(primitives.netLabelCount) || primitives.netLabelCount !== primitives.netLabels.length
      || !isRecord(semantic) || !Array.isArray(semantic.components) || !Array.isArray(semantic.networks)
      || semantic.componentCount !== semantic.components.length || semantic.networkCount !== semantic.networks.length) {
      throw new Error('Schematic connectivity readback was incomplete or from another page; writes remain blocked.');
    }
    if (diagnostic.targetSchematicPinPrimitiveId) {
      const owner = semantic.components.find(component => isRecord(component) && Array.isArray(component.pins)
        && component.pins.some(pin => isRecord(pin) && pin.pinId === diagnostic.targetSchematicPinPrimitiveId));
      if (!isRecord(owner) || !Array.isArray(owner.pins) || !optionalString(owner.componentInstanceId))
        throw new Error('Schematic target pin was absent from recovery readback; writes remain blocked.');
      const pinIds = new Set<string>();
      for (const pin of owner.pins) {
        if (!isRecord(pin) || !optionalString(pin.pinId) || pinIds.has(pin.pinId as string)
          || typeof pin.pinNumber !== 'string' || !Number.isFinite(pin.x) || !Number.isFinite(pin.y)
          || !Number.isFinite(pin.rotation) || typeof pin.noConnected !== 'boolean'
          || pin.hasNoConnectMark !== pin.noConnected)
          throw new Error('Schematic component pin state was incomplete in recovery readback; writes remain blocked.');
        pinIds.add(pin.pinId as string);
      }
    }
    const ids = new Set<string>();
    for (const wire of primitives.wires) {
      if (!isRecord(wire) || !optionalString(wire.primitiveId) || ids.has(wire.primitiveId as string)
        || typeof wire.net !== 'string' || !validWireLine(wire.line))
        throw new Error('Schematic wire readback was incomplete; writes remain blocked.');
      ids.add(wire.primitiveId as string);
    }
    for (const port of primitives.netPorts) {
      if (!isRecord(port) || !optionalString(port.primitiveId) || ids.has(port.primitiveId as string)
        || !optionalString(port.net) || !Number.isFinite(port.x) || !Number.isFinite(port.y))
        throw new Error('Schematic NetPort readback was incomplete; writes remain blocked.');
      ids.add(port.primitiveId as string);
    }
    for (const flag of primitives.netFlags) {
      if (!isRecord(flag) || !optionalString(flag.primitiveId) || ids.has(flag.primitiveId as string)
        || !optionalString(flag.net) || !Number.isFinite(flag.x) || !Number.isFinite(flag.y))
        throw new Error('Schematic NetFlag readback was incomplete; writes remain blocked.');
      ids.add(flag.primitiveId as string);
    }
    for (const label of primitives.netLabels) {
      if (!isRecord(label) || !optionalString(label.primitiveId) || ids.has(label.primitiveId as string)
        || typeof label.parentWireId !== 'string' || typeof label.net !== 'string'
        || (label.x !== null && !Number.isFinite(label.x))
        || (label.y !== null && !Number.isFinite(label.y)))
        throw new Error('Schematic NET attribute readback was incomplete; writes remain blocked.');
      ids.add(label.primitiveId as string);
    }
  }

  private async readCompletePcbNets(clientId: string, timeoutMs: number): Promise<number> {
    let total: number | undefined;
    let offset = 0;
    const names = new Set<string>();
    do {
      const value = await this.dispatchToEda('/bridge/jlceda/net/query-pcb', { mode: 'names', limit: 1000, offset }, Math.min(timeoutMs, RECOVERY_READBACK_TIMEOUT_MS), undefined, true, clientId);
      if (!isRecord(value) || value.ok !== true || value.mode !== 'names'
        || !Number.isSafeInteger(value.total) || Number(value.total) < 0
        || value.offset !== offset || !Array.isArray(value.names)
        || value.returned !== value.names.length || (total !== undefined && value.total !== total)
        || value.names.some(name => typeof name !== 'string' || names.has(name))) {
        throw new Error('PCB import net readback was incomplete; writes remain blocked.');
      }
      total = Number(value.total);
      for (const name of value.names) names.add(name as string);
      offset += value.names.length;
      if (offset > total || value.truncated !== (offset < total) || (offset < total && value.names.length === 0))
        throw new Error('PCB import net readback was incomplete; writes remain blocked.');
    } while (offset < total);
    return total;
  }

  private async resolvePendingPcbImport(payload: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    const requestId = optionalString(payload.requestId);
    const resolution = payload.resolution;
    if (!requestId || (resolution !== 'applied' && resolution !== 'cancelled'))
      throw new Error('resolve_import requires requestId and resolution=applied or cancelled after the native EDA dialog was closed.');
    const diagnostic = this.recoveryDiagnostics.get(requestId);
    if (!diagnostic?.pendingNativeConfirmation)
      throw new Error(`No pending PCB import confirmation exists for requestId: ${requestId}`);
    if (diagnostic.importContextConflict)
      throw new Error('PCB import identity disagrees with its execution context; writes remain blocked.');
    if (this.recoverySession || this.resolvingImports.has(requestId))
      throw new Error('A Bridge recovery or PCB import resolution is already in progress.');
    const peer = this.peers.get(diagnostic.clientId);
    if (!peer || !this.isPeerReady(peer) || peer.socket !== this.pendingImportSockets.get(requestId)
      || this.activeClientId !== peer.clientId)
      throw new Error('The original active Bridge connection is unavailable; restart the EDA host and use controlled recovery.');
    const expectedPageUuid = diagnostic.context?.pageUuid;
    const expectedDocumentUuid = diagnostic.context?.documentUuid;
    const expectedProjectUuid = diagnostic.context?.projectUuid;
    if (diagnostic.context?.pageKind !== 'pcb' || !expectedPageUuid || (!expectedDocumentUuid && !expectedProjectUuid))
      throw new Error('The original PCB identity is incomplete; restart the EDA host and use controlled recovery.');
    this.resolvingImports.add(requestId);
    try {
      const read = (path: string, body: Record<string, unknown>) => this.dispatchToEda(path, body, Math.min(timeoutMs, RECOVERY_READBACK_TIMEOUT_MS), undefined, true, peer.clientId);
      const firstContext = await read('/bridge/jlceda/context', {});
      this.assertPcbIdentity(firstContext, expectedDocumentUuid, expectedProjectUuid, expectedPageUuid);
      const components = await read('/bridge/jlceda/api/invoke', { apiFullName: 'eda.pcb_PrimitiveComponent.getAll', args: [], includeCompletePositions: true });
      const componentCount = this.validateCompletePcbComponents(components);
      const netCount = await this.readCompletePcbNets(peer.clientId, timeoutMs);
      const finalContext = await read('/bridge/jlceda/context', {});
      this.assertPcbIdentity(finalContext, expectedDocumentUuid, expectedProjectUuid, expectedPageUuid);
      if (this.peers.get(peer.clientId)?.socket !== peer.socket || this.recoveryDiagnostics.get(requestId) !== diagnostic || this.recoverySession)
        throw new Error('Bridge connection or recovery state changed during import readback; writes remain blocked.');
      const acknowledgement = await read('/bridge/jlceda/pcb/import-resolve', { confirm: true, requestId, resolution, expectedPageUuid });
      if (!isRecord(acknowledgement) || acknowledgement.ok !== true || acknowledgement.pageUuid !== expectedPageUuid)
        throw new Error('Bridge did not acknowledge PCB import resolution; writes remain blocked.');
      this.recoveryDiagnostics.delete(requestId);
      this.pendingImportSockets.delete(requestId);
      return {
        ok: true,
        action: 'resolve_import',
        resolution,
        readbackVerified: true,
        componentCount,
        netCount,
        identityReadback: finalContext,
        writesRemainBlocked: hasMutatingRecoveryDiagnostics(this.recoveryDiagnostics.values()),
      };
    } finally {
      this.resolvingImports.delete(requestId);
    }
  }

  private async dispatchToEda(path: string, payload: unknown, timeoutMs: number, mcpSocket?: WebSocket, recoveryReadback = false, targetClientId?: string, internalRequestId?: string): Promise<unknown> {
    this.pruneRecoveryDiagnostics();
    const routedClientId = targetClientId ?? this.activeClientId;
    const peer = this.peers.get(routedClientId);
    if (!peer || !this.isPeerReady(peer)) {
      throw new Error('No ready EDA client connected');
    }
    if (!recoveryReadback && !isReadOnlyRequest(path, payload) && (this.recoverySession || hasMutatingRecoveryDiagnostics(this.recoveryDiagnostics.values()))) {
      const recoveryId = this.recoverySession?.recoveryId ?? 'pending-timeout-diagnostics';
      throw new Error(`EDA writes are blocked pending recovery readback for ${recoveryId}.`);
    }
    const reconnectBarrier = this.getReconnectBarrier(peer.clientId);
    if (reconnectBarrier) {
      const remainingMs = Math.max(1, reconnectBarrier.until - Date.now());
      throw new Error(`EDA client is quarantined after reconnect while ${reconnectBarrier.path} may still be settling; retry in ${String(remainingMs)}ms`);
    }
    if (this.pendingRequests.size >= BRIDGE_MAX_PENDING_REQUESTS) {
      throw new Error(`Bridge request queue is full (maximum ${String(BRIDGE_MAX_PENDING_REQUESTS)} pending requests)`);
    }
    const requestId = this.createRequestId();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Request queue timeout after ${String(BRIDGE_QUEUE_TIMEOUT_MS)}ms`));
      }, BRIDGE_QUEUE_TIMEOUT_MS);
      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        timeout,
        executionTimeoutMs: timeoutMs,
        started: false,
        clientId: peer.clientId,
        context: isReadOnlyRequest(path, payload) ? peer.context : undefined,
        leaseTerm: this.leaseTerm,
        mcpSocket,
        internalRequestId,
        edaSocket: peer.socket,
        path,
        payload,
      });
      try {
        sendBridgeJson(peer.socket, {
          type: 'bridge/task',
          requestId,
          path,
          payload,
          createdAt: Date.now(),
          leaseTerm: this.leaseTerm,
        });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRequests.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private pruneRecoveryDiagnostics(): void {
    const cutoff = Date.now() - RECOVERY_DIAGNOSTIC_TTL_MS;
    for (const [requestId, diagnostic] of this.recoveryDiagnostics) {
      if (!diagnostic.mutating && diagnostic.timedOutAtMs < cutoff && this.recoverySession?.diagnostic.requestId !== requestId) {
        this.recoveryDiagnostics.delete(requestId);
      }
    }
  }

  private async dispatchViaInternalClient(path: string, payload: unknown, timeoutMs: number): Promise<unknown> {
    const socket = this.internalClient;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected to main server');
    }
    if (this.pendingRequests.size >= BRIDGE_MAX_PENDING_REQUESTS) {
      throw new Error(`Bridge request queue is full (maximum ${String(BRIDGE_MAX_PENDING_REQUESTS)} pending requests)`);
    }
    const requestId = this.createRequestId();
    return new Promise((resolve, reject) => {
      // The main server owns the Bridge queue. Do not apply the caller's
      // execution timeout until it acknowledges that the task actually began.
      const effectiveTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
        ? Math.min(Math.floor(timeoutMs), BRIDGE_QUEUE_TIMEOUT_MS)
        : 30_000;
      const queueTimeoutMs = BRIDGE_QUEUE_TIMEOUT_MS + INTERNAL_QUEUE_RESPONSE_GRACE_MS;
      const timeout = setTimeout(() => {
        const pending = this.pendingRequests.get(requestId);
        if (!pending) {
          return;
        }
        this.pendingRequests.delete(requestId);
        this.clearPendingTimeout(pending);
        reject(new Error(`Internal bridge request queue timeout after ${String(queueTimeoutMs)}ms awaiting task-started acknowledgement`));
      }, queueTimeoutMs);
      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        timeout,
        path,
        payload,
        executionTimeoutMs: effectiveTimeoutMs,
      });
      try {
        const request: BridgeTask = { type: 'bridge/task', requestId, path, payload, timeoutMs: effectiveTimeoutMs };
        sendBridgeJson(socket, request);
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRequests.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private createRequestId(): string {
    this.requestIdCounter += 1;
    return `req_${this.instanceId}_${this.requestIdCounter}_${Date.now()}`;
  }

  private trySend(socket: WebSocket, message: unknown): boolean {
    try {
      sendBridgeJson(socket, message);
      return true;
    } catch (error) {
      process.stderr.write(`WebSocket send failed: ${String(error)}\n`);
      return false;
    }
  }

  private markInternalPendingRequestStarted(pending: PendingRequest, requestId: string): void {
    if (pending.started) {
      return;
    }
    pending.started = true;
    pending.startedAt = Date.now();
    this.clearPendingTimeout(pending);
    const executionTimeoutMs = pending.executionTimeoutMs ?? 30_000;
    pending.timeout = setTimeout(() => {
      if (this.pendingRequests.get(requestId) !== pending) {
        return;
      }
      this.pendingRequests.delete(requestId);
      pending.reject(new Error(`Internal bridge request execution timeout after ${String(executionTimeoutMs)}ms`));
    }, executionTimeoutMs);
  }

  private rejectPendingForClient(clientId: string, reason: string): void {
    // Capture the timeout window before removing requests. EDA APIs are not
    // cancellable, so a rejected request may still be mutating the document.
    this.enterReconnectBarrier(clientId);
    for (const [requestId, pending] of this.pendingRequests) {
      if (pending.clientId !== clientId) {
        continue;
      }
      if (pending.started && !isReadOnlyRequest(pending.path ?? '', pending.payload))
        this.recordTimedOutRequest(requestId, pending, pending.executionTimeoutMs ?? 30000, reason);
      this.clearPendingTimeout(pending);
      this.pendingRequests.delete(requestId);
      pending.reject(new Error(reason));
    }
  }

  private enterReconnectBarrier(clientId: string): void {
    const pending = [...this.pendingRequests.values()]
      .filter(request => request.clientId === clientId && request.path?.startsWith('/bridge/jlceda/'));
    if (pending.length === 0) {
      return;
    }
    const longestTimeout = Math.max(...pending.map(request => request.executionTimeoutMs ?? 30000));
    const path = pending[0].path ?? '/bridge/jlceda/unknown';
    const existing = this.reconnectBarriers.get(clientId);
    const until = Date.now() + longestTimeout;
    this.reconnectBarriers.set(clientId, {
      path: existing && existing.until > until ? existing.path : path,
      until: Math.max(existing?.until ?? 0, until),
    });
  }

  private getReconnectBarrier(clientId: string): { path: string; until: number } | undefined {
    const barrier = this.reconnectBarriers.get(clientId);
    if (!barrier) {
      return undefined;
    }
    if (barrier.until <= Date.now()) {
      this.reconnectBarriers.delete(clientId);
      return undefined;
    }
    return barrier;
  }

  private rejectPendingForMcpSocket(socket: WebSocket, reason: string): void {
    for (const [requestId, pending] of this.pendingRequests) {
      if (pending.mcpSocket !== socket) {
        continue;
      }
      if (pending.clientId) {
        // The MCP caller may disappear while the EDA mutation continues. Add
        // the tombstone before deleting the pending request.
        this.enterReconnectBarrier(pending.clientId);
      }
      if (pending.started && !isReadOnlyRequest(pending.path ?? '', pending.payload))
        this.recordTimedOutRequest(requestId, pending, pending.executionTimeoutMs ?? 30000, reason);
      this.clearPendingTimeout(pending);
      this.pendingRequests.delete(requestId);
      pending.reject(new Error(reason));
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [requestId, pending] of this.pendingRequests) {
      this.clearPendingTimeout(pending);
      this.pendingRequests.delete(requestId);
      pending.reject(new Error(reason));
    }
  }

  public close(): void {
    this.closing = true;
    if (this.peerSweepTimer) {
      clearInterval(this.peerSweepTimer);
      this.peerSweepTimer = null;
    }
    this.rejectAllPending('Bridge server closed');
    for (const peer of this.peers.values())
      this.rejectSelectionProbesForSocket(peer.socket, 'Bridge server closed');
    this.internalClient?.close();
    this.internalClient = null;
    for (const peer of this.peers.values()) {
      peer.socket.close(1001, 'Bridge server closed');
    }
    for (const client of this.mcpClients) {
      client.close(1001, 'Bridge server closed');
    }
    this.peers.clear();
    this.reconnectBarriers.clear();
    this.clientIdBySocket.clear();
    this.mcpClients.clear();
    this.wss?.close();
    this.wss = null;
    this.started = false;
    this.isMainServer = false;
    this.promoting = false;
  }

  public hasClients(): boolean {
    if (this.isMainServer) {
      return this.peers.size > 0;
    }
    return this.internalClient?.readyState === WebSocket.OPEN;
  }

  public getMode(): 'main' | 'client' | 'not-started' {
    if (!this.started) {
      return 'not-started';
    }
    return this.isMainServer ? 'main' : 'client';
  }
}
