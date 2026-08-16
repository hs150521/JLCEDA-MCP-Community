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
import { getConfiguredMcpUrl, getMcpServerUrlChangedTopic } from '../bridge/config.ts';
import { BridgeLogDispatchPipeline } from '../logging/log-dispatch.ts';
import { bridgeLogPipeline } from '../logging/log.ts';
import { handleApiIndexTask } from '../mcp/api-index-handler.ts';
import { handleApiSearchTask } from '../mcp/api-search-handler.ts';
import { handleAutoLayoutTask } from '../mcp/auto-layout-handler.ts';
import { handleAutoRoutingTask } from '../mcp/auto-routing-handler.ts';
import { handleComponentPlaceAutoTask } from '../mcp/component-place-auto-handler.ts';
import {
	handleComponentPlaceCheckTask,
	handleComponentPlaceCloseTask,
	handleComponentPlaceStartTask,
	handleComponentPlaceTask,
} from '../mcp/component-place-handler.ts';
import { handleComponentSelectTask } from '../mcp/component-select-handler.ts';
import { handleEdaContextTask } from '../mcp/context-handler.ts';
import { handleApiInvokeTask } from '../mcp/invoke-handler.ts';
import { handleNetLabelModifyTask } from '../mcp/netlabel-modify-handler.ts';
import { handleNetLabelPlaceTask } from '../mcp/netlabel-place-handler.ts';
import { handleSchematicReadTask } from '../mcp/schematic-read-handler.ts';
import { handleSchematicReviewTask } from '../mcp/schematic-review-handler.ts';
import { BridgeStateManager } from '../state/state-manager.ts';
import { BridgeStatusReporter } from '../state/status-reporter.ts';
import { safeCall, toSafeErrorMessage, toSerializableAsync } from '../utils.ts';
import { debugLog } from '../utils/debug-log.ts';
import { BridgeTransport } from './bridge-transport.ts';
import { resolveBridgeTaskTimeoutMs, startTimedTask } from './task-timeout.ts';

const RECONNECT_INTERVAL_MS = 1200;
const CONTEXT_SYNC_INTERVAL_MS = 1000;
const CONNECT_SUCCESS_TOAST_TIMER_SECONDS = 3;
const BRIDGE_TASK_HANDLERS: Record<string, (payload: unknown) => Promise<unknown>> = {
	'/bridge/jlceda/api/index': handleApiIndexTask,
	'/bridge/jlceda/api/search': handleApiSearchTask,
	'/bridge/jlceda/api/invoke': handleApiInvokeTask,
	'/bridge/jlceda/auto/layout': handleAutoLayoutTask,
	'/bridge/jlceda/auto/routing': handleAutoRoutingTask,
	'/bridge/jlceda/component/place/check': handleComponentPlaceCheckTask,
	'/bridge/jlceda/component/place/close': handleComponentPlaceCloseTask,
	'/bridge/jlceda/component/place/start': handleComponentPlaceStartTask,
	'/bridge/jlceda/component/place': handleComponentPlaceTask,
	'/bridge/jlceda/component/place-auto': handleComponentPlaceAutoTask,
	'/bridge/jlceda/component/select': handleComponentSelectTask,
	'/bridge/jlceda/context': handleEdaContextTask,
	'/bridge/jlceda/netlabel/modify': handleNetLabelModifyTask,
	'/bridge/jlceda/netlabel/place': handleNetLabelPlaceTask,
	'/bridge/jlceda/schematic/read': handleSchematicReadTask,
	'/bridge/jlceda/schematic/review': handleSchematicReviewTask,
};

let started = false;
let connecting = false;
let clientId = '';
let transport: BridgeTransport | undefined;
let reconnectTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
let contextSyncTimer: ReturnType<typeof globalThis.setInterval> | undefined;
let configSubscription: ISYS_MessageBusTask | null = null;
let taskChain: Promise<void> = Promise.resolve();
let currentRole: BridgeRole = 'standby';
let currentLeaseTerm = 0;
let currentActiveClientId = '';
// 每次建立新连接时递增，确保每次调用 eda.sys_WebSocket.register 使用唯一 socketId。
let socketSequence = 0;

