/**
 * ------------------------------------------------------------------------
 * 名称：Bridge 通用工具
 * 说明：提供桥接连接、任务执行与状态同步共用的工具函数。
 * 作者：Lion
 * 邮箱：chengbin@3578.cn
 * 日期：2026-03-12
 * 备注：仅包含与业务无关的基础能力。
 * ------------------------------------------------------------------------
 */

/**
 * 判断输入是否为普通对象。
 * @param value 待判断值。
 * @returns 是否为普通对象记录。
 */
export function isPlainObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Resolve the EDA global in both browser-global layouts used by EasyEDA clients. */
export function getEdaRuntime(): Record<string, unknown> | undefined {
	if (typeof eda !== 'undefined' && isPlainObjectRecord(eda))
		return eda as unknown as Record<string, unknown>;
	const globalRuntime = (globalThis as unknown as { eda?: unknown }).eda;
	if (isPlainObjectRecord(globalRuntime))
		return globalRuntime;
	return undefined;
}

const PRESERVE_BOUNDED_ARRAY = Symbol('preserveBoundedArray');

/** Mark a handler-owned, already bounded array so final bridge serialization keeps its declared limit. */
export function preserveBoundedArray<T>(values: T[]): T[] {
	Object.defineProperty(values, PRESERVE_BOUNDED_ARRAY, { value: true });
	return values;
}

function shouldPreserveBoundedArray(value: unknown[]): boolean {
	return (value as unknown as Record<symbol, unknown>)[PRESERVE_BOUNDED_ARRAY] === true;
}

/** Read primitive state through a public synchronous SDK getter. */
export function getSyncState<T>(obj: unknown, method: string, fallback: T): T {
	try {
		const fn = (obj as Record<string, unknown>)?.[method];
		if (typeof fn === 'function') {
			const result: unknown = (fn as () => unknown).call(obj);
			return result != null ? (result as T) : fallback;
		}
	}
	catch {
		// State reads are best-effort; callers receive the supplied fallback.
	}
	return fallback;
}

/**
 * 将未知异常转换为可读文本。
 * @param error 原始异常对象。
 * @returns 安全文本。
 */
export function toSafeErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * 解析并校验整数参数。
 * @param value 输入值。
 * @param defaultValue 默认值。
 * @param min 最小值。
 * @param max 最大值。
 * @returns 合法整数。
 */
export function parseBoundedIntegerValue(value: unknown, defaultValue: number, min: number, max: number): number {
	if (typeof value !== 'number' || !Number.isInteger(value)) {
		return defaultValue;
	}

	if (value < min || value > max) {
		throw new Error(`整数参数超出范围，允许区间: ${min}-${max}。`);
	}

	return value;
}

/**
 * 将 ASCII 字符串编码为 Base64。
 * @param value 输入 ASCII 字符串。
 * @returns Base64 编码结果。
 */
export function encodeAsciiToBase64(value: string): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
	let output = '';
	for (let index = 0; index < value.length; index += 3) {
		const first = value.charCodeAt(index) & 0xFF;
		const secondExists = index + 1 < value.length;
		const thirdExists = index + 2 < value.length;
		const second = secondExists ? value.charCodeAt(index + 1) & 0xFF : 0;
		const third = thirdExists ? value.charCodeAt(index + 2) & 0xFF : 0;

		const combined = (first << 16) | (second << 8) | third;
		output += chars[(combined >> 18) & 0x3F];
		output += chars[(combined >> 12) & 0x3F];
		output += secondExists ? chars[(combined >> 6) & 0x3F] : '=';
		output += thirdExists ? chars[combined & 0x3F] : '=';
	}

	return output;
}

/**
 * 同步序列化任意值。
 * @param value 输入值。
 * @param depth 当前递归层级。
 * @param seen 已访问对象集合。
 * @returns 可 JSON 序列化值。
 */
export function toSerializable(value: unknown, depth = 0, seen?: WeakSet<object>): unknown {
	if (value === null || value === undefined) {
		return value;
	}

	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		return value;
	}

	if (typeof value === 'bigint') {
		return value.toString();
	}

	if (typeof value === 'function') {
		const functionName = (value as { name?: string }).name;
		return `[Function ${typeof functionName === 'string' && functionName.length > 0 ? functionName : 'anonymous'}]`;
	}

	if (depth >= 4) {
		return '[MaxDepthExceeded]';
	}

	const tracked = seen ?? new WeakSet<object>();
	if (typeof value === 'object') {
		if (tracked.has(value as object)) {
			return '[Circular]';
		}
		tracked.add(value as object);
	}

	if (Array.isArray(value)) {
		const items = shouldPreserveBoundedArray(value) ? value : value.slice(0, 120);
		return items.map(item => toSerializable(item, depth + 1, tracked));
	}

	if (value instanceof Date) {
		return value.toISOString();
	}

	if (isPlainObjectRecord(value)) {
		const output: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(value)) {
			output[key] = toSerializable(child, depth + 1, tracked);
		}
		return output;
	}

	return String(value);
}

// 判断是否为 Blob 或 File。
function isBlobLike(value: unknown): value is Blob {
	return typeof Blob !== 'undefined' && value instanceof Blob;
}

// 将 Blob/File 序列化为纯对象。
async function serializeBlobLike(value: Blob): Promise<Record<string, unknown>> {
	const blobLike = value as Blob & { name?: unknown; lastModified?: unknown };
	const output: Record<string, unknown> = {
		kind: 'blob',
		size: blobLike.size,
		type: blobLike.type,
		text: await blobLike.text(),
	};

	if (typeof blobLike.name === 'string' && blobLike.name.length > 0) {
		output.name = blobLike.name;
	}

	if (typeof blobLike.lastModified === 'number' && Number.isFinite(blobLike.lastModified)) {
		output.lastModified = blobLike.lastModified;
	}

	return output;
}

/**
 * 异步序列化任意值。
 * @param value 输入值。
 * @param depth 当前递归层级。
 * @param seen 已访问对象集合。
 * @returns 可 JSON 序列化值。
 */
export async function toSerializableAsync(value: unknown, depth = 0, seen?: WeakSet<object>): Promise<unknown> {
	if (value === null || value === undefined) {
		return value;
	}

	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		return value;
	}

	if (typeof value === 'bigint') {
		return value.toString();
	}

	if (typeof value === 'function') {
		const functionName = (value as { name?: string }).name;
		return `[Function ${typeof functionName === 'string' && functionName.length > 0 ? functionName : 'anonymous'}]`;
	}

	if (depth >= 4) {
		return '[MaxDepthExceeded]';
	}

	if (isBlobLike(value)) {
		return await serializeBlobLike(value);
	}

	const tracked = seen ?? new WeakSet<object>();
	if (typeof value === 'object') {
		if (tracked.has(value as object)) {
			return '[Circular]';
		}
		tracked.add(value as object);
	}

	if (Array.isArray(value)) {
		const items = shouldPreserveBoundedArray(value) ? value : value.slice(0, 120);
		return await Promise.all(items.map(item => toSerializableAsync(item, depth + 1, tracked)));
	}

	if (value instanceof Date) {
		return value.toISOString();
	}

	if (isPlainObjectRecord(value)) {
		const output: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(value)) {
			output[key] = await toSerializableAsync(child, depth + 1, tracked);
		}
		return output;
	}

	return String(value);
}

/**
 * 安全调用异步函数。
 * @param executor 异步函数。
 * @returns 成功结果或 undefined。
 */
export async function safeCall<T>(executor: () => Promise<T>): Promise<T | undefined> {
	try {
		return await executor();
	}
	catch {
		return undefined;
	}
}
