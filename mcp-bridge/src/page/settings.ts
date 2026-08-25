/**
 * ------------------------------------------------------------------------
 * 名称：连接设置页面
 * 说明：负责配置桥接 WebSocket 地址并实时展示桥接连接状态。
 * 作者：Lion
 * 邮箱：chengbin@3578.cn
 * 日期：2026-03-10
 * 备注：页面脚本入口。
 * ------------------------------------------------------------------------
 */

import type { ConnectionStatusSnapshot } from '../state/status-store.ts';
import {
	DEFAULT_MCP_WS_URL,
	getConfiguredMcpUrl,
	getMcpServerUrlChangedTopic,
	normalizeMcpUrl,
	saveConfiguredMcpUrl,
} from '../bridge/config.ts';
import { bridgeLogPipeline } from '../logging/log.ts';
import { BridgeStateManager } from '../state/state-manager.ts';
import {
	isConnectionStatusSnapshot,
	MCP_CONNECTION_STATUS_CHANGED_TOPIC,
	readConnectionStatus,
} from '../state/status-store.ts';
import { toSafeErrorMessage } from '../utils.ts';

// 配置保存提示展示时长，单位秒。
const CONFIG_TOAST_TIMER_SECONDS = 3;

// 当前已保存的地址文本，用于判断按钮是否需要启用。
let savedServerUrlValue = '';
// 当前是否处于保存中，避免重复提交。
let savingServerConfig = false;
const bridgeStateManager = new BridgeStateManager();
const BRIDGE_STATUS_TEXT = BridgeStateManager.text;

// 统一显示配置保存相关的弹层提示。
function showConfigToast(message: string, messageType: ESYS_ToastMessageType): void {
	eda.sys_Message.showToastMessage(message, messageType, CONFIG_TOAST_TIMER_SECONDS);
}

function writeSettingsWarningLog(event: string, summary: string, message: string, detail = '', errorCode = ''): void {
	const logEntry = bridgeLogPipeline.append(bridgeLogPipeline.createEntry({
		level: 'warning',
		module: 'settings-page',
		event,
		summary,
		message,
		bridgeWebSocketUrl: getConfiguredMcpUrl(),
		detail,
		errorCode,
	}));
	console.warn(bridgeLogPipeline.format(logEntry));
}

// 获取页面元素并进行类型校验。
function getElement<T extends HTMLElement>(id: string, elementType: { new(): T }, elementLabel: string): T {
	const element = document.getElementById(id);
	if (!(element instanceof elementType)) {
		throw new TypeError(`页面缺少${elementLabel}控件: ${id}`);
	}
	return element;
}

// 根据输入是否变化和当前保存状态刷新按钮可用性。
function syncSaveButtonState(): void {
	const input = getElement('serverUrl', HTMLInputElement, '输入');
	const button = getElement('saveButton', HTMLButtonElement, '按钮');
	button.disabled = savingServerConfig || input.value === savedServerUrlValue;
}

// 更新连接状态展示。
function setStatus(
	bridgeType: 'connecting' | 'connected' | 'error',
	bridgeText: string,
	websocketType: 'connecting' | 'connected' | 'error',
	websocketText: string,
): void {
	const bridgeStatusText = getElement('bridgeStatusText', HTMLParagraphElement, '桥接状态展示');
	const socketStatusText = getElement('socketStatusText', HTMLParagraphElement, 'WebSocket 状态展示');
	bridgeStatusText.className = `status-text status-${bridgeType}`;
	bridgeStatusText.textContent = bridgeStateManager.getBridgeDisplayText(bridgeType, bridgeText);
	bridgeStatusText.classList.toggle('is-waiting-message', bridgeStateManager.isBridgeWaitingMessage(bridgeType, bridgeText));

	socketStatusText.className = `status-text status-${websocketType}`;
	socketStatusText.textContent = websocketText;
	socketStatusText.classList.toggle('is-waiting-message', bridgeStateManager.isSocketWaitingMessage(websocketType, websocketText));
}

// 将快照内容渲染到页面。
function applyBridgeStatus(snapshot: ConnectionStatusSnapshot): void {
	setStatus(snapshot.bridgeType, snapshot.bridgeText, snapshot.websocketType, snapshot.websocketText);
}