const statusReporter = new BridgeStatusReporter();
const bridgeLogDispatchPipeline = new BridgeLogDispatchPipeline();
const BRIDGE_STATUS_TEXT = BridgeStateManager.text;

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

// 使用官方上下文 API 读取当前目标身份，避免多页面时仅按连接顺序选择。
async function readBridgeClientContext(): Promise<BridgeClientContext | undefined> {
	const [document, project, schematicPage, pcb] = await Promise.all([
		safeCall(() => eda.dmt_SelectControl.getCurrentDocumentInfo()),
		safeCall(() => eda.dmt_Project.getCurrentProjectInfo()),
		safeCall(() => eda.dmt_Schematic.getCurrentSchematicPageInfo()),
		safeCall(() => eda.dmt_Pcb.getCurrentPcbInfo()),
	]);
	if (!document && !schematicPage && !pcb) {
		return undefined;
	}
	return {
		documentType: document?.documentType,
		documentUuid: document?.uuid,
		tabId: document?.tabId,
		projectUuid: document?.parentProjectUuid ?? project?.uuid,
		projectName: project?.friendlyName,
		pageKind: schematicPage ? 'schematic' : pcb ? 'pcb' : undefined,
		pageUuid: schematicPage?.uuid ?? pcb?.uuid,
		pageName: schematicPage?.name ?? pcb?.name,
	};
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
	if (transport) {
		transport.close();
		transport = undefined;
	}
}

// 按角色更新页面状态。
function applyRole(message: BridgeServerRoleMessage): void {
	currentRole = message.role;
	currentLeaseTerm = message.leaseTerm;
	currentActiveClientId = message.activeClientId;
	statusReporter.markRole(message.role, message.clientId, message.activeClientId);
}

// 调度任务执行并回传结果。
function enqueueTask(task: { requestId: string; path: string; payload: unknown; leaseTerm: number }, currentTransport: BridgeTransport): void {
	debugLog('[DEBUG] enqueueTask called, path:', task.path, 'requestId:', task.requestId);
	taskChain = taskChain.then(async () => {
		debugLog('[DEBUG] executing task, path:', task.path);
		// 本地MCP运行模式，移除角色和租约检查
		// if (currentRole !== 'active') {
		// 	currentTransport.completeTask(task.requestId, task.leaseTerm, undefined, {
		// 		message: BRIDGE_STATUS_TEXT.runtime.taskRejectedStandby,
		// 	});
		// 	return;
		// }

		// if (task.leaseTerm !== currentLeaseTerm) {
		// 	currentTransport.completeTask(task.requestId, task.leaseTerm, undefined, {
		// 		message: BRIDGE_STATUS_TEXT.runtime.taskLeaseExpired,
		// 	});
		// 	return;
		// }

		const handler = BRIDGE_TASK_HANDLERS[task.path];
		debugLog('[DEBUG] handler found:', !!handler, 'for path:', task.path);
		if (!handler) {
			currentTransport.completeTask(task.requestId, task.leaseTerm, undefined, {
				message: `${BRIDGE_STATUS_TEXT.runtime.taskPathUnsupportedPrefix}${task.path}`,
			});
			return;
		}

		let result: unknown;
		let taskError: { message: string; stack?: string } | undefined;
		let handlerSettled: Promise<void> | undefined;
		try {
			debugLog('[DEBUG] calling handler for path:', task.path);
			currentTransport.reportTaskStarted(task.requestId, task.leaseTerm);
			// 任务执行前刷新服务端活动时间戳，避免空闲超时误判
			currentTransport.refreshServerActivity();
			const timeoutMs = resolveBridgeTaskTimeoutMs(task.path, task.payload);
			const timedTask = startTimedTask(
				(async () => toSerializableAsync(await handler(task.payload)))(),
				task.path,
				timeoutMs,
			);
			handlerSettled = timedTask.settled;
			result = await timedTask.result;
			// 任务完成后再次刷新，确保结果回传前连接不被断开
			currentTransport.refreshServerActivity();
			debugLog('[DEBUG] handler completed successfully, result:', typeof result);
		}
		catch (error: unknown) {
			debugLog('[DEBUG] handler threw error:', error);
			taskError = {
				message: toSafeErrorMessage(error),
				stack: error instanceof Error ? error.stack : undefined,
			};
		}

		debugLog('[DEBUG] completing task, hasError:', !!taskError);
		try {
			currentTransport.completeTask(task.requestId, task.leaseTerm, result, taskError);
		}
		finally {
			// Promise 超时无法取消嘉立创 EDA API。保持任务链锁定直到后台调用真正结束，
			// 防止调用方重试或后续写操作与仍在运行的修改重叠。
			if (handlerSettled) {
				await handlerSettled;
			}
		}
	}).catch((error: unknown) => {
		const message = toSafeErrorMessage(error);
		writeRuntimeWarningLog('bridge.task.failed', BRIDGE_STATUS_TEXT.runtime.taskFailedSummary, message, message, 'bridge_task_failed');
	});
}

