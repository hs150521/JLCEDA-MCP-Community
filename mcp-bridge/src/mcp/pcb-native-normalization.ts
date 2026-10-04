// EDA Pro 3.2.181 实机创建/修改回读：15.748→15.8、19.685→19.6，
// 二次采样 15.7→15.8、19.73→19.8，均为直径按 0.2 mil 取最近格点。
// 官方 API 未声明量化公式；这里只接受实测的唯一结果，不放宽为误差区间。
export function pcbViaDimensionMode(actual: unknown, requested: number): 'exact' | 'round_0_2_mil' | undefined {
	if (typeof actual !== 'number' || !Number.isFinite(actual))
		return undefined;
	if (Math.abs(actual - requested) <= 1e-6)
		return 'exact';
	if (actual > 0 && Math.abs(actual - Math.round(requested * 5) / 5) <= 1e-6)
		return 'round_0_2_mil';
	return undefined;
}

export function pcbViaDimensionNormalization(actual: Record<string, unknown>, requested: Record<string, unknown>): Record<string, unknown> {
	const dimensions: Record<string, unknown> = {};
	let normalized = false;
	for (const field of ['holeDiameter', 'diameter']) {
		if (typeof requested[field] !== 'number')
			continue;
		const mode = pcbViaDimensionMode(actual[field], requested[field]);
		if (mode === undefined)
			continue;
		dimensions[field] = { requested: requested[field], actual: actual[field], mode };
		normalized ||= mode !== 'exact';
	}
	return normalized ? { normalization: { kind: 'via_dimension_quantization', ...dimensions } } : {};
}
