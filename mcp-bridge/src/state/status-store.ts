/**
 * ------------------------------------------------------------------------
 * 名称：桥接状态存储
 * 说明：管理页面状态快照、活动状态快照与上下文作用域键。
 * 作者：Lion
 * 邮箱：chengbin@3578.cn
 * 日期：2026-03-12
 * 备注：为页面 UI 和桥接运行时提供共享状态。
 * ------------------------------------------------------------------------
 */

import { getEdaRuntime, isPlainObjectRecord } from '../utils';

// 固定连接状态存储键，与上下文无关，设置页直接轮询此键。
const MCP_CONNECTION_STATUS_KEY = 'jlc_mcp_connection_status';

interface ExtensionStorage {
	getExtensionUserConfig?: (key: string) => unknown;
	setExtensionUserConfig?: (key: string, value: unknown) => unknown;
}

function getExtensionStorage(): ExtensionStorage | undefined {
	try {
		const runtime = getEdaRuntime();
		if (!isPlainObjectRecord(runtime) || !isPlainObjectRecord(runtime.sys_Storage)) {
			return undefined;
		}
		return runtime.sys_Storage as ExtensionStorage;
	}
	catch {
		return undefined;
	}
}

export type ConnectionStatusType = 'connecting' | 'connected' | 'error';

/**
 * 连接状态快照：仅包含设置页两个胶囊所需的展示信息，由服务端数据驱动。
 */
export interface ConnectionStatusSnapshot {
	bridgeType: ConnectionStatusType;
	bridgeText: string;
	websocketType: ConnectionStatusType;
	websocketText: string;
	updatedAt: string;
}

/**
 * 判断值是否为合法连接状态快照。
 * @param value 待判断值。
 * @returns 是否合法。
 */
export function isConnectionStatusSnapshot(value: unknown): value is ConnectionStatusSnapshot {
	if (!isPlainObjectRecord(value)) {
		return false;
	}
	const validTypes = new Set(['connecting', 'connected', 'error']);
	return validTypes.has(String(value.bridgeType ?? '').trim())
		&& validTypes.has(String(value.websocketType ?? '').trim())
		&& typeof value.bridgeText === 'string'
		&& typeof value.websocketText === 'string'
		&& typeof value.updatedAt === 'string';
}

/**
 * 写入连接状态快照到固定存储键。
 * @param snapshot 状态快照。
 */
export function saveConnectionStatus(snapshot: ConnectionStatusSnapshot): void {
	const storage = getExtensionStorage();
	if (!storage || typeof storage.setExtensionUserConfig !== 'function') {
		return;
	}

	try {
		// EDA may expose the storage object before its backing runtime is ready.
		// Consume both synchronous throws and rejected promises so reconnect logic
		// cannot fail with an unhandled rejection during EDA startup.
		void Promise.resolve(storage.setExtensionUserConfig(MCP_CONNECTION_STATUS_KEY, snapshot)).catch(() => undefined);
	}
	catch {
		// Storage is best-effort; connection state is recomputed on the next tick.
	}
}

/**
 * 读取连接状态快照。
 * @returns 状态快照，不存在或格式非法时返回 undefined。
 */
export function readConnectionStatus(): ConnectionStatusSnapshot | undefined {
	try {
		const storage = getExtensionStorage();
		if (!storage || typeof storage.getExtensionUserConfig !== 'function') {
			return undefined;
		}
		const raw = storage.getExtensionUserConfig(MCP_CONNECTION_STATUS_KEY);
		return isConnectionStatusSnapshot(raw) ? raw : undefined;
	}
	catch {
		return undefined;
	}
}