// 建立桥接连接。
async function ensureConnected(): Promise<void> {
	if (!started || connecting || transport) {
		return;
	}

	connecting = true;
	statusReporter.markConnecting();
	const activeClientId = getClientId();
	const initialContext = await readBridgeClientContext();
	const instance = new BridgeTransport(getConfiguredMcpUrl(), getSocketId(), activeClientId, String(extensionConfig.version), initialContext, {
		onRoleChanged: (message) => {
			applyRole(message);
		},
		onDebugSwitchChanged: (debugSwitch) => {
			applyDebugSwitch(debugSwitch);
		},
		onTask: async (task) => {
			enqueueTask(task, instance);
		},
		onLost: (message) => {
			if (transport === instance) {
				transport = undefined;
			}
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
		if (!started) {
			instance.close();
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
		statusReporter.markFailed(toSafeErrorMessage(error));
		scheduleReconnect();
	}
	finally {
		connecting = false;
	}
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

// 检查当前页面是否为原理图或 PCB 可编辑页。
async function isEditablePage(): Promise<boolean> {
	const [schPageInfo, pcbInfo] = await Promise.all([
		safeCall(() => eda.dmt_Schematic.getCurrentSchematicPageInfo()),
		safeCall(() => eda.dmt_Pcb.getCurrentPcbInfo()),
	]);
	return schPageInfo != null || pcbInfo != null;
}

// 周期同步页面上下文和连接状态。
function startContextSync(): void {
	clearContextSyncTimer();
	contextSyncTimer = globalThis.setInterval(() => {
		void isEditablePage().then(async (editable) => {
			if (editable) {
				transport?.updateContext(await readBridgeClientContext());
				// 在原理图或 PCB 页时正常维持连接。
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
				// 离开原理图/PCB 页时主动断开，避免首页无意义占用连接。
				clearReconnectTimer();
				stopTransport();
				currentRole = 'standby';
				currentLeaseTerm = 0;
				currentActiveClientId = '';
				statusReporter.markNotOnEditablePage();
			}
		}).catch(() => {
			// 页面类型检测失败时不做处理，下次同步时再试。
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
	// 启动时检查页面类型，仅在原理图或 PCB 页才立即发起连接。
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
	void isEditablePage().then((editable) => {
		if (editable) {
			void ensureConnected();
		}
		else {
			statusReporter.markNotOnEditablePage();
		}
	}).catch((error: unknown) => {
		statusReporter.markFailed(toSafeErrorMessage(error));
	});
}
