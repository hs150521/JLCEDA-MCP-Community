import { getEdaRuntime, getSyncState, isPlainObjectRecord, isUnknownNativeRpcResult, preserveBoundedArray, toSafeErrorMessage } from '../utils.ts';
import { pcbViaDimensionMode, pcbViaDimensionNormalization } from './pcb-native-normalization.ts';

type PcbConnectivityAction = 'line_create' | 'via_create';
const COORDINATE_EPSILON = 1e-6;

function requiredString(value: unknown, name: string): string {
	if (typeof value !== 'string' || value.trim().length === 0)
		throw new TypeError(`${name} must be a non-empty string.`);
	return value.trim();
}

function requiredNumber(value: unknown, name: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value))
		throw new TypeError(`${name} must be a finite number.`);
	return value;
}

function positiveNumber(value: unknown, name: string): number {
	const number = requiredNumber(value, name);
	if (number <= 0)
		throw new RangeError(`${name} must be positive.`);
	return number;
}

function pcbApi(eda: Record<string, unknown>, name: string, methods: string[]): Record<string, unknown> {
	const api = eda[name];
	if (!isPlainObjectRecord(api) || methods.some(method => typeof api[method] !== 'function'))
		throw new TypeError(`EDA ${name} ${methods.join('/')} API is unavailable. Open a PCB document first.`);
	return api;
}

function sameNumber(actual: unknown, expected: number): boolean {
	return typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) <= COORDINATE_EPSILON;
}

async function verifyNet(api: Record<string, unknown>, net: string): Promise<void> {
	const nets = await (api.getAllNets as () => Promise<unknown>).call(api);
	if (!Array.isArray(nets))
		throw new TypeError('EDA pcb_Net.getAllNets did not return an array.');
	if (!nets.some(item => isPlainObjectRecord(item) && item.net === net))
		throw new TypeError(`PCB network ${net} does not exist on the current page.`);
}

function nativeCreateFailure(action: PcbConnectivityAction, error: unknown): Record<string, unknown> {
	const message = toSafeErrorMessage(error);
	// A timed-out or disconnected RPC can finish inside EDA after it rejects here.
	const commitUnknown = isUnknownNativeRpcResult(message);
	return {
		ok: false,
		action,
		reason: commitUnknown ? 'native_create_result_unknown' : 'native_create_rejected',
		error: message,
		...(commitUnknown ? { commitUnknown: true, readbackRequired: true, nativeCallSettled: false } : {}),
	};
}

async function verifyCopperLayer(api: Record<string, unknown>, layer: number): Promise<void> {
	const layers = await (api.getAllLayers as () => Promise<unknown>).call(api);
	if (!Array.isArray(layers))
		throw new TypeError('EDA pcb_Layer.getAllLayers did not return an array.');
	const selected = layers.find(item => isPlainObjectRecord(item) && item.id === layer);
	if (!isPlainObjectRecord(selected) || (selected.type !== 'SIGNAL' && selected.type !== 'PLANE') || selected.layerStatus === 0 || selected.locked === true)
		throw new TypeError(`PCB layer ${String(layer)} is not an enabled, unlocked copper layer.`);
}

function unknownAfterWrite(
	action: PcbConnectivityAction,
	returnedPrimitiveId: string,
	error: unknown,
): Record<string, unknown> {
	return {
		ok: false,
		action,
		reason: 'post_write_readback_failed',
		error: toSafeErrorMessage(error),
		returnedPrimitiveId,
		commitUnknown: true,
		readbackRequired: true,
		nativeCallSettled: true,
	};
}

interface LineState {
	primitiveId: string;
	net: string;
	layer: number;
	startX: number;
	startY: number;
	endX: number;
	endY: number;
	lineWidth: number;
}

