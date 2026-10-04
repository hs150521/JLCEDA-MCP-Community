// EDA Pro 3.2.181 的过孔孔径/外径按 0.1 mil 量化回读。
// 核对具体的截断/四舍五入结果，避免把任意 0.1 mil 偏差视为等价。
export function pcbViaDimensionMode(actual: unknown, requested: number): 'exact' | 'truncate_0_1_mil' | 'round_0_1_mil' | undefined {
	if (typeof actual !== 'number' || !Number.isFinite(actual))
		return undefined;
	if (Math.abs(actual - requested) <= 1e-6)
		return 'exact';
	if (actual <= 0)
		return undefined;
	if (Math.abs(actual - Math.floor(requested * 10 + 1e-8) / 10) <= 1e-6)
		return 'truncate_0_1_mil';
	if (Math.abs(actual - Math.round(requested * 10) / 10) <= 1e-6)
		return 'round_0_1_mil';
	return undefined;
}
