import type { FootprintIdentity } from '../bridge/editor-context.ts';
import type { FootprintPrimitiveKind, FootprintPrimitiveState } from './footprint-primitive-state.ts';
import { assertFootprintIdentity, readFootprintIdentity } from '../bridge/editor-context.ts';
import { getEdaRuntime, isPlainObjectRecord, preserveBoundedJson, toSafeErrorMessage } from '../utils.ts';
import { FOOTPRINT_PRIMITIVE_KINDS, readFootprintPrimitiveState } from './footprint-primitive-state.ts';

const SCOPE = 'current_footprint_document';
const MAX_PRIMITIVES = 10000;
const MAX_RESULT_BYTES = 8 * 1024 * 1024;
const MODULES: Record<FootprintPrimitiveKind, string> = { pad: 'pcb_PrimitivePad', via: 'pcb_PrimitiveVia', line: 'pcb_PrimitiveLine', arc: 'pcb_PrimitiveArc', polyline: 'pcb_PrimitivePolyline', string: 'pcb_PrimitiveString', attribute: 'pcb_PrimitiveAttribute' };

function checkedIds(value: unknown, kind: FootprintPrimitiveKind): string[] {
	if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !id.trim()) || new Set(value).size !== value.length)
		throw new TypeError(`EDA footprint ${kind} ID inventory is not readable.`);
	return value as string[];
}

/** 七类全量原生图元和 ID 清单匹配后才返回 complete:true；不截断恢复快照。 */
export async function handleFootprintReadTask(payload: unknown): Promise<unknown> {
	if (payload !== undefined && payload !== null && (!isPlainObjectRecord(payload) || Object.keys(payload).some(key => key !== 'timeoutMs')))
		throw new TypeError('footprint_read does not accept filters and always reads all seven primitive kinds.');
	const runtime = getEdaRuntime();
	if (!runtime)
		throw new TypeError('EDA runtime is unavailable.');
	let identity: FootprintIdentity | undefined;
	let failedKind: FootprintPrimitiveKind | undefined;
	const snapshot: Record<string, unknown> = {};
	let primitiveCount = 0;
	try {
		identity = await readFootprintIdentity(runtime);
		const allIds = new Set<string>();
		for (const kind of FOOTPRINT_PRIMITIVE_KINDS) {
			failedKind = kind;
			const api = runtime[MODULES[kind]];
			if (!isPlainObjectRecord(api) || typeof api.getAll !== 'function' || typeof api.getAllPrimitiveId !== 'function')
				throw new TypeError(`EDA footprint ${MODULES[kind]}.getAll/getAllPrimitiveId is unavailable.`);
			const [rawIds, raw] = await Promise.all([api.getAllPrimitiveId(), api.getAll()]);
			await assertFootprintIdentity(runtime, identity);
			const ids = checkedIds(rawIds, kind);
			if (!Array.isArray(raw) || raw.length !== ids.length)
				throw new TypeError(`EDA footprint ${kind} objects do not match the complete ID inventory.`);
			if (primitiveCount + ids.length > MAX_PRIMITIVES)
				throw new RangeError('EDA footprint snapshot exceeds the complete primitive budget.');
			const requestedIds = new Set(ids);
			const states: FootprintPrimitiveState[] = raw.map(item => readFootprintPrimitiveState(item, kind));
			for (const state of states) {
				if (!requestedIds.delete(state.primitiveId) || allIds.has(state.primitiveId))
					throw new TypeError(`EDA footprint ${kind} object IDs differ from the complete inventory.`);
				allIds.add(state.primitiveId);
			}
			if (requestedIds.size)
				throw new TypeError(`EDA footprint ${kind} object IDs differ from the complete inventory.`);
			snapshot[`${kind}s`] = states;
			snapshot[`${kind}Count`] = states.length;
			primitiveCount += states.length;
		}
		await assertFootprintIdentity(runtime, identity);
		const result = { ok: true, scope: SCOPE, complete: true, ...identity, ...snapshot, primitiveCount };
		if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_RESULT_BYTES)
			throw new RangeError('EDA footprint snapshot exceeds the complete transport budget.');
		return preserveBoundedJson(result);
	}
	catch (error: unknown) {
		return { ok: false, scope: SCOPE, complete: false, ...identity, reason: 'footprint_read_incomplete', failedKind, error: toSafeErrorMessage(error) };
	}
}
