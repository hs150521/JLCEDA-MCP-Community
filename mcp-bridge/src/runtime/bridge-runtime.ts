/**
 * ------------------------------------------------------------------------
 * 名称：桥接运行时管理器
 * 说明：维护连接生命周期、角色状态同步和桥接任务执行。
 * 作者：Lion
 * 邮箱：chengbin@3578.cn
 * 日期：2026-03-12
 * 备注：按服务端裁决，仅在活动角色执行桥接任务。
 * ------------------------------------------------------------------------
 */

import type { BridgeClientContext, BridgeDebugSwitch, BridgeRole, BridgeServerRoleMessage } from '../bridge/protocol.ts';
import type { UnifiedLogEntry } from '../logging/log.ts';
import extensionConfig from '../../extension.json';
import { footprintApiAccess, isReadOnlyBridgeRequest, operationForBridgePath } from '../bridge/bridge-contract.ts';
import { getConfiguredMcpUrl, getMcpServerUrlChangedTopic } from '../bridge/config.ts';
import { editorDocumentPageKind, footprintIdentityFromDocument, readCurrentEditorDocument } from '../bridge/editor-context.ts';
import { BridgeLogDispatchPipeline } from '../logging/log-dispatch.ts';
import { bridgeLogPipeline } from '../logging/log.ts';
import {
	cleanupAllComponentPlaceSessions,
} from '../mcp/component-place-handler.ts';
import { BridgeStateManager } from '../state/state-manager.ts';
import { BridgeStatusReporter } from '../state/status-reporter.ts';
import { isPlainObjectRecord, safeCall, toSafeErrorDetails, toSafeErrorMessage, toSerializableAsync } from '../utils.ts';
import { debugLog } from '../utils/debug-log.ts';
import { getBridgeTaskHandler } from './bridge-handler-registry.ts';
import { BridgeTransport } from './bridge-transport.ts';
import { getPcbImportWriteRejection, hasPendingPcbImport, markPcbImportPending } from './pcb-import-confirm-barrier.ts';
import { getPlacementModeWriteRejection } from './placement-mode-barrier.ts';
import { BridgeTaskQuarantine, BridgeTaskTimeoutError, requiresHostRestartForResult, resolveBridgeTaskTimeoutMs, startTimedTask } from './task-timeout.ts';

const RECONNECT_INTERVAL_MS = 1200;
const CONTEXT_SYNC_INTERVAL_MS = 1000;
const PAGE_CONTEXT_READ_TIMEOUT_MS = 5000;
const CONNECT_SUCCESS_TOAST_TIMER_SECONDS = 3;
let started = false;
let connecting = false;
let clientId = '';
let transport: BridgeTransport | undefined;
let reconnectTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
let contextSyncTimer: ReturnType<typeof globalThis.setInterval> | undefined;
let contextSyncInFlight = false;
let configSubscription: ISYS_MessageBusTask | null = null;
let taskChain: Promise<void> = Promise.resolve();
const taskQuarantine = new BridgeTaskQuarantine();
let runningMutationSettled: Promise<void> | undefined;
let currentRole: BridgeRole = 'standby';
let currentLeaseTerm = 0;
let currentActiveClientId = '';
let controlledRecoveryPending = false;
let pendingUnknownWriteRequestId: string | undefined;
let transportGeneration = 0;
let connectionAttemptId = 0;
const HOST_RESTART_REQUIRED_MESSAGE = 'PCB autoLayout or autoRouting may still commit. Restart the EDA host before controlled recovery readback.';
// 每次建立新连接时递增，确保每次调用 eda.sys_WebSocket.register 使用唯一 socketId。
let socketSequence = 0;

const statusReporter = new BridgeStatusReporter();
const bridgeLogDispatchPipeline = new BridgeLogDispatchPipeline();
const BRIDGE_STATUS_TEXT = BridgeStateManager.text;
const MAX_LOG_TEXT_LENGTH = 8000;

function truncateLogText(value: unknown): string | undefined {
	const text = String(value ?? '').trim();
	if (text.length === 0) {
		return undefined;
	}
	return text.length > MAX_LOG_TEXT_LENGTH ? `${text.slice(0, MAX_LOG_TEXT_LENGTH - 3)}...` : text;
}

function getTaskTarget(payload: unknown): { edaApi?: string; detail?: string } {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
		return {};
	}
	const record = payload as Record<string, unknown>;
	const edaApi = typeof record.apiFullName === 'string' ? record.apiFullName.trim() : '';
	const action = typeof record.action === 'string' ? record.action.trim() : '';
	const kind = typeof record.kind === 'string' ? record.kind.trim() : '';
	const detail = [action ? `action=${action}` : '', kind ? `kind=${kind}` : '']
		.filter(Boolean)
		.join(', ');
	return {
		edaApi: edaApi || undefined,
		detail: detail || undefined,
	};
}

function getTaskResultFailureMessage(result: Record<string, unknown>): string {
	for (const key of ['error', 'reason', 'message', 'detail']) {
		const value = result[key];
		if (typeof value === 'string' && value.trim().length > 0) {
			return value.trim();
		}
	}
	return 'Bridge task returned ok:false.';
}

function hasExplicitTaskResultFailure(result: Record<string, unknown>): boolean {
	return ['error', 'reason', 'errorCode'].some(key => typeof result[key] === 'string' && String(result[key]).trim().length > 0)
		|| (typeof result.failedCount === 'number' && Number.isFinite(result.failedCount) && result.failedCount > 0)
		|| result.image === null
		|| result.archive === null
		|| result.source === null;
}

