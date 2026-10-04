/**
 * ------------------------------------------------------------------------
 * 名称：桥接器件自动坐标放置任务处理
 * 说明：根据指定坐标或自动布局策略在原理图中放置器件。
 * 作者：Lion
 * 邮箱：chengbin@3578.cn
 * 日期：2026-07-03
 * 备注：仅处理 component/place-auto 任务。
 * ------------------------------------------------------------------------
 */

import type { DesignatorChange } from './component-designator-restore';
import { getEdaRuntime, getSyncState, isPlainObjectRecord, toSafeErrorMessage } from '../utils';
import { readSchematicDesignators, restoreChangedSchematicDesignators } from './component-designator-restore';
import { resolveSchematicLibraryComponent } from './schematic-library-component.ts';

interface ComponentPlaceAutoItem {
	uuid: string;
	libraryUuid: string;
	name?: string;
	subPartName?: string;
	x?: number;
	y?: number;
	rotation?: number;
	mirror?: boolean;
}

interface GridLayoutConfig {
	startX?: number;
	startY?: number;
	spacingX?: number;
	spacingY?: number;
	columns?: number;
}

interface LinearLayoutConfig {
	startX?: number;
	startY?: number;
	spacing?: number;
}

interface FixedPositionConfig {
	x?: number;
	y?: number;
}

interface ComponentCreateApi {
	context: unknown;
	getAll?: (componentType?: unknown, allSchematicPages?: boolean) => Promise<unknown[]>;
	modify?: (primitiveId: string, property: { designator: string; otherProperty: Record<string, string | number | boolean> }) => Promise<unknown>;
	create: (
		component: Record<string, unknown>,
		x: number,
		y: number,
		subPartName?: string,
		rotation?: number,
		mirror?: boolean,
		addIntoBom?: boolean,
		addIntoPcb?: boolean,
	) => Promise<unknown>;
}

const DEFAULT_GRID_START_X = 0;
const DEFAULT_GRID_START_Y = 0;
const DEFAULT_GRID_SPACING_X = 1500;
const DEFAULT_GRID_SPACING_Y = 1500;
const DEFAULT_GRID_COLUMNS = 4;

const DEFAULT_LINEAR_START_X = 0;
const DEFAULT_LINEAR_START_Y = 0;
const DEFAULT_LINEAR_SPACING = 1500;

const DEFAULT_FIXED_X = 0;
const DEFAULT_FIXED_Y = 0;

// 解析器件放置项参数。
function normalizeComponentPlaceAutoItem(raw: unknown, index: number): ComponentPlaceAutoItem {
	if (!isPlainObjectRecord(raw)) {
		throw new TypeError(`components[${String(index)}] 必须为对象。`);
	}

	const uuid = String(raw.uuid ?? '').trim();
	const libraryUuid = String(raw.libraryUuid ?? '').trim();
	if (uuid.length === 0) {
		throw new Error(`components[${String(index)}].uuid 不能为空。`);
	}
	if (libraryUuid.length === 0) {
		throw new Error(`components[${String(index)}].libraryUuid 不能为空。`);
	}

	const item: ComponentPlaceAutoItem = {
		uuid,
		libraryUuid,
		name: String(raw.name ?? '').trim(),
		subPartName: String(raw.subPartName ?? '').trim(),
	};

	if (raw.x !== undefined && raw.x !== null) {
		const x = Number(raw.x);
		if (!Number.isFinite(x)) {
			throw new TypeError(`components[${String(index)}].x 必须为数字。`);
		}
		item.x = x;
	}

	if (raw.y !== undefined && raw.y !== null) {
		const y = Number(raw.y);
		if (!Number.isFinite(y)) {
			throw new TypeError(`components[${String(index)}].y 必须为数字。`);
		}
		item.y = y;
	}

	if (raw.rotation !== undefined && raw.rotation !== null) {
		const rotation = Number(raw.rotation);
		if (!Number.isFinite(rotation)) {
			throw new TypeError(`components[${String(index)}].rotation 必须为数字。`);
		}
		if (![0, 90, 180, 270].includes(rotation)) {
			throw new Error(`components[${String(index)}].rotation 只能为 0、90、180、270。`);
		}
		item.rotation = rotation;
	}

	if (raw.mirror !== undefined && raw.mirror !== null) {
		item.mirror = Boolean(raw.mirror);
	}

	return item;
}

