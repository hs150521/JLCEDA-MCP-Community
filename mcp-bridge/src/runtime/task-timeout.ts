import { resolveContractTimeoutMs } from '../bridge/bridge-contract.ts';

export class BridgeTaskTimeoutError extends Error {
	public constructor(
		path: string,
		public readonly timeoutMs: number,
		public readonly backgroundSettled?: Promise<void>,
		message = `Bridge task timed out after ${String(timeoutMs)}ms: ${path}`,
	) {
		super(message);
		this.name = 'BridgeTaskTimeoutError';
	}
}

export class BridgeTaskQuarantine {
	private active: { path: string; startedAt: number; settled: Promise<void>; requiresHostRestart?: boolean } | undefined;

	public getActive(): { path: string; startedAt: number; requiresHostRestart?: boolean } | undefined {
		return this.active;
	}

	public enter(path: string, settled: Promise<void>, mayMutate = true): void {
		if (!mayMutate || this.requiresHostRestart())
			return;
		const quarantine = { path, startedAt: Date.now(), settled };
		this.active = quarantine;
		void settled.then(() => {
			if (this.active === quarantine) {
				this.active = undefined;
			}
		});
	}

	public requireHostRestart(path: string): void {
		// The native RPC has returned, but its EDA-side mutation may still commit.
		// Only unloading this host runtime can release this permanent barrier.
		this.active = { path, startedAt: Date.now(), settled: new Promise<void>(() => {}), requiresHostRestart: true };
	}

	public requiresHostRestart(): boolean {
		return this.active?.requiresHostRestart === true;
	}

	public waitForSettlement(): Promise<void> | undefined {
		return this.active?.settled;
	}
}

export function requiresHostRestartForResult(path: string, payload: unknown, result: unknown): boolean {
	if (!result || typeof result !== 'object' || Array.isArray(result)) {
		return false;
	}
	const response = result as Record<string, unknown>;
	if (path === '/bridge/jlceda/footprint/save'
		|| path === '/bridge/jlceda/pcb/connectivity'
		|| path === '/bridge/jlceda/board/setup'
		|| path === '/bridge/jlceda/editor/navigate'
		|| path === '/bridge/jlceda/pcb/documents-manage'
		|| path === '/bridge/jlceda/pcb/component-edit'
		|| path === '/bridge/jlceda/pcb/pour-manage'
		|| path === '/bridge/jlceda/pcb/routing-edit'
		|| path === '/bridge/jlceda/pcb/board-outline-manage'
		|| path === '/bridge/jlceda/pcb/region-manage'
		|| path === '/bridge/jlceda/pcb/text-manage'
		|| path === '/bridge/jlceda/pcb/layer-manage'
		|| path === '/bridge/jlceda/schematic/connectivity'
		|| path === '/bridge/jlceda/schematic/component-edit'
		|| path === '/bridge/jlceda/schematic/wire-manage'
		|| path === '/bridge/jlceda/schematic/text-manage'
		|| path === '/bridge/jlceda/netlabel/place'
		|| path === '/bridge/jlceda/component/place/start'
		|| path === '/bridge/jlceda/component/place/check'
		|| path === '/bridge/jlceda/component/place-auto') {
		return response.ok === false
			&& response.commitUnknown === true
			&& response.nativeCallSettled === false;
	}
	if (path !== '/bridge/jlceda/api/invoke'
		|| !payload || typeof payload !== 'object' || Array.isArray(payload)) {
		return false;
	}
	if (response.commitUnknown === true && response.nativeCallSettled === false)
		return true;
	const apiFullName = (payload as Record<string, unknown>).apiFullName;
	return typeof apiFullName === 'string'
		&& ['eda.pcb_document.autolayout', 'eda.pcb_document.autorouting'].includes(apiFullName.trim().toLowerCase())
		&& response.ok === false
		&& response.commitState === 'unknown'
		&& response.retryBlocked === true;
}

export interface TimedTask<T> {
	result: Promise<T>;
	settled: Promise<void>;
}

export function resolveBridgeTaskTimeoutMs(path: string, payload: unknown): number {
	return resolveContractTimeoutMs(path, payload);
}

export function startTimedTask<T>(task: Promise<T>, path: string, timeoutMs: number): TimedTask<T> {
	let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;
	const settled = task.then(
		() => undefined,
		() => undefined,
	);
	const result = Promise.race([
		task,
		new Promise<T>((_resolve, reject) => {
			timeoutId = globalThis.setTimeout(() => {
				reject(new BridgeTaskTimeoutError(path, timeoutMs));
			}, timeoutMs);
		}),
	]).finally(() => {
		if (timeoutId !== undefined) {
			globalThis.clearTimeout(timeoutId);
		}
	});

	return { result, settled };
}