function readLine(raw: unknown): LineState {
	return {
		primitiveId: getSyncState(raw, 'getState_PrimitiveId', ''),
		net: getSyncState(raw, 'getState_Net', ''),
		layer: getSyncState(raw, 'getState_Layer', -1),
		startX: getSyncState(raw, 'getState_StartX', Number.NaN),
		startY: getSyncState(raw, 'getState_StartY', Number.NaN),
		endX: getSyncState(raw, 'getState_EndX', Number.NaN),
		endY: getSyncState(raw, 'getState_EndY', Number.NaN),
		lineWidth: getSyncState(raw, 'getState_LineWidth', Number.NaN),
	};
}

function sameLine(actual: LineState, requested: Omit<LineState, 'primitiveId'>): boolean {
	if (actual.net !== requested.net || actual.layer !== requested.layer || !sameNumber(actual.lineWidth, requested.lineWidth))
		return false;
	const forward = sameNumber(actual.startX, requested.startX) && sameNumber(actual.startY, requested.startY)
		&& sameNumber(actual.endX, requested.endX) && sameNumber(actual.endY, requested.endY);
	const reversed = sameNumber(actual.endX, requested.startX) && sameNumber(actual.endY, requested.startY)
		&& sameNumber(actual.startX, requested.endX) && sameNumber(actual.startY, requested.endY);
	return forward || reversed;
}

function requestedLineInterval(line: LineState, requested: Omit<LineState, 'primitiveId'>): { start: number; end: number; line: LineState } | undefined {
	if (!line.primitiveId || line.net !== requested.net || line.layer !== requested.layer || !sameNumber(line.lineWidth, requested.lineWidth))
		return undefined;
	const dx = requested.endX - requested.startX;
	const dy = requested.endY - requested.startY;
	const length = Math.hypot(dx, dy);
	const ux = dx / length;
	const uy = dy / length;
	const points = [[line.startX, line.startY], [line.endX, line.endY]];
	if (points.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y)
		|| Math.abs((x - requested.startX) * uy - (y - requested.startY) * ux) > COORDINATE_EPSILON)) {
		return undefined;
	}
	const projections = points.map(([x, y]) => (x - requested.startX) * ux + (y - requested.startY) * uy);
	const start = Math.max(0, Math.min(...projections));
	const end = Math.min(length, Math.max(...projections));
	return end - start > COORDINATE_EPSILON ? { start, end, line } : undefined;
}

function coveringLines(lines: LineState[], requested: Omit<LineState, 'primitiveId'>): LineState[] | undefined {
	const length = Math.hypot(requested.endX - requested.startX, requested.endY - requested.startY);
	const intervals = lines.flatMap((line) => {
		const interval = requestedLineInterval(line, requested);
		return interval ? [interval] : [];
	});
	intervals.sort((a, b) => a.start - b.start);
	let covered = 0;
	const result: LineState[] = [];
	for (const interval of intervals) {
		if (interval.start > covered + COORDINATE_EPSILON)
			return undefined;
		if (interval.end > covered) {
			covered = interval.end;
			result.push(interval.line);
		}
		if (covered >= length - COORDINATE_EPSILON)
			return preserveBoundedArray(result);
	}
	return undefined;
}

async function readScopedLines(api: Record<string, unknown>, net: string, layer: number): Promise<LineState[]> {
	const raw = await (api.getAll as (net: string, layer: number) => Promise<unknown>).call(api, net, layer);
	if (!Array.isArray(raw))
		throw new TypeError('EDA pcb_PrimitiveLine.getAll did not return an array.');
	return raw.map(readLine);
}