// 解析网格布局配置。
function parseGridLayoutConfig(raw: unknown): GridLayoutConfig {
	if (!isPlainObjectRecord(raw)) {
		return {};
	}

	const config: GridLayoutConfig = {};

	if (raw.startX !== undefined && raw.startX !== null) {
		const startX = Number(raw.startX);
		if (Number.isFinite(startX)) {
			config.startX = startX;
		}
	}

	if (raw.startY !== undefined && raw.startY !== null) {
		const startY = Number(raw.startY);
		if (Number.isFinite(startY)) {
			config.startY = startY;
		}
	}

	if (raw.spacingX !== undefined && raw.spacingX !== null) {
		const spacingX = Number(raw.spacingX);
		if (Number.isFinite(spacingX)) {
			config.spacingX = spacingX;
		}
	}

	if (raw.spacingY !== undefined && raw.spacingY !== null) {
		const spacingY = Number(raw.spacingY);
		if (Number.isFinite(spacingY)) {
			config.spacingY = spacingY;
		}
	}

	if (raw.columns !== undefined && raw.columns !== null) {
		const columns = Number(raw.columns);
		if (Number.isFinite(columns) && Number.isInteger(columns) && columns > 0) {
			config.columns = columns;
		}
	}

	return config;
}

// 解析线性布局配置。
function parseLinearLayoutConfig(raw: unknown): LinearLayoutConfig {
	if (!isPlainObjectRecord(raw)) {
		return {};
	}

	const config: LinearLayoutConfig = {};

	if (raw.startX !== undefined && raw.startX !== null) {
		const startX = Number(raw.startX);
		if (Number.isFinite(startX)) {
			config.startX = startX;
		}
	}

	if (raw.startY !== undefined && raw.startY !== null) {
		const startY = Number(raw.startY);
		if (Number.isFinite(startY)) {
			config.startY = startY;
		}
	}

	if (raw.spacing !== undefined && raw.spacing !== null) {
		const spacing = Number(raw.spacing);
		if (Number.isFinite(spacing)) {
			config.spacing = spacing;
		}
	}

	return config;
}

// 解析固定位置配置。
function parseFixedPositionConfig(raw: unknown): FixedPositionConfig {
	if (!isPlainObjectRecord(raw)) {
		return {};
	}

	const config: FixedPositionConfig = {};

	if (raw.x !== undefined && raw.x !== null) {
		const x = Number(raw.x);
		if (Number.isFinite(x)) {
			config.x = x;
		}
	}

	if (raw.y !== undefined && raw.y !== null) {
		const y = Number(raw.y);
		if (Number.isFinite(y)) {
			config.y = y;
		}
	}

	return config;
}

// 计算器件的放置坐标。
function calculateComponentPosition(
	index: number,
	component: ComponentPlaceAutoItem,
	layoutStrategy: string,
	gridConfig: GridLayoutConfig,
	linearConfig: LinearLayoutConfig,
	fixedConfig: FixedPositionConfig,
): { x: number; y: number } {
	// Compute the strategy position first, then preserve each independently
	// supplied axis below. This keeps partial coordinate requests deterministic.
	let layoutPosition: { x: number; y: number };

	if (layoutStrategy === 'grid') {
		const startX = gridConfig.startX ?? DEFAULT_GRID_START_X;
		const startY = gridConfig.startY ?? DEFAULT_GRID_START_Y;
		const spacingX = gridConfig.spacingX ?? DEFAULT_GRID_SPACING_X;
		const spacingY = gridConfig.spacingY ?? DEFAULT_GRID_SPACING_Y;
		const columns = gridConfig.columns ?? DEFAULT_GRID_COLUMNS;

		const row = Math.floor(index / columns);
		const col = index % columns;

		layoutPosition = {
			x: startX + col * spacingX,
			y: startY + row * spacingY,
		};
	}
	else if (layoutStrategy === 'horizontal') {
		const startX = linearConfig.startX ?? DEFAULT_LINEAR_START_X;
		const startY = linearConfig.startY ?? DEFAULT_LINEAR_START_Y;
		const spacing = linearConfig.spacing ?? DEFAULT_LINEAR_SPACING;

		layoutPosition = {
			x: startX + index * spacing,
			y: startY,
		};
	}
	else if (layoutStrategy === 'vertical') {
		const startX = linearConfig.startX ?? DEFAULT_LINEAR_START_X;
		const startY = linearConfig.startY ?? DEFAULT_LINEAR_START_Y;
		const spacing = linearConfig.spacing ?? DEFAULT_LINEAR_SPACING;

		layoutPosition = {
			x: startX,
			y: startY + index * spacing,
		};
	}
	else if (layoutStrategy === 'fixed') {
		const x = fixedConfig.x ?? DEFAULT_FIXED_X;
		const y = fixedConfig.y ?? DEFAULT_FIXED_Y;

		layoutPosition = { x, y };
	}
	else {
		// 默认使用网格布局。
		const row = Math.floor(index / DEFAULT_GRID_COLUMNS);
		const col = index % DEFAULT_GRID_COLUMNS;
		layoutPosition = {
			x: DEFAULT_GRID_START_X + col * DEFAULT_GRID_SPACING_X,
			y: DEFAULT_GRID_START_Y + row * DEFAULT_GRID_SPACING_Y,
		};
	}

	return {
		x: component.x ?? layoutPosition.x,
		y: component.y ?? layoutPosition.y,
	};
}