function allowsNegativeTaskResult(path: string): boolean {
	return path === '/bridge/jlceda/netlist/compare'
		|| path === '/bridge/jlceda/design/compare'
		|| path === '/bridge/jlceda/pcb/drc-check'
		|| path === '/bridge/jlceda/schematic/drc-check';
}

function writeTaskLog(
	level: 'info' | 'success' | 'warning' | 'error',
	event: string,
	summary: string,
	task: { requestId: string; path: string; payload: unknown },
	phase: string,
	error?: unknown,
	errorCode?: string,
): void {
	const operation = operationForBridgePath(task.path);
	const target = getTaskTarget(task.payload);
	const errorMessage = error instanceof Error ? error.message : error == null ? '' : String(error);
	const logEntry = bridgeLogPipeline.append(bridgeLogPipeline.createEntry({
		level,
		module: 'bridge-runtime',
		event,
		summary,
		message: errorMessage || summary,
		toolName: operation?.toolName,
		bridgePath: task.path,
		edaApi: target.edaApi,
		requestId: task.requestId,
		phase,
		detail: target.detail,
		errorCode: errorCode ?? (error instanceof BridgeTaskTimeoutError ? 'BRIDGE_TASK_TIMEOUT' : error ? 'BRIDGE_TASK_FAILED' : undefined),
		errorName: error instanceof Error ? error.name : undefined,
		errorStack: truncateLogText(error instanceof Error ? error.stack : undefined),
	}));
	console.warn(bridgeLogPipeline.format(logEntry));
}

function writeRuntimeWarningLog(event: string, summary: string, message: string, detail = '', errorCode = ''): void {
	const logEntry = bridgeLogPipeline.append(bridgeLogPipeline.createEntry({
		level: 'warning',
		module: 'bridge-runtime',
		event,
		summary,
		message,
		bridgeWebSocketUrl: getConfiguredMcpUrl(),
		clientId: clientId || undefined,
		leaseTerm: String(currentLeaseTerm),
		detail,
		errorCode,
	}));
	console.warn(bridgeLogPipeline.format(logEntry));
}

function writeTaskRejectionLog(
	task: { requestId: string; path: string; payload: unknown },
	summary: string,
	message: string,
	phase: string,
): void {
	const operation = operationForBridgePath(task.path);
	const target = getTaskTarget(task.payload);
	const logEntry = bridgeLogPipeline.append(bridgeLogPipeline.createEntry({
		level: 'warning',
		module: 'bridge-runtime',
		event: 'bridge.task.rejected',
		summary,
		message,
		toolName: operation?.toolName,
		bridgePath: task.path,
		edaApi: target.edaApi,
		requestId: task.requestId,
		phase,
		detail: target.detail,
		errorCode: 'BRIDGE_TASK_REJECTED',
	}));
	console.warn(bridgeLogPipeline.format(logEntry));
}

// 显示桥接连接成功提示。
function showConnectSuccessToast(): void {
	try {
		eda.sys_Message.showToastMessage(BRIDGE_STATUS_TEXT.connection.connectSuccessToast, ESYS_ToastMessageType.SUCCESS, CONNECT_SUCCESS_TOAST_TIMER_SECONDS);
	}
	catch (error: unknown) {
		const message = toSafeErrorMessage(error);
		writeRuntimeWarningLog('status.connected.toast.failed', BRIDGE_STATUS_TEXT.runtime.connectedToastFailedSummary, message, message, 'status_connected_toast_failed');
	}
}

// 应用服务端下发的调试开关。
function applyDebugSwitch(debugSwitch: BridgeDebugSwitch): void {
	bridgeLogDispatchPipeline.setDebugSwitch(debugSwitch);
	bridgeLogDispatchPipeline.flushToTransport(transport);
}

// 追加客户端日志并尝试派发到服务端。
function enqueueBridgeLog(logEntry: UnifiedLogEntry): void {
	bridgeLogDispatchPipeline.enqueue(logEntry);
	bridgeLogDispatchPipeline.flushToTransport(transport);
}