async function handleLineCreate(payload: Record<string, unknown>, eda: Record<string, unknown>, net: string, allowNewNet: boolean): Promise<unknown> {
	const layer = requiredNumber(payload.layer, 'layer');
	if (!Number.isInteger(layer) || layer <= 0)
		throw new TypeError('layer must be a positive integer PCB layer ID.');
	const startX = requiredNumber(payload.startX, 'startX');
	const startY = requiredNumber(payload.startY, 'startY');
	const endX = requiredNumber(payload.endX, 'endX');
	const endY = requiredNumber(payload.endY, 'endY');
	if (sameNumber(startX, endX) && sameNumber(startY, endY))
		throw new TypeError('A PCB line must have different start and end points.');
	const lineWidth = positiveNumber(payload.lineWidth, 'lineWidth');
	const requested = { net, layer, startX, startY, endX, endY, lineWidth };
	const lineApi = pcbApi(eda, 'pcb_PrimitiveLine', ['create', 'get']);
	const layerApi = pcbApi(eda, 'pcb_Layer', ['getAllLayers']);
	const netApi = allowNewNet ? undefined : pcbApi(eda, 'pcb_Net', ['getAllNets']);
	const preflight = [verifyCopperLayer(layerApi, layer)];
	if (netApi)
		preflight.push(verifyNet(netApi, net));
	await Promise.all(preflight);
	// 仅记录请求的网络与层，用来区分原有铜线和此次原生拆分、合并产生的变化。
	const beforeLines = typeof lineApi.getAll === 'function' ? await readScopedLines(lineApi, net, layer) : undefined;
	let created: unknown;
	try {
		created = await (lineApi.create as (...args: unknown[]) => Promise<unknown>).call(lineApi, net, layer, startX, startY, endX, endY, lineWidth);
	}
	catch (error: unknown) {
		return nativeCreateFailure('line_create', error);
	}
	const returnedPrimitiveId = getSyncState(created, 'getState_PrimitiveId', '');
	if (typeof returnedPrimitiveId !== 'string' || returnedPrimitiveId.length === 0)
		return unknownAfterWrite('line_create', '', 'EDA create returned no primitive ID.');
	try {
		const observed = readLine(await (lineApi.get as (id: string) => Promise<unknown>).call(lineApi, returnedPrimitiveId));
		if (observed.primitiveId === returnedPrimitiveId && sameLine(observed, requested))
			return { ok: true, action: 'line_create', primitiveId: returnedPrimitiveId, ...requested, after: observed, verified: true };
		// 返回完整图元时，它必须属于请求段；拆分后仅 ID 的占位对象仍走覆盖回读。
		const hasReturnedGeometry = observed.net !== '' && observed.layer > 0
			&& [observed.startX, observed.startY, observed.endX, observed.endY, observed.lineWidth].every(Number.isFinite);
		if (observed.primitiveId && hasReturnedGeometry && (observed.primitiveId !== returnedPrimitiveId || !requestedLineInterval(observed, requested))) {
			return { ...unknownAfterWrite('line_create', returnedPrimitiveId, 'EDA returned line differs from the requested net, layer, width, or segment.'), after: observed };
		}
		// 原生布线会在交点拆分线路，或把线路合并到已有铜线。
		// 覆盖回读必须包含此次新增或几何发生变化的有效线路。
		const allApi = pcbApi(eda, 'pcb_PrimitiveLine', ['getAll']);
		const afterLines = await readScopedLines(allApi, net, layer);
		const beforeById = new Map(beforeLines?.map(line => [line.primitiveId, line]));
		const changedLines = beforeLines === undefined
			? []
			: afterLines.filter((line) => {
					const before = beforeById.get(line.primitiveId);
					return (!before || !sameLine(line, before)) && requestedLineInterval(line, requested) !== undefined;
				});
		const lines = coveringLines(afterLines, requested);
		if (!lines || changedLines.length === 0) {
			return { ...unknownAfterWrite('line_create', returnedPrimitiveId, 'EDA line readback has no verified change covering the requested segment.'), after: observed };
		}
		// 覆盖算法可能先选中更长的旧线；同时返回实际变化的有效图元作为核验依据。
		for (const changed of changedLines) {
			if (!lines.some(line => line.primitiveId === changed.primitiveId))
				lines.push(changed);
		}

		return {
			ok: true,
			action: 'line_create',
			primitiveId: lines[0].primitiveId,
			primitiveIds: preserveBoundedArray(lines.map(line => line.primitiveId)),
			returnedPrimitiveId,
			...requested,
			after: { lines },
			normalization: { kind: 'split_or_merged_line', verification: 'requested_segment_covered', changedPrimitiveIds: preserveBoundedArray(changedLines.map(line => line.primitiveId)) },
			verified: true,
		};
	}
	catch (error: unknown) {
		return unknownAfterWrite('line_create', returnedPrimitiveId, error);
	}
}

