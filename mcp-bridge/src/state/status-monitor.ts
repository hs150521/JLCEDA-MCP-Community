import type { ConnectionStatusSnapshot } from './status-store.ts';
import {
	isConnectionStatusSnapshot,
	MCP_CONNECTION_STATUS_CHANGED_TOPIC,
	readConnectionStatus,
} from './status-store.ts';

export const CONNECTION_STATUS_STALE_MS = 3000;
export const CONNECTION_STATUS_FALLBACK_POLL_INTERVAL_MS = 1000;

export interface ConnectionStatusMessageBus {
	subscribe?: (topic: string, listener: (message: unknown) => void) => unknown;
}

export interface ConnectionStatusMonitorOptions {
	messageBus?: ConnectionStatusMessageBus;
	onSnapshot: (snapshot: ConnectionStatusSnapshot) => void;
	onSubscribeFailed?: (error: unknown) => void;
	readSnapshot?: () => ConnectionStatusSnapshot | undefined;
	setIntervalFn?: typeof globalThis.setInterval;
	now?: () => number;
}

function isFreshStatusSnapshot(snapshot: ConnectionStatusSnapshot, now: () => number): boolean {
	const updatedAt = new Date(snapshot.updatedAt).getTime();
	const age = now() - updatedAt;
	return Number.isFinite(updatedAt) && age >= 0 && age <= CONNECTION_STATUS_STALE_MS;
}

/**
 * 启动连接状态传递：持久化快照用于初始显示，并且仅在 EDA MessageBus
 * 不可用时作为轮询回退。
 */
export function startConnectionStatusMonitor(options: ConnectionStatusMonitorOptions): void {
	const readSnapshot = options.readSnapshot ?? readConnectionStatus;
	const setIntervalFn = options.setIntervalFn ?? globalThis.setInterval;
	const now = options.now ?? Date.now;
	let fallbackStarted = false;

	const deliverSnapshot = (snapshot: unknown): void => {
		if (isConnectionStatusSnapshot(snapshot) && isFreshStatusSnapshot(snapshot, now)) {
			options.onSnapshot(snapshot);
		}
	};
	const refreshFromStorage = (): void => {
		deliverSnapshot(readSnapshot());
	};
	const startFallbackPolling = (): void => {
		if (fallbackStarted) {
			return;
		}
		fallbackStarted = true;
		setIntervalFn(refreshFromStorage, CONNECTION_STATUS_FALLBACK_POLL_INTERVAL_MS);
	};
	const handleSubscriptionFailure = (error: unknown): void => {
		options.onSubscribeFailed?.(error);
		startFallbackPolling();
	};

	refreshFromStorage();
	if (typeof options.messageBus?.subscribe !== 'function') {
		handleSubscriptionFailure(new Error('EDA MessageBus subscribe API is unavailable'));
		return;
	}

	try {
		void Promise.resolve(options.messageBus.subscribe(MCP_CONNECTION_STATUS_CHANGED_TOPIC, deliverSnapshot)).catch(handleSubscriptionFailure);
	}
	catch (error: unknown) {
		handleSubscriptionFailure(error);
	}
}
