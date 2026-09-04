/**
 * ------------------------------------------------------------------------
 * 名称：Bridge 扩展入口
 * 说明：负责扩展激活、桥接客户端启动与对外菜单函数导出。
 * 作者：Lion
 * 邮箱：chengbin@3578.cn
 * 日期：2026-03-09
 * 备注：嘉立创 EDA Bridge 入口文件（客户端模式）。
 * ------------------------------------------------------------------------
 */
import * as extensionConfig from '../extension.json';
import { clearEdaDiagnosticLogs, getEdaLogReport } from './logging/log.ts';
import { restartBridgeServer, startBridgeRuntime, stopBridgeRuntime } from './runtime/bridge-runtime.ts';
import { readConnectionStatus } from './state/status-store.ts';
import { clearDebugLog, getDebugLogReport } from './utils/debug-log.ts';

/**
 * 激活 Bridge 扩展。
 *
 * @param status 扩展激活状态。
 * @param arg 扩展激活附加参数。
 */
// eslint-disable-next-line unused-imports/no-unused-vars
export function activate(status?: 'onStartupFinished', arg?: string): void {
	// 扩展启动后自动拉起桥接服务器。
	startBridgeRuntime();
}

/**
 * 停用扩展
 */
export function deactivate(): void {
	stopBridgeRuntime();
}

/**
 * 重启MCP Bridge服务器
 */
export function restartServer(): void {
	restartBridgeServer();
}

/**
 * 查看连接状态
 */
export function viewConnectionStatus(): void {
	const status = readConnectionStatus();
	const statusText = status
		? `桥接连接：${status.bridgeText}\nWebSocket：${status.websocketText}\n更新时间：${status.updatedAt}`
		: '尚无连接状态。请打开原理图或 PCB 页面后重试。';
	eda.sys_Dialog.showInformationMessage(statusText, 'MCP Bridge 连接状态');
}

/**
 * 打开连接设置页面（服务器模式说明）
 */
export function openSettingsPage(): void {
	void eda.sys_IFrame.openIFrame('/iframe/settings.html', 600, 420, 'jlc-mcp-settings-dialog', { minimizeButton: true, minimizeStyle: 'collapsed' });
}

/**
 * 打开关于信息弹窗。
 */
export function about(): void {
	eda.sys_Dialog.showInformationMessage(
		eda.sys_I18n.text('MCP Bridge (Server Mode)', undefined, undefined, extensionConfig.version),
		eda.sys_I18n.text('About'),
	);
}

/**
 * 查看调试日志。
 */
export function viewDebugLog(): void {
	const log = getEdaLogReport() || getDebugLogReport();
	if (!log) {
		eda.sys_Dialog.showInformationMessage('暂无调试日志', '调试日志');
		return;
	}

	eda.sys_Dialog.showInformationMessage(log, '诊断报告 (最近100条)');
}

/**
 * 清空调试日志。
 */
export function clearDebugLogAction(): void {
	clearDebugLog();
	clearEdaDiagnosticLogs();
	eda.sys_Dialog.showInformationMessage('调试日志已清空', '调试日志');
}