// 解析 EDA API。
function resolveComponentCreateApi(): ComponentCreateApi {
	// 直接访问 eda 全局对象，与其他handler保持一致
	if (typeof eda === 'undefined' || !eda || typeof eda !== 'object') {
		throw new Error('EDA 环境未就绪，无法访问 eda 全局对象。');
	}

	const componentModule = eda.sch_PrimitiveComponent;
	if (!componentModule || typeof componentModule.create !== 'function') {
		throw new Error('未找到 eda.sch_PrimitiveComponent.create API。');
	}

	return {
		context: componentModule,
		getAll: typeof componentModule.getAll === 'function' ? componentModule.getAll as ComponentCreateApi['getAll'] : undefined,
		modify: typeof componentModule.modify === 'function' ? componentModule.modify as ComponentCreateApi['modify'] : undefined,
		create: componentModule.create as ComponentCreateApi['create'],
	};
}

function isUnknownCreateResult(errorMessage: string): boolean {
	return /timed?\s*out|ETIMEDOUT|disconnect|connection\s+(?:closed|lost|reset|aborted)|socket\s+(?:closed|hang up)|transport\s+(?:closed|lost)|websocket.*(?:closed|not open)|ECONNRESET|ECONNABORTED|EPIPE/i.test(errorMessage);
}

async function currentSchematicPageUuid(): Promise<string> {
	const schematic = getEdaRuntime()?.dmt_Schematic;
	if (!isPlainObjectRecord(schematic) || typeof schematic.getCurrentSchematicPageInfo !== 'function')
		throw new Error('无法读取当前原理图图页身份。');
	const page = await Promise.resolve((schematic.getCurrentSchematicPageInfo as () => Promise<unknown>).call(schematic));
	const pageUuid = isPlainObjectRecord(page) && typeof page.uuid === 'string' ? page.uuid.trim() : '';
	if (!pageUuid)
		throw new Error('当前未打开原理图图页。');
	return pageUuid;
}

async function assertSchematicPageUuid(expected: string): Promise<void> {
	if (await currentSchematicPageUuid() !== expected)
		throw new Error('原理图图页已切换，本批次已停止。');
}

/**
 * 处理器件自动坐标放置任务。
 * @param payload 任务参数。
 * @returns 放置结果。
 */
