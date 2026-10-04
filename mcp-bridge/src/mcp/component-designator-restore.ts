import { getSyncState, isPlainObjectRecord, toSafeErrorMessage } from '../utils';

export interface DesignatorChange {
	primitiveId: string;
	before: string;
	after: string;
}

export interface DesignatorApi {
	context: unknown;
	getAll?: (componentType?: unknown, allSchematicPages?: boolean) => Promise<unknown[]>;
	modify?: (primitiveId: string, property: { designator: string; otherProperty: Record<string, string | number | boolean> }) => Promise<unknown>;
}

interface ComponentState {
	designator: string;
	primitive: unknown;
}

interface DesignatorSnapshot {
	states: Map<string, ComponentState>;
	designators: Map<string, string>;
}

export interface DesignatorRestoreResult {
	currentDesignators: Map<string, string>;
	designatorChanges: DesignatorChange[];
	restoredDesignators: DesignatorChange[];
	annotationWarning?: string;
	commitUnknown?: boolean;
	nativeCallSettled?: boolean;
}

async function readSnapshot(api: DesignatorApi): Promise<DesignatorSnapshot> {
	if (!api.getAll)
		throw new TypeError('sch_PrimitiveComponent.getAll API 不可用。');
	const components = await Promise.resolve(api.getAll.call(api.context, null, false));
	if (!Array.isArray(components))
		throw new TypeError('sch_PrimitiveComponent.getAll 未返回器件列表。');
	const states = new Map<string, ComponentState>();
	const designators = new Map<string, string>();
	for (const component of components) {
		const id = getSyncState(component, 'getState_PrimitiveId', '');
		const designator = getSyncState(component, 'getState_Designator', '');
		if (!id)
			continue;
		states.set(id, {
			designator,
			primitive: component,
		});
		designators.set(id, designator);
	}
	return { states, designators };
}

function changedDesignators(baseline: Map<string, string>, current: Map<string, string>): DesignatorChange[] {
	return [...baseline]
		.filter(([id, before]) => current.has(id) && current.get(id) !== before)
		.map(([primitiveId, before]) => ({ primitiveId, before, after: current.get(primitiveId)! }));
}

function sameProperties(a: Record<string, unknown>, b: unknown): boolean {
	if (!isPlainObjectRecord(b))
		return false;
	const keys = Object.keys(a);
	return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && a[key] === b[key]);
}

function readOtherProperty(component: unknown): Record<string, string | number | boolean> | null {
	const getter = (component as Record<string, unknown> | undefined)?.getState_OtherProperty;
	if (typeof getter !== 'function')
		return null;
	try {
		const value = getter.call(component) as unknown;
		if (value === undefined)
			return {};
		return isPlainObjectRecord(value) ? { ...value } as Record<string, string | number | boolean> : null;
	}
	catch {
		return null;
	}
}

/** Read current-page designators before starting a placement. */
export async function readSchematicDesignators(api: DesignatorApi): Promise<Map<string, string>> {
	return (await readSchematicComponentBaseline(api)).designators;
}

/** Read one current-page component snapshot for placement ID and designator baselines. */
export async function readSchematicComponentBaseline(api: DesignatorApi): Promise<{ primitiveIds: Set<string>; designators: Map<string, string> }> {
	const snapshot = await readSnapshot(api);
	return {
		primitiveIds: new Set(snapshot.states.keys()),
		designators: new Map([...snapshot.designators].filter(([, designator]) => designator)),
	};
}

/** Restore only existing components renumbered by one placement, then read back the page. */
export async function restoreChangedSchematicDesignators(
	api: DesignatorApi,
	baseline: Map<string, string>,
	assertPage?: () => Promise<void>,
	beforeNativeMutation?: () => void,
): Promise<DesignatorRestoreResult> {
	const snapshot = await readSnapshot(api);
	const changes = changedDesignators(baseline, snapshot.designators);
	const initial = {
		currentDesignators: snapshot.designators,
		designatorChanges: changes,
		restoredDesignators: [] as DesignatorChange[],
	};
	if (changes.length === 0)
		return initial;
	if (!api.modify)
		return { ...initial, annotationWarning: 'EDA 改变了已有器件位号，但当前版本没有可用的器件修改 API。' };

	const preservedProperties = new Map<string, Record<string, string | number | boolean>>();
	for (const change of changes) {
		const state = snapshot.states.get(change.primitiveId)!;
		const componentType = getSyncState<string>(state.primitive, 'getState_ComponentType', '');
		const otherProperty = readOtherProperty(state.primitive);
		if (componentType !== 'part' || !otherProperty) {
			return { ...initial, annotationWarning: `器件 ${change.primitiveId} 的类型或 BOM 属性无法核实，未自动恢复位号。` };
		}
		const occupied = [...snapshot.states].some(([id, other]) => id !== change.primitiveId
			&& other.designator === change.before && baseline.get(id) !== change.before);
		if (occupied)
			return { ...initial, annotationWarning: `原位号 ${change.before} 已被其它器件占用，未自动恢复位号。` };
		preservedProperties.set(change.primitiveId, otherProperty);
	}

	let attempted = false;
	let nativeCallInFlight = false;
	try {
		for (const change of changes) {
			await assertPage?.();
			beforeNativeMutation?.();
			attempted = true;
			nativeCallInFlight = true;
			await Promise.resolve(api.modify.call(api.context, change.primitiveId, {
				designator: change.before,
				otherProperty: { ...preservedProperties.get(change.primitiveId)! },
			}));
			nativeCallInFlight = false;
		}
		await assertPage?.();
		const verified = await readSnapshot(api);
		await assertPage?.();
		const designatorChanges = changedDesignators(baseline, verified.designators);
		const restoredDesignators = changes
			.filter(change => verified.designators.get(change.primitiveId) === change.before)
			.map(change => ({ primitiveId: change.primitiveId, before: change.after, after: change.before }));
		const propertiesChanged = changes.some(change => !sameProperties(
			preservedProperties.get(change.primitiveId)!,
			readOtherProperty(verified.states.get(change.primitiveId)?.primitive),
		));
		return {
			currentDesignators: verified.designators,
			designatorChanges,
			restoredDesignators,
			...(designatorChanges.length > 0 || propertiesChanged
				? { annotationWarning: 'EDA 位号恢复后的全页核对未通过；请核对位号和 BOM 属性。' }
				: {}),
		};
	}
	catch (error: unknown) {
		return {
			...initial,
			annotationWarning: `位号恢复或回读失败：${toSafeErrorMessage(error)}`,
			...(attempted ? { commitUnknown: true, nativeCallSettled: !nativeCallInFlight } : {}),
		};
	}
}