// 快照过期阈值：超过此时长未更新则视为历史遗留数据，不予展示。
const STALE_STATUS_MS = 3000;

function isFreshStatusSnapshot(snapshot: ConnectionStatusSnapshot): boolean {
	const updatedAt = new Date(snapshot.updatedAt).getTime();
	const age = Date.now() - updatedAt;
	return Number.isFinite(updatedAt) && age >= 0 && age <= STALE_STATUS_MS;
}

// 启动连接状态实时刷新，并在设置页打开时使用新鲜的持久化快照回退。
function startStatusMonitor(): void {
	const snapshot = readConnectionStatus();
	if (isConnectionStatusSnapshot(snapshot) && isFreshStatusSnapshot(snapshot)) {
		applyBridgeStatus(snapshot);
	}

	try {
		eda.sys_MessageBus.subscribe(MCP_CONNECTION_STATUS_CHANGED_TOPIC, (message: unknown) => {
			if (isConnectionStatusSnapshot(message) && isFreshStatusSnapshot(message)) {
				applyBridgeStatus(message);
			}
		});
	}
	catch (error: unknown) {
		const message = toSafeErrorMessage(error);
		writeSettingsWarningLog('settings.status.subscribe.failed', BRIDGE_STATUS_TEXT.settings.statusInitFailed, message, message, 'settings_status_subscribe_failed');
	}
}

// 保存服务端配置，并通知桥接进程应用新地址。
async function saveServerConfig(): Promise<void> {
	const input = getElement('serverUrl', HTMLInputElement, '输入');
	const button = getElement('saveButton', HTMLButtonElement, '按钮');
	if (button.disabled) {
		return;
	}

	savingServerConfig = true;
	syncSaveButtonState();

	try {
		const normalizedUrl = normalizeMcpUrl(input.value);
		await saveConfiguredMcpUrl(normalizedUrl);
		savedServerUrlValue = normalizedUrl;
		input.value = normalizedUrl;
		try {
			eda.sys_MessageBus.publish(getMcpServerUrlChangedTopic(), normalizedUrl);
		}
		catch (error: unknown) {
			const message = toSafeErrorMessage(error);
			writeSettingsWarningLog('settings.config.publish.failed', BRIDGE_STATUS_TEXT.settings.settingsPublishFailedSummary, message, message, 'settings_publish_failed');
		}
		showConfigToast(BRIDGE_STATUS_TEXT.settings.configSaved, ESYS_ToastMessageType.SUCCESS);
	}
	catch (error: unknown) {
		showConfigToast(`保存失败：${toSafeErrorMessage(error)}`, ESYS_ToastMessageType.ERROR);
	}
	finally {
		savingServerConfig = false;
		syncSaveButtonState();
	}
}

// 初始化页面事件与默认值。
function bootstrapPage(): void {
	const button = getElement('saveButton', HTMLButtonElement, '按钮');
	const input = getElement('serverUrl', HTMLInputElement, '输入');
	savedServerUrlValue = getConfiguredMcpUrl() || DEFAULT_MCP_WS_URL;
	input.value = savedServerUrlValue;
	syncSaveButtonState();

	button.addEventListener('click', () => {
		void saveServerConfig();
	});

	input.addEventListener('input', () => {
		syncSaveButtonState();
	});

	try {
		normalizeMcpUrl(input.value);
		setStatus('connecting', '–', 'connecting', '–');
		try {
			startStatusMonitor();
		}
		catch (error: unknown) {
			const message = toSafeErrorMessage(error);
			writeSettingsWarningLog('settings.status.init.failed', BRIDGE_STATUS_TEXT.settings.settingsInitFailedSummary, message, message, 'settings_init_failed');
			setStatus('error', BRIDGE_STATUS_TEXT.settings.statusInitFailed, 'error', message);
		}
	}
	catch (error: unknown) {
		const message = toSafeErrorMessage(error);
		writeSettingsWarningLog('settings.config.invalid', BRIDGE_STATUS_TEXT.settings.settingsConfigInvalidSummary, message, message, 'settings_config_invalid');
		setStatus('error', BRIDGE_STATUS_TEXT.settings.configInvalid, 'error', message);
	}
}

bootstrapPage();