async function handleViaCreate(payload: Record<string, unknown>, eda: Record<string, unknown>, net: string, allowNewNet: boolean): Promise<unknown> {
	const x = requiredNumber(payload.x, 'x');
	const y = requiredNumber(payload.y, 'y');
	const holeDiameter = positiveNumber(payload.holeDiameter, 'holeDiameter');
	const diameter = positiveNumber(payload.diameter, 'diameter');
	if (diameter <= holeDiameter)
		throw new RangeError('diameter must be larger than holeDiameter.');
	const viaApi = pcbApi(eda, 'pcb_PrimitiveVia', ['create', 'get']);
	if (!allowNewNet)
		await verifyNet(pcbApi(eda, 'pcb_Net', ['getAllNets']), net);
	let created: unknown;
	try {
		created = await (viaApi.create as (...args: unknown[]) => Promise<unknown>).call(viaApi, net, x, y, holeDiameter, diameter);
	}
	catch (error: unknown) {
		return nativeCreateFailure('via_create', error);
	}
	const primitiveId = getSyncState(created, 'getState_PrimitiveId', '');
	if (typeof primitiveId !== 'string' || primitiveId.length === 0)
		return unknownAfterWrite('via_create', '', 'EDA create returned no primitive ID.');
	try {
		const observed = await (viaApi.get as (id: string) => Promise<unknown>).call(viaApi, primitiveId);
		const after = {
			primitiveId: getSyncState(observed, 'getState_PrimitiveId', ''),
			net: getSyncState(observed, 'getState_Net', ''),
			x: getSyncState(observed, 'getState_X', Number.NaN),
			y: getSyncState(observed, 'getState_Y', Number.NaN),
			holeDiameter: getSyncState(observed, 'getState_HoleDiameter', Number.NaN),
			diameter: getSyncState(observed, 'getState_Diameter', Number.NaN),
		};
		const holeMode = pcbViaDimensionMode(after.holeDiameter, holeDiameter);
		const diameterMode = pcbViaDimensionMode(after.diameter, diameter);
		const verified = after.primitiveId === primitiveId && after.net === net
			&& sameNumber(after.x, x) && sameNumber(after.y, y)
			&& holeMode !== undefined && diameterMode !== undefined && after.diameter > after.holeDiameter;
		if (!verified)
			return { ...unknownAfterWrite('via_create', primitiveId, 'EDA via readback differs from the requested net or geometry.'), after };
		return { ok: true, action: 'via_create', ...after, after, ...pcbViaDimensionNormalization(after, { holeDiameter, diameter }), verified: true };
	}
	catch (error: unknown) {
		return unknownAfterWrite('via_create', primitiveId, error);
	}
}

export async function handlePcbConnectivityTask(payload: unknown): Promise<unknown> {
	if (!isPlainObjectRecord(payload))
		throw new TypeError('pcb_connectivity_action payload must be an object.');
	const action = payload.action;
	if (action !== 'line_create' && action !== 'via_create')
		throw new TypeError('action must be line_create or via_create.');
	const net = requiredString(payload.net, 'net');
	if (payload.allowNewNet !== undefined && typeof payload.allowNewNet !== 'boolean')
		throw new TypeError('allowNewNet must be a boolean.');
	const allowNewNet = payload.allowNewNet === true;
	const eda = getEdaRuntime();
	if (!eda)
		throw new TypeError('EDA runtime is unavailable.');
	return action === 'line_create'
		? handleLineCreate(payload, eda, net, allowNewNet)
		: handleViaCreate(payload, eda, net, allowNewNet);
}