export async function handleComponentPlaceAutoTask(payload: unknown): Promise<unknown> {
	if (!isPlainObjectRecord(payload)) {
		throw new TypeError('component/place-auto 任务参数必须为对象。');
	}

	const rawComponents = payload.components;
	if (!Array.isArray(rawComponents)) {
		throw new TypeError('缺少 components 参数，且其必须为数组。');
	}
	if (rawComponents.length < 1) {
		throw new Error('components 不能为空，至少需要提供一个待放置器件。');
	}
	if (rawComponents.length > 100) {
		throw new Error('components 数量过多，单次最多允许 100 个器件。');
	}

	const layoutStrategy = String(payload.layoutStrategy ?? 'grid').trim().toLowerCase();
	if (!['grid', 'horizontal', 'vertical', 'fixed'].includes(layoutStrategy)) {
		throw new Error('layoutStrategy 只能为 grid、horizontal、vertical、fixed。');
	}

	const gridConfig = parseGridLayoutConfig(payload.gridLayout);
	const linearConfig = parseLinearLayoutConfig(payload.linearLayout);
	const fixedConfig = parseFixedPositionConfig(payload.fixedPosition);

	const components = rawComponents.map((item: unknown, index: number) =>
		normalizeComponentPlaceAutoItem(item, index),
	);

	const resolvedComponents: Array<{ component: Record<string, unknown>; subPartName?: string }> = [];
	for (const [index, component] of components.entries()) {
		const resolved = await resolveSchematicLibraryComponent({ uuid: component.uuid, libraryUuid: component.libraryUuid }, component.subPartName);
		if (resolved.ok === false) {
			return {
				...resolved,
				needsReview: false,
				placedCount: 0,
				failedCount: 1,
				totalCount: components.length,
				notAttemptedCount: components.length - 1,
				placedComponents: [],
				failedComponents: [{ index, uuid: component.uuid, libraryUuid: component.libraryUuid, errorCode: resolved.errorCode, error: resolved.error, applied: false }],
				designatorChanges: [],
				restoredDesignators: [],
			};
		}
		resolvedComponents.push(resolved);
	}
	const api = resolveComponentCreateApi();
	let trackedDesignators: Map<string, string>;
	let pageUuid: string;
	let annotationWarning: string | undefined;
	let creationWarning: string | undefined;
	let pageWarning: string | undefined;
	try {
		pageUuid = await currentSchematicPageUuid();
		trackedDesignators = await readSchematicDesignators(api);
		await assertSchematicPageUuid(pageUuid);
	}
	catch (error: unknown) {
		return {
			ok: false,
			needsReview: true,
			placedCount: 0,
			failedCount: 0,
			totalCount: components.length,
			notAttemptedCount: components.length,
			placedComponents: [],
			failedComponents: [],
			designatorChanges: [],
			restoredDesignators: [],
			annotationWarning: `放置前无法核对当前图页或已有器件位号：${toSafeErrorMessage(error)}`,
			message: '无法核对当前图页或已有器件位号，本次未开始放置。',
		};
	}
	const placedComponents: Array<{ uuid: string; libraryUuid: string; x: number; y: number; primitiveId: string; designator: string }> = [];
	const failedComponents: Array<{ uuid: string; libraryUuid: string; error: string }> = [];
	let designatorChanges: DesignatorChange[] = [];
	const restoredDesignators: DesignatorChange[] = [];
	let commitUnknown = false;
	let nativeCallSettled = true;

	for (let index = 0; index < components.length; index += 1) {
		const component = components[index];
		try {
			await assertSchematicPageUuid(pageUuid);
		}
		catch (error: unknown) {
			pageWarning = `放置前无法确认原理图图页身份：${toSafeErrorMessage(error)}`;
			break;
		}
		const position = calculateComponentPosition(
			index,
			component,
			layoutStrategy,
			gridConfig,
			linearConfig,
			fixedConfig,
		);

		try {
			const createdComponent = await Promise.resolve(
				api.create.call(
					api.context,
					resolvedComponents[index].component,
					position.x,
					position.y,
					resolvedComponents[index].subPartName,
					component.rotation ?? 0,
					component.mirror ?? false,
					true,
					true,
				),
			);
			if (createdComponent === undefined || createdComponent === null) {
				commitUnknown = true;
				nativeCallSettled = true;
				creationWarning = 'EDA 创建调用已返回，但没有新器件对象，无法核对创建结果。';
				failedComponents.push({ uuid: component.uuid, libraryUuid: component.libraryUuid, error: creationWarning });
				break;
			}
			const primitiveId = getSyncState<string>(createdComponent, 'getState_PrimitiveId', '').trim();
			if (!primitiveId) {
				commitUnknown = true;
				nativeCallSettled = true;
				creationWarning = 'EDA 返回的新器件缺少图元 ID，无法核对创建结果。';
				failedComponents.push({ uuid: component.uuid, libraryUuid: component.libraryUuid, error: creationWarning });
				break;
			}
			placedComponents.push({
				uuid: component.uuid,
				libraryUuid: component.libraryUuid,
				x: position.x,
				y: position.y,
				primitiveId,
				designator: getSyncState(createdComponent, 'getState_Designator', ''),
			});
		}
		catch (error: unknown) {
			const errorMessage = toSafeErrorMessage(error);
			failedComponents.push({
				uuid: component.uuid,
				libraryUuid: component.libraryUuid,
				error: errorMessage,
			});
			if (isUnknownCreateResult(errorMessage)) {
				commitUnknown = true;
				nativeCallSettled = false;
				creationWarning = `器件创建结果未知，EDA 可能仍在完成放置：${errorMessage}`;
				break;
			}
			continue;
		}

		try {
			// Track the starting page and every earlier placement in this batch.
			// A later create may renumber an earlier new component too.
			const restored = await restoreChangedSchematicDesignators(api, trackedDesignators, () => assertSchematicPageUuid(pageUuid));
			await assertSchematicPageUuid(pageUuid);
			designatorChanges = restored.designatorChanges;
			restoredDesignators.push(...restored.restoredDesignators);
			const currentDesignators = restored.currentDesignators;
			const latest = placedComponents[placedComponents.length - 1];
			if (!currentDesignators.has(latest.primitiveId)) {
				placedComponents.pop();
				commitUnknown = true;
				nativeCallSettled = restored.nativeCallSettled !== false;
				creationWarning = `EDA 返回的器件图元 ${latest.primitiveId} 不在当前原理图图页中，创建结果需要核对。`;
				failedComponents.push({ uuid: component.uuid, libraryUuid: component.libraryUuid, error: creationWarning });
				annotationWarning = restored.annotationWarning;
				break;
			}
			for (const placed of placedComponents) {
				const currentDesignator = currentDesignators.get(placed.primitiveId);
				if (currentDesignator !== undefined)
					placed.designator = currentDesignator;
			}
			if (restored.annotationWarning) {
				annotationWarning = restored.annotationWarning;
				commitUnknown = restored.commitUnknown === true;
				nativeCallSettled = restored.nativeCallSettled !== false;
				break;
			}
			if (latest.primitiveId)
				trackedDesignators.set(latest.primitiveId, latest.designator);
		}
		catch (error: unknown) {
			placedComponents.pop();
			commitUnknown = true;
			nativeCallSettled = true;
			creationWarning = `器件创建已返回，但当前图页回读失败，无法核对创建结果：${toSafeErrorMessage(error)}`;
			failedComponents.push({ uuid: component.uuid, libraryUuid: component.libraryUuid, error: creationWarning });
			break;
		}
	}
	const notAttemptedCount = components.length - placedComponents.length - failedComponents.length;

	if (failedComponents.length > 0 || annotationWarning || creationWarning || pageWarning) {
		return {
			ok: false,
			needsReview: Boolean(annotationWarning || creationWarning || pageWarning),
			placedCount: placedComponents.length,
			failedCount: failedComponents.length,
			totalCount: components.length,
			notAttemptedCount,
			placedComponents,
			failedComponents,
			designatorChanges,
			restoredDesignators,
			annotationWarning,
			...(creationWarning ? { creationWarning } : {}),
			...(pageWarning ? { pageWarning } : {}),
			...(commitUnknown ? { commitUnknown: true, readbackRequired: true, nativeCallSettled } : {}),
			message: creationWarning
				? `器件创建结果未知；已确认放置 ${String(placedComponents.length)} 个，${String(notAttemptedCount)} 个未尝试。请先回读当前原理图。`
				: pageWarning
					? `原理图图页身份无法确认；已确认放置 ${String(placedComponents.length)} 个，${String(notAttemptedCount)} 个未尝试。`
					: annotationWarning
						? `放置了 ${String(placedComponents.length)} 个器件，${String(notAttemptedCount)} 个未尝试；器件位号需核对。`
						: `放置了 ${String(placedComponents.length)} 个器件，${String(failedComponents.length)} 个失败。`,
		};
	}

	return {
		ok: true,
		needsReview: false,
		placedCount: placedComponents.length,
		totalCount: components.length,
		notAttemptedCount: 0,
		placedComponents,
		designatorChanges,
		restoredDesignators,
		annotationWarning,
		message: `成功放置了全部 ${String(components.length)} 个器件。`,
	};
}