// 生成稳定的客户端标识。
function getClientId(): string {
	if (clientId.length > 0) {
		return clientId;
	}

	clientId = `bridge_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
	return clientId;
}

// 生成桥接 WebSocket 连接标识，序列号递增确保每次重连都使用全新 socketId，
// 防止 EDA API 因 socketId 相同而复用旧连接状态导致 onOpen 不触发。
function getSocketId(): string {
	socketSequence += 1;
	return `jlc_mcp_bridge_socket_${getClientId()}_${socketSequence}`;
}

async function withPageContextTimeout<T>(read: Promise<T>, operation: string): Promise<T> {
	let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;
	try {
		return await Promise.race([
			read,
			new Promise<T>((_resolve, reject) => {
				timeoutId = globalThis.setTimeout(() => {
					reject(new Error(`${operation} timed out after ${String(PAGE_CONTEXT_READ_TIMEOUT_MS)}ms.`));
				}, PAGE_CONTEXT_READ_TIMEOUT_MS);
			}),
		]);
	}
	finally {
		if (timeoutId !== undefined)
			globalThis.clearTimeout(timeoutId);
	}
}

// 使用官方上下文 API 读取当前目标身份，避免多页面时仅按连接顺序选择。
async function readBridgeClientContext(expectedPageKind?: BridgeClientContext['pageKind'], allowFootprintApi = false): Promise<BridgeClientContext | undefined> {
	return withPageContextTimeout((async () => {
		const document = await safeCall(() => readCurrentEditorDocument(eda as unknown as Record<string, unknown>));
		const documentPageKind = editorDocumentPageKind(document);
		if (documentPageKind === 'footprint') {
			if (expectedPageKind && expectedPageKind !== 'footprint' && !(allowFootprintApi && expectedPageKind === 'pcb'))
				throw new Error(`Current editor is footprint; ${expectedPageKind} operation was not started.`);
			return footprintIdentityFromDocument(document);
		}
		const [project, schematicPage, pcb] = await Promise.all([
			safeCall(() => eda.dmt_Project.getCurrentProjectInfo()),
			safeCall(() => eda.dmt_Schematic.getCurrentSchematicPageInfo()),
			safeCall(() => eda.dmt_Pcb.getCurrentPcbInfo()),
		]);
		if (!document && !project && !schematicPage && !pcb) {
			if (expectedPageKind)
				throw new Error(`Cannot verify the current ${expectedPageKind} page before writing; the operation was not started.`);
			return undefined;
		}
		if (expectedPageKind && documentPageKind && expectedPageKind !== documentPageKind)
			throw new Error(`Current editor is ${documentPageKind}; ${expectedPageKind} write was not started.`);
		if (expectedPageKind && document?.documentType !== undefined && !documentPageKind)
			throw new Error(`Current editor is not a ${expectedPageKind} page; the write was not started.`);
		if (expectedPageKind && schematicPage && pcb && !documentPageKind)
			throw new Error(`Cannot distinguish the current ${expectedPageKind} page from cached EDA page information; the write was not started.`);
		const pageKind = expectedPageKind ?? documentPageKind
			?? (schematicPage && !pcb ? 'schematic' : pcb && !schematicPage ? 'pcb' : undefined);
		const page = pageKind === 'schematic' ? schematicPage : pageKind === 'pcb' ? pcb : undefined;
		if (expectedPageKind && !page?.uuid)
			throw new Error(`Cannot verify the current ${expectedPageKind} page before writing; the operation was not started.`);
		return {
			documentType: typeof document?.documentType === 'number' ? document.documentType : undefined,
			documentUuid: typeof document?.uuid === 'string' ? document.uuid : undefined,
			tabId: typeof document?.tabId === 'string' ? document.tabId : undefined,
			projectUuid: typeof document?.parentProjectUuid === 'string' ? document.parentProjectUuid : project?.uuid,
			projectName: project?.friendlyName,
			pageKind,
			pageUuid: page?.uuid,
			pageName: page?.name,
		};
	})(), 'EDA page context read');
}

function writeTaskPageKind(path: string, payload: unknown): BridgeClientContext['pageKind'] {
	if (path === '/bridge/jlceda/footprint/save')
		return 'footprint';
	if (path === '/bridge/jlceda/pcb/documents-manage')
		return undefined;
	if (path === '/bridge/jlceda/api/invoke' && isPlainObjectRecord(payload) && typeof payload.apiFullName === 'string') {
		const apiFullName = payload.apiFullName.trim().toLowerCase();
		if (apiFullName.startsWith('eda.pcb_'))
			return 'pcb';
		if (apiFullName.startsWith('eda.sch_'))
			return 'schematic';
	}
	if (path.startsWith('/bridge/jlceda/pcb/') || path === '/bridge/jlceda/net/query-pcb')
		return 'pcb';
	if (path.startsWith('/bridge/jlceda/schematic/')
		|| path.startsWith('/bridge/jlceda/component/')
		|| path.startsWith('/bridge/jlceda/netlabel/')
		|| path.startsWith('/bridge/jlceda/auto/')) {
		return 'schematic';
	}
	return undefined;
}

function canvasInvokeName(path: string, payload: unknown): string | undefined {
	if (path !== '/bridge/jlceda/api/invoke' || !isPlainObjectRecord(payload) || typeof payload.apiFullName !== 'string')
		return undefined;
	const name = payload.apiFullName.trim().toLowerCase();
	return name.startsWith('eda.pcb_') || name.startsWith('eda.sch_') ? name : undefined;
}

async function readFootprintReadTaskContext(path: string, payload: unknown): Promise<BridgeClientContext | undefined> {
	if (!writeTaskPageKind(path, payload) && !path.startsWith('/bridge/jlceda/pcb/'))
		return undefined;
	const document = await withPageContextTimeout(safeCall(() => readCurrentEditorDocument(eda as unknown as Record<string, unknown>)), 'EDA page context read');
	return editorDocumentPageKind(document) === 'footprint' ? footprintIdentityFromDocument(document) : undefined;
}

function assertFootprintTaskAllowed(path: string, payload: unknown, context: BridgeClientContext | undefined): void {
	if (context?.pageKind !== 'footprint' || path === '/bridge/jlceda/footprint/save')
		return;
	const canvasApi = canvasInvokeName(path, payload);
	if (canvasApi) {
		if (!footprintApiAccess(canvasApi))
			throw Object.assign(new Error(`Unsupported footprint canvas API: ${canvasApi}.`), { code: 'UNSUPPORTED_FOOTPRINT_API' });
		return;
	}
	if (path.startsWith('/bridge/jlceda/pcb/') || writeTaskPageKind(path, payload))
		throw new Error('This board/schematic tool cannot operate on a footprint document.');
}

function getUnknownWriteRejection(): string | undefined {
	return pendingUnknownWriteRequestId
		? `EDA write ${pendingUnknownWriteRequestId} has an unknown commit state. Complete controlled recovery before another write.`
		: undefined;
}

// 清理重连定时器。
function clearReconnectTimer(): void {
	if (reconnectTimer !== undefined) {
		globalThis.clearTimeout(reconnectTimer);
		reconnectTimer = undefined;
	}
}

// 清理上下文同步定时器。
function clearContextSyncTimer(): void {
	if (contextSyncTimer !== undefined) {
		globalThis.clearInterval(contextSyncTimer);
		contextSyncTimer = undefined;
	}
}

// 断开当前连接。
function stopTransport(): void {
	connecting = false;
	transportGeneration += 1;
	connectionAttemptId += 1;
	const currentTransport = transport;
	transport = undefined;
	if (currentTransport) {
		void cleanupAllComponentPlaceSessions();
		currentTransport.close();
	}
}

async function readPcbAutoLayoutTaskContext(): Promise<BridgeClientContext> {
	const context = await readBridgeClientContext('pcb');
	if (!context?.pageUuid)
		throw new Error('Cannot verify the current PCB before autoLayout; the operation was not started.');
	return {
		pageKind: 'pcb',
		pageUuid: context.pageUuid,
		documentUuid: context.documentUuid,
		projectUuid: context.projectUuid,
	};
}

// 按角色更新页面状态。
function applyRole(message: BridgeServerRoleMessage): void {
	currentRole = message.role;
	currentLeaseTerm = message.leaseTerm;
	currentActiveClientId = message.activeClientId;
	statusReporter.markRole(message.role, message.clientId, message.activeClientId);
}

// 调度任务执行并回传结果。
export function enqueueTask(task: { requestId: string; path: string; payload: unknown; leaseTerm: number }, currentTransport: BridgeTransport): void {
	debugLog('[DEBUG] enqueueTask called, path:', task.path, 'requestId:', task.requestId);
	const taskGeneration = transportGeneration;
	const readOnly = isReadOnlyBridgeRequest(task.path, task.payload);
	const importRejection = !readOnly && getPcbImportWriteRejection();
	if (importRejection) {
		writeTaskRejectionLog(task, 'Bridge 任务被拒绝', importRejection, 'pcb-import-confirmation');
		currentTransport.completeTask(task.requestId, task.leaseTerm, undefined, { message: importRejection });
		return;
	}
	const unknownWriteRejection = !readOnly && getUnknownWriteRejection();
	if (unknownWriteRejection) {
		writeTaskRejectionLog(task, 'Bridge 任务被拒绝', unknownWriteRejection, 'unknown-write');
		currentTransport.completeTask(task.requestId, task.leaseTerm, undefined, { message: unknownWriteRejection });
		return;
	}
	if (controlledRecoveryPending && !readOnly) {
		const message = taskQuarantine.requiresHostRestart() ? HOST_RESTART_REQUIRED_MESSAGE : 'Bridge client is awaiting controlled recovery after a timed-out task settles.';
		writeTaskRejectionLog(task, 'Bridge 任务被拒绝', message, 'controlled-recovery');
		currentTransport.completeTask(task.requestId, task.leaseTerm, undefined, {
			message,
		});
		return;
	}
	const activeQuarantine = taskQuarantine.getActive();
	if (activeQuarantine && !readOnly) {
		const message = activeQuarantine.requiresHostRestart
			? HOST_RESTART_REQUIRED_MESSAGE
			: `Bridge client is quarantined while a timed-out task is still running: ${activeQuarantine.path}. Select a healthy EDA client or wait for the original task to finish.`;
		writeTaskRejectionLog(task, 'Bridge 任务被隔离', message, 'quarantine');
		currentTransport.completeTask(task.requestId, task.leaseTerm, undefined, {
			message,
		});
		return;
	}
	const placementModeRejection = getPlacementModeWriteRejection(task.path, task.payload);
	if (placementModeRejection) {
		writeTaskRejectionLog(task, 'Bridge 任务被拒绝', placementModeRejection, 'placement-mode');
		currentTransport.completeTask(task.requestId, task.leaseTerm, undefined, {
			message: placementModeRejection,
		});
		return;
	}
	taskChain = taskChain.then(async () => {
		debugLog('[DEBUG] executing task, path:', task.path);
		if (taskGeneration !== transportGeneration) {
			const message = 'Bridge connection was replaced before the queued task started.';
			writeTaskRejectionLog(task, 'Bridge 任务被拒绝', message, 'old-connection');
			currentTransport.completeTask(task.requestId, task.leaseTerm, undefined, { message });
			return;
		}
		const queuedImportRejection = !readOnly && getPcbImportWriteRejection();
		if (queuedImportRejection) {
			writeTaskRejectionLog(task, 'Bridge 任务被拒绝', queuedImportRejection, 'pcb-import-confirmation');
			currentTransport.completeTask(task.requestId, task.leaseTerm, undefined, { message: queuedImportRejection });
			return;
		}
		const queuedUnknownWriteRejection = !readOnly && getUnknownWriteRejection();
		if (queuedUnknownWriteRejection) {
			writeTaskRejectionLog(task, 'Bridge 任务被拒绝', queuedUnknownWriteRejection, 'unknown-write');
			currentTransport.completeTask(task.requestId, task.leaseTerm, undefined, { message: queuedUnknownWriteRejection });
			return;
		}
		if (controlledRecoveryPending && !readOnly) {
			const message = taskQuarantine.requiresHostRestart() ? HOST_RESTART_REQUIRED_MESSAGE : 'Bridge client is awaiting controlled recovery after a timed-out task settles.';
			writeTaskRejectionLog(task, 'Bridge 任务被拒绝', message, 'controlled-recovery');
			currentTransport.completeTask(task.requestId, task.leaseTerm, undefined, {
				message,
			});
			return;
		}
		const activeQuarantine = taskQuarantine.getActive();
		if (activeQuarantine && !readOnly) {
			const message = activeQuarantine.requiresHostRestart
				? HOST_RESTART_REQUIRED_MESSAGE
				: `Bridge client is quarantined while a timed-out task is still running: ${activeQuarantine.path}. Select a healthy EDA client or wait for the original task to finish.`;
			writeTaskRejectionLog(task, 'Bridge 任务被隔离', message, 'quarantine');
			currentTransport.completeTask(task.requestId, task.leaseTerm, undefined, {
				message,
			});
			return;
		}
		const placementModeRejection = getPlacementModeWriteRejection(task.path, task.payload);
		if (placementModeRejection) {
			writeTaskRejectionLog(task, 'Bridge 任务被拒绝', placementModeRejection, 'placement-mode');
			currentTransport.completeTask(task.requestId, task.leaseTerm, undefined, {
				message: placementModeRejection,
			});
			return;
		}
		if (currentRole !== 'active') {
			writeTaskRejectionLog(task, 'Bridge 任务被拒绝', BRIDGE_STATUS_TEXT.runtime.taskRejectedStandby, 'standby');
			currentTransport.completeTask(task.requestId, task.leaseTerm, undefined, {
				message: BRIDGE_STATUS_TEXT.runtime.taskRejectedStandby,
			});
			return;
		}

		if (task.leaseTerm !== currentLeaseTerm) {
			writeTaskRejectionLog(task, 'Bridge 任务租约已过期', BRIDGE_STATUS_TEXT.runtime.taskLeaseExpired, 'lease');
			currentTransport.completeTask(task.requestId, task.leaseTerm, undefined, {
				message: BRIDGE_STATUS_TEXT.runtime.taskLeaseExpired,
			});
			return;
		}
		if (operationForBridgePath(task.path)?.owner !== 'bridge') {
			const message = `${BRIDGE_STATUS_TEXT.runtime.taskPathUnsupportedPrefix}${task.path}`;
			writeTaskRejectionLog(task, 'Bridge 任务路由不受支持', message, 'route');
			currentTransport.completeTask(task.requestId, task.leaseTerm, undefined, {
				message,
			});
			return;
		}

		const handler = getBridgeTaskHandler(task.path);
		debugLog('[DEBUG] handler found:', !!handler, 'for path:', task.path);
		if (!handler) {
			const message = `${BRIDGE_STATUS_TEXT.runtime.taskPathUnsupportedPrefix}${task.path}`;
			writeTaskRejectionLog(task, 'Bridge 任务处理器不存在', message, 'handler-lookup');
			currentTransport.completeTask(task.requestId, task.leaseTerm, undefined, {
				message,
			});
			return;
		}

		let result: unknown;
		let taskError: { message: string; name?: string; stack?: string; code?: string; timeoutMs?: number } | undefined;
		let handlerSettled: Promise<void> | undefined;
		try {
			debugLog('[DEBUG] calling handler for path:', task.path);
			const autoLayoutTask = task.path === '/bridge/jlceda/api/invoke'
				&& isPlainObjectRecord(task.payload)
				&& typeof task.payload.apiFullName === 'string'
				&& task.payload.apiFullName.trim().toLowerCase() === 'eda.pcb_document.autolayout';
			const schematicCreateTask = task.path === '/bridge/jlceda/api/invoke'
				&& isPlainObjectRecord(task.payload)
				&& typeof task.payload.apiFullName === 'string'
				&& task.payload.apiFullName.trim().toLowerCase() === 'eda.sch_primitivecomponent.create';
			const schematicWireCreateTask = (task.path === '/bridge/jlceda/schematic/connectivity'
				&& isPlainObjectRecord(task.payload) && task.payload.action === 'wire_create')
			|| canvasInvokeName(task.path, task.payload) === 'eda.sch_primitivewire.create';
			const schematicDeleteTask = task.path === '/bridge/jlceda/api/invoke'
				&& isPlainObjectRecord(task.payload)
				&& typeof task.payload.apiFullName === 'string'
				&& task.payload.apiFullName.trim().toLowerCase() === 'eda.sch_primitivecomponent.delete';
			const executionContext = readOnly
				? await readFootprintReadTaskContext(task.path, task.payload)
				: autoLayoutTask
					? await readPcbAutoLayoutTaskContext()
					: await readBridgeClientContext(writeTaskPageKind(task.path, task.payload), canvasInvokeName(task.path, task.payload)?.startsWith('eda.pcb_'));
			assertFootprintTaskAllowed(task.path, task.payload, executionContext);
			let handlerPayload: unknown = task.payload;
			if (executionContext?.pageKind && canvasInvokeName(task.path, task.payload)) {
				handlerPayload = { ...(task.payload as Record<string, unknown>), expectedEditorPageKind: executionContext.pageKind, ...(executionContext.pageKind === 'footprint' ? { expectedFootprintIdentity: executionContext } : {}) };
			}
			else if (task.path === '/bridge/jlceda/footprint/save') {
				handlerPayload = { ...(task.payload as Record<string, unknown>), expectedFootprintIdentity: executionContext };
			}
			if (autoLayoutTask) {
				handlerPayload = { ...(task.payload as Record<string, unknown>), expectedPcbUuid: executionContext!.pageUuid };
			}
			else if (schematicCreateTask) {
				if (!executionContext?.pageUuid || executionContext.pageUuid !== executionContext.documentUuid)
					throw new Error('Current schematic page and editor document are not synchronized; creation was not started.');
				handlerPayload = { ...(handlerPayload as Record<string, unknown>), expectedSchematicCreatePageUuid: executionContext.pageUuid };
			}
			else if (schematicWireCreateTask) {
				if (!executionContext?.pageUuid || executionContext.pageUuid !== executionContext.documentUuid)
					throw new Error('Current schematic page and editor document are not synchronized; wire creation was not started.');
				handlerPayload = { ...(handlerPayload as Record<string, unknown>), expectedSchematicWirePageUuid: executionContext.pageUuid };
			}
			else if (schematicDeleteTask) {
				if (!executionContext?.pageUuid || executionContext.pageUuid !== executionContext.documentUuid)
					throw new Error('Current schematic page and editor document are not synchronized; deletion was not started.');
				handlerPayload = { ...(task.payload as Record<string, unknown>), expectedSchematicDeletePageUuid: executionContext.pageUuid };
			}
			if (taskGeneration !== transportGeneration || transport !== currentTransport)
				throw new Error('Bridge connection changed before the EDA task started.');
			if (currentRole !== 'active')
				throw new Error(BRIDGE_STATUS_TEXT.runtime.taskRejectedStandby);
			if (task.leaseTerm !== currentLeaseTerm)
				throw new Error(BRIDGE_STATUS_TEXT.runtime.taskLeaseExpired);
			currentTransport.reportTaskStarted(task.requestId, task.leaseTerm, executionContext);
			writeTaskLog('info', 'bridge.task.started', 'Bridge 任务开始执行', task, 'handler');
			// 任务执行前刷新服务端活动时间戳，避免空闲超时误判
			currentTransport.refreshServerActivity();
			const timeoutMs = resolveBridgeTaskTimeoutMs(task.path, task.payload);
			const timedTask = startTimedTask(
				(async () => {
					const value = await toSerializableAsync(await handler(handlerPayload, (adapter) => {
						if (taskGeneration !== transportGeneration || transport !== currentTransport)
							throw new Error('Bridge connection changed before the pin mutation started.');
						if (currentRole !== 'active' || task.leaseTerm !== currentLeaseTerm)
							throw new Error('Bridge role or lease changed before the pin mutation started.');
						currentTransport.reportTaskStarted(task.requestId, task.leaseTerm, executionContext, adapter);
					}, () => {
						if (taskGeneration !== transportGeneration || transport !== currentTransport)
							throw new Error('Bridge connection changed before the native mutation started.');
						if (currentRole !== 'active' || task.leaseTerm !== currentLeaseTerm)
							throw new Error('Bridge role or lease changed before the native mutation started.');
					}));
					if (task.path === '/bridge/jlceda/pcb/document'
						&& task.payload && typeof task.payload === 'object' && !Array.isArray(task.payload)
						&& (task.payload as Record<string, unknown>).action === 'import_changes'
						&& value && typeof value === 'object' && !Array.isArray(value)
						&& (value as Record<string, unknown>).commitState === 'pending_confirmation') {
						markPcbImportPending(task.requestId);
					}
					if (!readOnly && isPlainObjectRecord(value) && value.commitUnknown === true)
						pendingUnknownWriteRequestId = task.requestId;
					if (requiresHostRestartForResult(task.path, task.payload, value))
						taskQuarantine.requireHostRestart(task.path);
					return value;
				})(),
				task.path,
				timeoutMs,
			);
			handlerSettled = timedTask.settled;
			if (!readOnly) {
				runningMutationSettled = timedTask.settled;
				void timedTask.settled.then(() => {
					if (runningMutationSettled === timedTask.settled)
						runningMutationSettled = undefined;
				});
			}
			result = await timedTask.result;
			// 任务完成后再次刷新，确保结果回传前连接不被断开
			currentTransport.refreshServerActivity();
			debugLog('[DEBUG] handler completed successfully, result:', typeof result);
			const resultRecord = result && typeof result === 'object' && !Array.isArray(result)
				? result as Record<string, unknown>
				: undefined;
			if (resultRecord?.ok === false) {
				if (!allowsNegativeTaskResult(task.path) || hasExplicitTaskResultFailure(resultRecord)) {
					writeTaskLog(
						'error',
						'bridge.task.result.failed',
						'Bridge 任务返回失败结果',
						task,
						'handler-result',
						getTaskResultFailureMessage(resultRecord),
						typeof resultRecord.errorCode === 'string' && resultRecord.errorCode.trim().length > 0
							? resultRecord.errorCode.trim()
							: 'BRIDGE_TASK_RESULT_FAILED',
					);
				}
				else {
					// Some comparison/DRC APIs use ok:false to report a valid negative
					// result rather than an execution failure.
					writeTaskLog('warning', 'bridge.task.completed.result-negative', 'Bridge 任务完成，但结果为 ok:false', task, 'handler-result');
				}
			}
			else {
				writeTaskLog('success', 'bridge.task.completed', 'Bridge 任务执行完成', task, 'completed');
			}
		}
		catch (error: unknown) {
			if (error instanceof BridgeTaskTimeoutError) {
				const backgroundSettled = error.backgroundSettled ?? handlerSettled;
				if (backgroundSettled) {
					taskQuarantine.enter(task.path, backgroundSettled, !readOnly);
				}
			}
			debugLog('[DEBUG] handler threw error:', error);
			taskError = {
				...toSafeErrorDetails(error),
				stack: error instanceof Error ? error.stack : undefined,
				...(error instanceof BridgeTaskTimeoutError
					? { code: 'BRIDGE_TASK_TIMEOUT', timeoutMs: error.timeoutMs }
					: {}),
			};
			writeTaskLog(
				error instanceof BridgeTaskTimeoutError ? 'warning' : 'error',
				error instanceof BridgeTaskTimeoutError ? 'bridge.task.timeout' : 'bridge.task.failed',
				error instanceof BridgeTaskTimeoutError ? 'Bridge 任务超时' : 'Bridge 任务执行失败',
				task,
				error instanceof BridgeTaskTimeoutError ? 'timeout' : 'error',
				error,
			);
		}

		debugLog('[DEBUG] completing task, hasError:', !!taskError);
		// The underlying EDA API cannot be cancelled. On timeout, the quarantine
		// rejects later work until that background Promise settles.
		currentTransport.completeTask(task.requestId, task.leaseTerm, result, taskError);
	}).catch((error: unknown) => {
		const message = toSafeErrorMessage(error);
		writeRuntimeWarningLog('bridge.task.failed', BRIDGE_STATUS_TEXT.runtime.taskFailedSummary, message, message, 'bridge_task_failed');
	});
}

// 探活经过同一串行队列，证明待命客户端能接收消息且任务链仍可推进。
// 不访问 EDA 文档，也不修改当前租约或写入隔离状态。
export function enqueueSelectionProbe(probeId: string, currentTransport: BridgeTransport): void {
	const probeGeneration = transportGeneration;
	taskChain = taskChain.then(() => {
		if (probeGeneration === transportGeneration && transport === currentTransport)
			currentTransport.reportSelectionProbeAck(probeId);
	}).catch((error: unknown) => {
		const message = toSafeErrorMessage(error);
		writeRuntimeWarningLog('bridge.probe.failed', 'Bridge 探活失败', message, message, 'bridge_probe_failed');
	});
}

// 建立桥接连接。
async function ensureConnected(checkEditablePage = false): Promise<void> {
	if (!started || connecting || transport) {
		return;
	}

	connecting = true;
	statusReporter.markConnecting();
	const connectionGeneration = transportGeneration;
	const attemptId = ++connectionAttemptId;
	const ownsAttempt = () => connectionAttemptId === attemptId && transportGeneration === connectionGeneration;
	const activeClientId = getClientId();
	let initialContext: BridgeClientContext | undefined;
	try {
		if (checkEditablePage && !await isEditablePage()) {
			if (ownsAttempt()) {
				connecting = false;
				statusReporter.markNotOnEditablePage();
			}
			return;
		}
		if (!started || !ownsAttempt())
			return;
		initialContext = await readBridgeClientContext();
	}
	catch (error: unknown) {
		if (ownsAttempt()) {
			connecting = false;
			if (started) {
				statusReporter.markFailed(toSafeErrorMessage(error));
				scheduleReconnect();
			}
		}
		return;
	}
	if (!started || !ownsAttempt() || transport) {
		if (ownsAttempt()) {
			connecting = false;
			if (started && !transport)
				scheduleReconnect();
		}
		return;
	}
	const instance = new BridgeTransport(getConfiguredMcpUrl(), getSocketId(), activeClientId, String(extensionConfig.version), initialContext, {
		onRoleChanged: (message) => {
			if (ownsAttempt())
				applyRole(message);
		},
		onDebugSwitchChanged: (debugSwitch) => {
			if (ownsAttempt())
				applyDebugSwitch(debugSwitch);
		},
		onTask: async (task) => {
			enqueueTask(task, instance);
		},
		onProbeRequested: (probeId) => {
			if (ownsAttempt())
				enqueueSelectionProbe(probeId, instance);
		},
		onRecoveryRequested: (_recoveryId, _reason) => {
			if (ownsAttempt())
				startControlledRecovery();
		},
		onLost: (message) => {
			if (transport !== instance || !ownsAttempt()) {
				return;
			}
			void cleanupAllComponentPlaceSessions();
			transportGeneration += 1;
			connectionAttemptId += 1;
			transport = undefined;
			connecting = false;
			if (!started) {
				return;
			}
			statusReporter.markFailed(message);
			scheduleReconnect();
		},
	});

	try {
		debugLog('[DEBUG] bridge-runtime starting connection');
		bridgeLogDispatchPipeline.resetHandshakeState();
		await instance.connect();
		debugLog('[DEBUG] bridge-runtime connection established');
		if (!started || !ownsAttempt() || transport) {
			instance.close();
			if (ownsAttempt() && started && !transport)
				scheduleReconnect();
			return;
		}

		transport = instance;
		bridgeLogDispatchPipeline.flushToTransport(transport);
		// 只有运行时确认握手完成并接管实例后，才通知服务端允许调度任务。
		debugLog('[DEBUG] bridge-runtime calling reportReady');
		transport.reportReady();
		debugLog('[DEBUG] bridge-runtime reportReady completed');
		showConnectSuccessToast();
	}
	catch (error: unknown) {
		instance.close();
		if (ownsAttempt()) {
			// ready 发送失败时也要释放已接管的连接，避免重连被旧引用阻塞。
			if (transport === instance)
				stopTransport();
			statusReporter.markFailed(toSafeErrorMessage(error));
			scheduleReconnect();
		}
	}
	finally {
		if (ownsAttempt())
			connecting = false;
	}
}

function startControlledRecovery(): void {
	if (controlledRecoveryPending) {
		return;
	}
	controlledRecoveryPending = true;
	if (hasPendingPcbImport()) {
		statusReporter.markFailed('PCB import confirmation is pending. Restart the EDA host before controlled recovery readback.');
		return;
	}
	if (taskQuarantine.requiresHostRestart()) {
		statusReporter.markFailed(HOST_RESTART_REQUIRED_MESSAGE);
		return;
	}
	statusReporter.markConnecting();

	// A Server timeout may arrive before the Bridge timeout. Wait for the
	// running handler too, so a later unknown result cannot race with reconnect.
	const settle = taskQuarantine.waitForSettlement() ?? runningMutationSettled ?? Promise.resolve();
	void (async () => {
		await settle;
		if (taskQuarantine.requiresHostRestart() || hasPendingPcbImport()) {
			statusReporter.markFailed(HOST_RESTART_REQUIRED_MESSAGE);
			return;
		}
		await cleanupAllComponentPlaceSessions();
		clientId = '';
		clearReconnectTimer();
		stopTransport();
		pendingUnknownWriteRequestId = undefined;
		currentRole = 'standby';
		currentLeaseTerm = 0;
		currentActiveClientId = '';
		if (await isEditablePage())
			await ensureConnected();
		else
			statusReporter.markNotOnEditablePage();
	})().catch((error: unknown) => {
		statusReporter.markFailed(toSafeErrorMessage(error));
	}).finally(() => {
		if (!taskQuarantine.requiresHostRestart() && !hasPendingPcbImport())
			controlledRecoveryPending = false;
	});
}

// 安排重连。
function scheduleReconnect(): void {
	if (!started || reconnectTimer !== undefined) {
		return;
	}

	reconnectTimer = globalThis.setTimeout(() => {
		reconnectTimer = undefined;
		void ensureConnected();
	}, RECONNECT_INTERVAL_MS);
}

// 触发配置切换后的重连。
function requestReconnectByConfigChange(): void {
	if (!started) {
		return;
	}

	clearReconnectTimer();
	stopTransport();
	currentRole = 'standby';
	currentLeaseTerm = 0;
	currentActiveClientId = '';
	void ensureConnected();
}

// 订阅配置更新。
function subscribeConfigChange(): void {
	if (configSubscription?.running()) {
		return;
	}

	configSubscription = eda.sys_MessageBus.subscribe(getMcpServerUrlChangedTopic(), (message: unknown) => {
		if (typeof message !== 'string' || message.trim().length === 0) {
			return;
		}
		requestReconnectByConfigChange();
	});
}

// 检查当前页面是否为原理图、PCB 或封装可编辑页。
async function isEditablePage(): Promise<boolean> {
	return withPageContextTimeout((async () => {
		const document = await safeCall(() => readCurrentEditorDocument(eda as unknown as Record<string, unknown>));
		const kind = editorDocumentPageKind(document);
		if (kind === 'footprint')
			return true;
		if (document?.documentType !== undefined && kind === undefined)
			return false;
		const [schPageInfo, pcbInfo] = await Promise.all([
			safeCall(() => eda.dmt_Schematic.getCurrentSchematicPageInfo()),
			safeCall(() => eda.dmt_Pcb.getCurrentPcbInfo()),
		]);
		return schPageInfo != null || pcbInfo != null;
	})(), 'EDA editable page detection');
}

// 周期同步页面上下文和连接状态。
function startContextSync(): void {
	clearContextSyncTimer();
	contextSyncTimer = globalThis.setInterval(() => {
		if (contextSyncInFlight)
			return;
		contextSyncInFlight = true;
		void isEditablePage().then(async (editable) => {
			if (editable) {
				transport?.updateContext(await readBridgeClientContext());
				// 在原理图、PCB 或封装页时正常维持连接。
				void ensureConnected();
				// 心跳刷新状态快照，让设置页的过期检测能区分活跃连接与历史遗留数据。
				if (transport && currentLeaseTerm > 0) {
					statusReporter.markRole(currentRole, getClientId(), currentActiveClientId);
				}
				else if (connecting) {
					statusReporter.markConnecting();
				}
			}
			else if (transport) {
				// 离开原理图/PCB/封装页时主动断开，避免首页无意义占用连接。
				clearReconnectTimer();
				stopTransport();
				currentRole = 'standby';
				currentLeaseTerm = 0;
				currentActiveClientId = '';
				statusReporter.markNotOnEditablePage();
			}
		}).catch(() => {
			// 页面类型检测失败时不做处理，下次同步时再试。
		}).finally(() => {
			contextSyncInFlight = false;
		});
	}, CONTEXT_SYNC_INTERVAL_MS);
}

/**
 * 启动桥接运行时。
 */
export function startBridgeRuntime(): void {
	if (started) {
		return;
	}

	started = true;
	bridgeLogPipeline.setListener((logEntry) => {
		enqueueBridgeLog(logEntry);
	});
	subscribeConfigChange();
	startContextSync();
	// 启动时检查页面类型，仅在原理图、PCB 或封装页才立即发起连接。
	void isEditablePage().then((editable) => {
		if (editable) {
			void ensureConnected();
		}
	}).catch(() => {
		// 页面类型检测失败时跳过初次连接，由周期同步接管。
	});
}

/**
 * 停止桥接运行时并释放所有连接与订阅。
 */
export function stopBridgeRuntime(): void {
	if (!started) {
		return;
	}

	started = false;
	clearReconnectTimer();
	clearContextSyncTimer();
	stopTransport();
	configSubscription?.cancel();
	configSubscription = null;
	bridgeLogPipeline.setListener(undefined);
	currentRole = 'standby';
	currentLeaseTerm = 0;
	currentActiveClientId = '';
}

/**
 * 手动重启桥接连接，保留运行时与配置订阅。
 */
export function restartBridgeServer(): void {
	if (!started) {
		startBridgeRuntime();
		return;
	}

	clearReconnectTimer();
	stopTransport();
	currentRole = 'standby';
	currentLeaseTerm = 0;
	currentActiveClientId = '';
	statusReporter.markConnecting();
	void ensureConnected(true);
}
