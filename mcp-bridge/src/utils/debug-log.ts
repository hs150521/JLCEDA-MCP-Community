/**
 * ------------------------------------------------------------------------
 * 名称：调试日志工具
 * 说明：将调试日志写入用户可访问的文件
 * 作者：Debug Helper
 * 日期：2026-07-02
 * ------------------------------------------------------------------------
 */

import { BRIDGE_BUILD_WATERMARK } from '../build-info.ts';

let logBuffer: string[] = [];
const MAX_BUFFER_SIZE = 100;
const DEBUG_REPORT_TEXT_LIMIT = 240;

function persistDebugLog(value: unknown): void {
	void Promise.resolve()
		.then(() => eda.sys_Storage.setExtensionUserConfig('mcp_bridge_debug_log', value))
		.catch((error: unknown) => {
			console.error('Failed to write debug log to storage:', error);
		});
}

/**
 * 写入调试日志
 */
export function debugLog(message: string, ...args: unknown[]): void {
	const timestamp = new Date().toISOString();
	const argsStr = args.map((arg) => {
		try {
			return typeof arg === 'object' ? JSON.stringify(arg) : String(arg);
		}
		catch {
			return String(arg);
		}
	}).join(' ');

	const logLine = `[${timestamp}] [${BRIDGE_BUILD_WATERMARK}] ${message} ${argsStr}`;

	// 输出到控制台
	// eslint-disable-next-line no-console
	console.log(logLine);

	// 添加到缓冲区
	logBuffer.push(logLine);
	if (logBuffer.length > MAX_BUFFER_SIZE) {
		logBuffer.shift();
	}

	// 尝试写入EDA存储
	persistDebugLog({
		timestamp: Date.now(),
		log: logBuffer.join('\n'),
	});
}

/**
 * 获取所有日志
 */
export function getDebugLog(): string {
	// 先尝试从存储读取
	try {
		const stored = eda.sys_Storage.getExtensionUserConfig('mcp_bridge_debug_log');
		if (stored && typeof stored === 'object' && 'log' in stored && typeof stored.log === 'string') {
			return stored.log;
		}
	}
	catch {
		// 忽略
	}

	// 回退到内存缓冲区
	return logBuffer.join('\n');
}

/**
 * 获取 EDA 界面使用的通用调试摘要。
 */
export function getDebugLogReport(): string {
	const detail = getDebugLog();
	return detail
		.split('\n')
		.map(line => line.length > DEBUG_REPORT_TEXT_LIMIT ? `${line.slice(0, DEBUG_REPORT_TEXT_LIMIT)}...` : line)
		.join('\n');
}

/**
 * 清空日志
 */
export function clearDebugLog(): void {
	logBuffer = [];
	persistDebugLog(null);
}
