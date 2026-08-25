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
	private active: { path: string; startedAt: number; settled: Promise<void> } | undefined;

	public getActive(): { path: string; startedAt: number } | undefined {
		return this.active;
	}

	public enter(path: string, settled: Promise<void>): void {
		const quarantine = { path, startedAt: Date.now(), settled };
		this.active = quarantine;
		void settled.then(() => {
			if (this.active === quarantine) {
				this.active = undefined;
			}
		});
	}

	public waitForSettlement(): Promise<void> | undefined {
		return this.active?.settled;
	}
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
