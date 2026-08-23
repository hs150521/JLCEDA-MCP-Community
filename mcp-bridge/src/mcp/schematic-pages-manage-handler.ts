import { getEdaRuntime, isPlainObjectRecord, preserveBoundedArray, toSerializableAsync } from '../utils.ts';

type SchematicPagesOperation = 'create' | 'copy' | 'rename' | 'reorder';

type SchematicApi = Record<string, unknown>;
type SchematicPage = Record<string, unknown>;
type SchematicMethod = (...args: unknown[]) => Promise<unknown>;

const MAX_PAGES = 500;
const PAGE_MUTATION_SYNC_DELAY_MS = 1_500;

function requiredString(input: Record<string, unknown>, key: string): string {
	const value = input[key];
	if (typeof value !== 'string' || value.trim().length === 0)
		throw new TypeError(`${key} is required and must be a non-empty string.`);
	return value.trim();
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
	if (input[key] === undefined)
		return undefined;
	return requiredString(input, key);
}

function parseOperation(value: unknown): SchematicPagesOperation {
	if (value !== 'create' && value !== 'copy' && value !== 'rename' && value !== 'reorder')
		throw new TypeError('operation must be create, copy, rename, or reorder.');
	return value;
}

function rejectUnexpectedFields(input: Record<string, unknown>, allowed: readonly string[]): void {
	const allowedFields = new Set(['operation', 'confirm', ...allowed]);
	for (const key of Object.keys(input)) {
		if (!allowedFields.has(key))
			throw new TypeError(`${key} is not supported for this schematic page operation.`);
	}
}

function getSchematicApi(): SchematicApi {
	const eda = getEdaRuntime();
	const api = eda?.dmt_Schematic;
	if (!isPlainObjectRecord(api))
		throw new TypeError('EDA dmt_Schematic API is unavailable in this client version.');
	return api;
}

function getMethod(api: SchematicApi, name: string): SchematicMethod {
	if (typeof api[name] !== 'function')
		throw new TypeError(`EDA dmt_Schematic.${name} API is unavailable in this client version.`);
	return api[name] as SchematicMethod;
}

async function getPagesForSchematic(api: SchematicApi, schematicUuid: string): Promise<SchematicPage[]> {
	const allPages = await getMethod(api, 'getAllSchematicPagesInfo').call(api);
	if (!Array.isArray(allPages))
		throw new TypeError('EDA dmt_Schematic.getAllSchematicPagesInfo returned an invalid result.');
	const pages = allPages.filter((page): page is SchematicPage => isPlainObjectRecord(page) && page.parentSchematicUuid === schematicUuid);
	return pages;
}

async function getPageByUuid(api: SchematicApi, schematicPageUuid: string): Promise<SchematicPage> {
	const allPages = await getMethod(api, 'getAllSchematicPagesInfo').call(api);
	if (!Array.isArray(allPages))
		throw new TypeError('EDA dmt_Schematic.getAllSchematicPagesInfo returned an invalid result.');
	const page = allPages.find((item): item is SchematicPage => isPlainObjectRecord(item) && item.uuid === schematicPageUuid);
	if (!page)
		throw new TypeError('schematicPageUuid does not identify an existing schematic page.');
	if (typeof page.parentSchematicUuid !== 'string' || page.parentSchematicUuid.trim().length === 0)
		throw new TypeError('EDA returned a schematic page without a valid parentSchematicUuid.');
	return page;
}

function parseOrderedPageUuids(value: unknown): string[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PAGES)
		throw new RangeError(`orderedPageUuids must contain between 1 and ${String(MAX_PAGES)} page UUIDs.`);
	const uuids = value.map((item, index) => {
		if (typeof item !== 'string' || item.trim().length === 0)
			throw new TypeError(`orderedPageUuids[${String(index)}] must be a non-empty string.`);
		return item.trim();
	});
	if (new Set(uuids).size !== uuids.length)
		throw new TypeError('orderedPageUuids must not contain duplicates.');
	return uuids;
}

function orderPages(currentPages: SchematicPage[], orderedPageUuids: string[]): SchematicPage[] {
	const pageByUuid = new Map<string, SchematicPage>();
	for (const page of currentPages) {
		if (typeof page.uuid !== 'string' || page.uuid.trim().length === 0)
			throw new TypeError('EDA returned a schematic page without a valid uuid.');
		const uuid = page.uuid.trim();
		if (pageByUuid.has(uuid))
			throw new TypeError('EDA returned duplicate schematic page UUIDs.');
		pageByUuid.set(uuid, page);
	}
	if (orderedPageUuids.length !== pageByUuid.size)
		throw new TypeError('orderedPageUuids must include every page in the target schematic exactly once.');
	const orderedPages = orderedPageUuids.map(uuid => pageByUuid.get(uuid));
	if (orderedPages.includes(undefined))
		throw new TypeError('orderedPageUuids contains a page outside the target schematic.');
	return orderedPages as SchematicPage[];
}

