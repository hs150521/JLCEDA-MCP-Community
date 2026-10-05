/** 原生 Wire.line 按实际 LINE 记录存放独立端点对；创建入参仍是连续路径。 */
export type NativeWireSegment = [number, number, number, number];

export function readNativeWireSegments(value: unknown): NativeWireSegment[] | null {
	if (!Array.isArray(value) || value.length === 0)
		return null;
	const coordinates: unknown[] = Array.isArray(value[0]) ? value.flat() : value;
	if (coordinates.length < 4 || coordinates.length % 4 !== 0
		|| coordinates.some(coordinate => typeof coordinate !== 'number' || !Number.isFinite(coordinate))) {
		return null;
	}
	const segments: NativeWireSegment[] = [];
	for (let index = 0; index < coordinates.length; index += 4)
		segments.push(coordinates.slice(index, index + 4) as NativeWireSegment);
	return segments;
}
