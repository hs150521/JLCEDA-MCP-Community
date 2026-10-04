// EDA Pro 3.2.181 回读曾将轮廓坐标舍入至四位小数；允许每个坐标
// 半个最小单位（0.00005 mil），圆弧角度仍采用原有的 1e-6 度容差。
const COORDINATE_TOLERANCE_MIL = 0.00005;
const FLOATING_POINT_MARGIN = 1e-9;
const ANGLE_TOLERANCE = 1e-6;

type Point = [number, number];
type SegmentKind = 'L' | 'ARC' | 'CARC' | 'C';

interface Segment {
	kind: SegmentKind;
	start: Point;
	end: Point;
	angle?: number;
	controls?: [Point, Point];
}

export interface PcbPolygonComparison {
	equivalent: boolean;
	normalized: boolean;
	reversed: boolean;
	cyclicShift: number;
	precisionAdjusted: boolean;
	coordinateToleranceMil: number;
}

function nearCoordinate(actual: number, wanted: number): boolean {
	return Math.abs(actual - wanted) <= COORDINATE_TOLERANCE_MIL + FLOATING_POINT_MARGIN;
}

function nearPoint(actual: Point, wanted: Point): boolean {
	return nearCoordinate(actual[0], wanted[0]) && nearCoordinate(actual[1], wanted[1]);
}

function unwrapSingleContour(source: unknown): unknown {
	return Array.isArray(source) && source.length === 1 && Array.isArray(source[0]) ? source[0] : source;
}

function exactSource(actual: unknown[], wanted: unknown[]): boolean {
	return actual.length === wanted.length && actual.every((value, index) => value === wanted[index]);
}

function pathSegments(source: unknown[], implicitClosure: boolean): Segment[] | undefined {
	if (typeof source[0] !== 'number' || typeof source[1] !== 'number')
		return undefined;
	const first: Point = [source[0], source[1]];
	const edges: Segment[] = [];
	let current = first;
	let kind: SegmentKind = 'L';
	let index = 2;
	while (index < source.length) {
		if (typeof source[index] === 'string') {
			const command = source[index++];
			if (command !== 'L' && command !== 'ARC' && command !== 'CARC' && command !== 'C')
				return undefined;
			kind = command;
		}
		const count = kind === 'L' ? 2 : kind === 'C' ? 6 : 3;
		const values = source.slice(index, index + count);
		if (values.length !== count || !values.every(value => typeof value === 'number' && Number.isFinite(value)))
			return undefined;
		const numbers = values as number[];
		const end: Point = [numbers[count - 2], numbers[count - 1]];
		const edge: Segment = { kind, start: current, end };
		if (kind === 'ARC' || kind === 'CARC')
			edge.angle = numbers[0];
		else if (kind === 'C')
			edge.controls = [[numbers[0], numbers[1]], [numbers[2], numbers[3]]];
		edges.push(edge);
		current = end;
		index += count;
	}
	if (!edges.length)
		return undefined;
	// 区域按 Polygon 语义自动闭合；折线保留源数组中实际的边。
	if (implicitClosure && !nearPoint(current, first))
		edges.push({ kind: 'L', start: current, end: first });
	return edges;
}

function reversedSegment(edge: Segment): Segment {
	return {
		...edge,
		start: edge.end,
		end: edge.start,
		...(edge.angle === undefined ? {} : { angle: -edge.angle }),
		...(edge.controls === undefined ? {} : { controls: [edge.controls[1], edge.controls[0]] as [Point, Point] }),
	};
}

function sameSegment(actual: Segment, wanted: Segment): boolean {
	if (actual.kind !== wanted.kind || !nearPoint(actual.start, wanted.start) || !nearPoint(actual.end, wanted.end))
		return false;
	if (actual.angle !== undefined || wanted.angle !== undefined)
		return actual.angle !== undefined && wanted.angle !== undefined && Math.abs(actual.angle - wanted.angle) <= ANGLE_TOLERANCE;
	if (actual.controls !== undefined || wanted.controls !== undefined) {
		return actual.controls !== undefined && wanted.controls !== undefined
			&& nearPoint(actual.controls[0], wanted.controls[0]) && nearPoint(actual.controls[1], wanted.controls[1]);
	}
	return true;
}

function segmentPrecisionChanged(actual: Segment, wanted: Segment): boolean {
	const points = [[actual.start, wanted.start], [actual.end, wanted.end], ...(actual.controls && wanted.controls ? [[actual.controls[0], wanted.controls[0]], [actual.controls[1], wanted.controls[1]]] : [])];
	return points.some(([a, b]) => a[0] !== b[0] || a[1] !== b[1]) || actual.angle !== wanted.angle;
}

/** 比较原生边路径；区域自动闭合，折线仅在实际闭合时允许循环起点。 */
export function comparePcbPolygonSource(actualSource: unknown, wantedSource: unknown, mode: 'polygon' | 'polyline' = 'polygon'): PcbPolygonComparison {
	const actual = unwrapSingleContour(actualSource);
	const wanted = unwrapSingleContour(wantedSource);
	const result: PcbPolygonComparison = { equivalent: false, normalized: false, reversed: false, cyclicShift: 0, precisionAdjusted: false, coordinateToleranceMil: COORDINATE_TOLERANCE_MIL };
	if (!Array.isArray(actual) || !Array.isArray(wanted))
		return result;
	const wrapped = actual !== actualSource || wanted !== wantedSource;
	if (exactSource(actual, wanted))
		return { ...result, equivalent: true, normalized: wrapped };
	const actualEdges = pathSegments(actual, mode === 'polygon');
	const wantedEdges = pathSegments(wanted, mode === 'polygon');
	if (actualEdges && wantedEdges) {
		if (actualEdges.length !== wantedEdges.length)
			return result;
		const count = actualEdges.length;
		const closed = mode === 'polygon' || (nearPoint(actualEdges[0].start, actualEdges[count - 1].end)
			&& nearPoint(wantedEdges[0].start, wantedEdges[count - 1].end));
		for (const reversed of [false, true]) {
			for (let shift = 0; shift < (closed ? count : 1); shift++) {
				if (closed && !nearPoint(actualEdges[0].start, wantedEdges[shift].start))
					continue;
				const matched: Segment[] = actualEdges.map((_, index) => {
					const edge = wantedEdges[(shift + (reversed ? count - index - 1 : index)) % count];
					return reversed ? reversedSegment(edge) : edge;
				});
				if (actualEdges.every((edge, index) => sameSegment(edge, matched[index]))) {
					return { ...result, equivalent: true, normalized: true, reversed, cyclicShift: shift, precisionAdjusted: actualEdges.some((edge, index) => segmentPrecisionChanged(edge, matched[index])) };
				}
			}
		}
		return result;
	}
	// 参数化矩形/圆形保持原生命令语义；不将曲线离散成折线后比较。
	const parametric = actual[0] === wanted[0]
		&& ((actual[0] === 'R' && actual.length === 7) || (actual[0] === 'CIRCLE' && actual.length === 4));
	const equivalent = actual.length === wanted.length && actual.every((value, index) => {
		const expected = wanted[index];
		if (typeof value !== 'number' || typeof expected !== 'number')
			return value === expected;
		return parametric && !(actual[0] === 'R' && index === 5)
			? nearCoordinate(value, expected)
			: Math.abs(value - expected) <= ANGLE_TOLERANCE;
	});
	return { ...result, equivalent, normalized: equivalent, precisionAdjusted: equivalent && !exactSource(actual, wanted) };
}
