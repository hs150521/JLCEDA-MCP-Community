import { isPlainObjectRecord } from '../utils';

const DEFAULT_BRIDGE_TASK_TIMEOUT_MS = 25_000;
const API_TASK_DEFAULT_TIMEOUT_MS = 15_000;
const API_TASK_MIN_TIMEOUT_MS = 1_000;
const API_TASK_MAX_TIMEOUT_MS = 120_000;
const EXTENDED_READ_TASK_DEFAULT_TIMEOUT_MS = 60_000;
const EXTENDED_READ_TASK_MIN_TIMEOUT_MS = 5_000;
const STANDARD_READ_TASK_DEFAULT_TIMEOUT_MS = 30_000;
const EXTENDED_READ_TIMEOUT_PATHS = new Set([
	'/bridge/jlceda/pcb/drc-check',
	'/bridge/jlceda/schematic/drc-check',
	'/bridge/jlceda/netlist/compare',
	'/bridge/jlceda/design/compare',
	'/bridge/jlceda/design/archive-export',
	'/bridge/jlceda/manufacture/export',
	'/bridge/jlceda/pcb/document',
	'/bridge/jlceda/schematic/document',
	'/bridge/jlceda/canvas/snapshot',
	'/bridge/jlceda/library/sources',
	'/bridge/jlceda/library/classification-query',
	'/bridge/jlceda/library/preview',
	'/bridge/jlceda/workspace/query',
	'/bridge/jlceda/net/query-pcb',
]);
const STANDARD_READ_TIMEOUT_PATHS = new Set([
	'/bridge/jlceda/canvas/snapshot',
	'/bridge/jlceda/library/sources',
	'/bridge/jlceda/library/classification-query',
	'/bridge/jlceda/library/preview',
	'/bridge/jlceda/workspace/query',
	'/bridge/jlceda/design/source-export',
]);
const CONFIGURABLE_TIMEOUT_PATHS = new Set([
	'/bridge/jlceda/api/invoke',
	'/bridge/jlceda/context',
	...EXTENDED_READ_TIMEOUT_PATHS,
	...STANDARD_READ_TIMEOUT_PATHS,
]);

export class BridgeTaskTimeoutError extends Error {
	public constructor(
		path: string,
		timeoutMs: number,
		public readonly backgroundSettled?: Promise<void>,
		message = `Bridge task timed out after ${String(timeoutMs)}ms: ${path}`,
	) {
		super(message);
		this.name = 'BridgeTaskTimeoutError';
	}
}

export class BridgeTaskQuarantine {
	private active: { path: string; startedAt: number } | undefined;

	public getActive(): { path: string; startedAt: number } | undefined {
		return this.active;
	}

	public enter(path: string, settled: Promise<void>): void {
		const quarantine = { path, startedAt: Date.now() };
		this.active = quarantine;
		void settled.then(() => {
			if (this.active === quarantine) {
				this.active = undefined;
			}
		});
	}
}

export interface TimedTask<T> {
	result: Promise<T>;
	settled: Promise<void>;
}

export function resolveBridgeTaskTimeoutMs(path: string, payload: unknown): number {
	if (!CONFIGURABLE_TIMEOUT_PATHS.has(path)) {
		return DEFAULT_BRIDGE_TASK_TIMEOUT_MS;
	}

	if (!isPlainObjectRecord(payload) || payload.timeoutMs === undefined) {
		if (STANDARD_READ_TIMEOUT_PATHS.has(path))
			return STANDARD_READ_TASK_DEFAULT_TIMEOUT_MS;
		if (EXTENDED_READ_TIMEOUT_PATHS.has(path))
			return EXTENDED_READ_TASK_DEFAULT_TIMEOUT_MS;
		return API_TASK_DEFAULT_TIMEOUT_MS;
	}

	const timeoutMs = Number(payload.timeoutMs);
	const minimum = EXTENDED_READ_TIMEOUT_PATHS.has(path) ? EXTENDED_READ_TASK_MIN_TIMEOUT_MS : API_TASK_MIN_TIMEOUT_MS;
	if (!Number.isInteger(timeoutMs) || timeoutMs < minimum || timeoutMs > API_TASK_MAX_TIMEOUT_MS) {
		throw new RangeError(`timeoutMs 必须是 ${String(minimum)} 到 ${String(API_TASK_MAX_TIMEOUT_MS)} 之间的整数。`);
	}

	return timeoutMs;
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
