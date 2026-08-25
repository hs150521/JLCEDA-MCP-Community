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
export const MCP_CONNECTION_STATUS_CHANGED_TOPIC = 'jlc_mcp_connection_status_changed';
let lastPersistedSnapshotSignature = '';
let inFlightSnapshotSignature = '';
let pendingSnapshot: ConnectionStatusSnapshot | undefined;
let persistenceRetryTimer: ReturnType<typeof globalThis.setTimeout> | undefined;

interface ExtensionStorage {
	getExtensionUserConfig?: (key: string) => unknown;
	setExtensionUserConfig?: (key: string, value: unknown) => unknown;
}

interface ExtensionMessageBus {
	publish?: (topic: string, message: unknown) => unknown;
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
	const signature = JSON.stringify({
		bridgeType: snapshot.bridgeType,
		bridgeText: snapshot.bridgeText,
		websocketType: snapshot.websocketType,
		websocketText: snapshot.websocketText,
		updatedAt: snapshot.updatedAt,
	});

	try {
		const runtime = getEdaRuntime() as { sys_MessageBus?: ExtensionMessageBus };
		void Promise.resolve(runtime.sys_MessageBus?.publish?.(MCP_CONNECTION_STATUS_CHANGED_TOPIC, snapshot)).catch(() => undefined);
	}
	catch {
		// The settings iframe can still read the last persisted snapshot.
	}

	if (!storage || typeof storage.setExtensionUserConfig !== 'function'
		|| signature === lastPersistedSnapshotSignature
		|| signature === inFlightSnapshotSignature
		|| (pendingSnapshot !== undefined && signature === snapshotSignature(pendingSnapshot))) {
		return;
	}
	pendingSnapshot = snapshot;
	persistConnectionStatus(storage);
}

function snapshotSignature(snapshot: ConnectionStatusSnapshot): string {
	return JSON.stringify({
		bridgeType: snapshot.bridgeType,
		bridgeText: snapshot.bridgeText,
		websocketType: snapshot.websocketType,
		websocketText: snapshot.websocketText,
		updatedAt: snapshot.updatedAt,
	});
}

function schedulePersistenceRetry(storage: ExtensionStorage): void {
	if (persistenceRetryTimer !== undefined) {
		return;
	}
	persistenceRetryTimer = globalThis.setTimeout(() => {
		persistenceRetryTimer = undefined;
		persistConnectionStatus(storage);
	}, 1000);
}

function persistConnectionStatus(storage: ExtensionStorage): void {
	if (inFlightSnapshotSignature || !pendingSnapshot || typeof storage.setExtensionUserConfig !== 'function') {
		return;
	}

	const snapshot = pendingSnapshot;
	const signature = snapshotSignature(snapshot);
	pendingSnapshot = undefined;
	inFlightSnapshotSignature = signature;
	try {
		// Serialize writes so an older asynchronous write cannot overwrite a newer
		// status snapshot. Failed writes are retried because EDA storage can appear
		// before its backing runtime is ready.
		void Promise.resolve(storage.setExtensionUserConfig(MCP_CONNECTION_STATUS_KEY, snapshot)).then(
			() => {
				lastPersistedSnapshotSignature = signature;
			},
			() => {
				if (!pendingSnapshot) {
					pendingSnapshot = snapshot;
				}
			},
		).finally(() => {
			inFlightSnapshotSignature = '';
			if (pendingSnapshot && snapshotSignature(pendingSnapshot) === signature) {
				schedulePersistenceRetry(storage);
			}
			else {
				persistConnectionStatus(storage);
			}
		});
	}
	catch {
		inFlightSnapshotSignature = '';
		if (!pendingSnapshot) {
			pendingSnapshot = snapshot;
		}
		schedulePersistenceRetry(storage);
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