async function boundedReadback(api: SchematicApi, schematicUuid: string): Promise<{ total: number; returned: number; truncated: boolean; pages: unknown[]; pageUuids: string[] }> {
	const pages = await getPagesForSchematic(api, schematicUuid);
	const boundedPages = pages.slice(0, MAX_PAGES);
	const serializablePages = preserveBoundedArray(await Promise.all(boundedPages.map(page => toSerializableAsync(page))));
	return {
		total: pages.length,
		returned: boundedPages.length,
		truncated: pages.length > boundedPages.length,
		pages: serializablePages,
		pageUuids: boundedPages.map(page => typeof page.uuid === 'string' ? page.uuid : ''),
	};
}

async function waitForPageMutationSync(): Promise<void> {
	// The official API examples wait for the asynchronous page inventory refresh.
	await new Promise<void>(resolve => globalThis.setTimeout(resolve, PAGE_MUTATION_SYNC_DELAY_MS));
}

export async function handleSchematicPagesManageTask(payload: unknown): Promise<unknown> {
	if (!isPlainObjectRecord(payload))
		throw new TypeError('schematic_pages_manage payload must be an object.');
	if (payload.confirm !== true)
		throw new TypeError('confirm must be true before modifying schematic pages.');
	const operation = parseOperation(payload.operation);
	const api = getSchematicApi();

	if (operation === 'create') {
		rejectUnexpectedFields(payload, ['schematicUuid']);
		const schematicUuid = requiredString(payload, 'schematicUuid');
		const pageUuid = await getMethod(api, 'createSchematicPage').call(api, schematicUuid);
		return {
			ok: typeof pageUuid === 'string' && pageUuid.length > 0,
			operation,
			schematicUuid,
			pageUuid,
			readback: await waitForPageMutationSync().then(() => boundedReadback(api, schematicUuid)),
		};
	}

	if (operation === 'copy') {
		rejectUnexpectedFields(payload, ['sourcePageUuid', 'schematicUuid']);
		const sourcePageUuid = requiredString(payload, 'sourcePageUuid');
		const sourcePage = await getPageByUuid(api, sourcePageUuid);
		const schematicUuid = optionalString(payload, 'schematicUuid') ?? sourcePage.parentSchematicUuid as string;
		const pageUuid = await getMethod(api, 'copySchematicPage').call(api, sourcePageUuid, schematicUuid);
		return {
			ok: typeof pageUuid === 'string' && pageUuid.length > 0,
			operation,
			sourcePageUuid,
			schematicUuid,
			pageUuid,
			readback: await waitForPageMutationSync().then(() => boundedReadback(api, schematicUuid)),
		};
	}

	if (operation === 'rename') {
		rejectUnexpectedFields(payload, ['schematicPageUuid', 'newName']);
		const schematicPageUuid = requiredString(payload, 'schematicPageUuid');
		const newName = requiredString(payload, 'newName');
		const page = await getPageByUuid(api, schematicPageUuid);
		const schematicUuid = page.parentSchematicUuid as string;
		const changed = await getMethod(api, 'modifySchematicPageName').call(api, schematicPageUuid, newName);
		return { ok: changed === true, operation, schematicUuid, schematicPageUuid, newName, changed, readback: await waitForPageMutationSync().then(() => boundedReadback(api, schematicUuid)) };
	}

	rejectUnexpectedFields(payload, ['schematicUuid', 'orderedPageUuids']);
	const schematicUuid = requiredString(payload, 'schematicUuid');
	const orderedPageUuids = parseOrderedPageUuids(payload.orderedPageUuids);
	const currentPages = await getPagesForSchematic(api, schematicUuid);
	if (currentPages.length > MAX_PAGES)
		throw new RangeError(`schematicUuid has more than ${String(MAX_PAGES)} pages; page reordering is refused.`);
	const orderedPages = orderPages(currentPages, orderedPageUuids);
	const changed = await getMethod(api, 'reorderSchematicPages').call(api, schematicUuid, orderedPages);
	await waitForPageMutationSync();
	const readback = await boundedReadback(api, schematicUuid);
	const verified = readback.pageUuids.length === orderedPageUuids.length
		&& readback.pageUuids.every((uuid, index) => uuid === orderedPageUuids[index]);
	return {
		ok: changed === true && verified,
		operation,
		schematicUuid,
		orderedPageUuids,
		changed,
		readback: {
			...readback,
			verified,
		},
	};
}
